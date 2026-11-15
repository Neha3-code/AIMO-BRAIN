import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { checkAimoGuardrail } from "../src/guardrail.js";
import { buildPriceAvailabilityEnvelope } from "../src/trustEnvelope.js";
import { listMigrationFiles, runMigrations, splitStatements } from "../src/migrations.js";
import { DEMO_KEYS, call, createTestContext, type TestContext } from "./helpers.js";

// Baseline for behaviour that already existed in the Junction26 demo, so later phases cannot
// regress it unnoticed. Quote and product routes need the live sandbox upstream and are covered
// by `npm run demo`, not here.

describe("sandbox / production boundary", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("defaults to sandbox with the organizations feature off", () => {
    const c = loadConfig(base);
    assert.equal(c.environment, "sandbox");
    assert.equal(c.features.organizations, false);
    assert.equal(c.warnings.length, 2, "missing upstream key and buyer keys are warnings, not failures");
  });

  it("refuses to start as production", () => {
    assert.throws(() => loadConfig({ ...base, AIMO_ENV: "production" }), /not available in this build/);
  });

  it("refuses unknown environments and a missing database", () => {
    assert.throws(() => loadConfig({ ...base, AIMO_ENV: "prod" }), /AIMO_ENV/);
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });
});

describe("supplier-side guardrail (demo)", () => {
  const buyer = { credit_limit_eur: 5000, aimo_side_auto_approve_limit_eur: 2000 };

  it("auto-approves at or below the ceiling", () => {
    assert.equal(checkAimoGuardrail({ totalEur: 2000, buyer }).requiresApproval, false);
  });
  it("holds above the auto-approval ceiling", () => {
    const r = checkAimoGuardrail({ totalEur: 2000.01, buyer });
    assert.equal(r.requiresApproval, true);
    assert.match(r.reason!, /auto-approval ceiling/);
  });
  it("holds above the credit limit", () => {
    assert.match(checkAimoGuardrail({ totalEur: 8407.2, buyer }).reason!, /credit limit/);
  });
});

describe("trust envelope (demo)", () => {
  const price = { productId: "1", quantity: 1, catalogPrice: { value: 1, valueWithTax: 1.86, currency: "EUR" }, comparisonPrice: null, comparisonUnit: null, netPriceFound: true, error: false };
  const line = (amount: number) => ({ salesBlock: false, availableAmount: amount, availableDate: "2026-11-16", salesUnit: "ST" });

  it("reports unknown availability as unknown, never as in stock or zero", () => {
    const e = buildPriceAvailabilityEnvelope("1", price, undefined);
    assert.equal(e.claim.availability.status, "unknown");
    assert.equal(e.claim.availability.quantity, null);
  });
  it("treats a sales block or a missing schedule as not orderable", () => {
    const blocked = buildPriceAvailabilityEnvelope("1", price, { productId: "1", closingTime: null, salesBlock: true, logisticModel: "Stock", scheduleLines: [line(50)] });
    assert.equal(blocked.claim.availability.status, "out_of_stock");
    const none = buildPriceAvailabilityEnvelope("1", price, { productId: "1", closingTime: null, salesBlock: false, logisticModel: "Stock", scheduleLines: [] });
    assert.equal(none.claim.availability.status, "out_of_stock");
  });
  it("does not invent a quantity for supplier-fulfilled products", () => {
    const e = buildPriceAvailabilityEnvelope("1", price, { productId: "1", closingTime: null, salesBlock: false, logisticModel: "Terminal", scheduleLines: [line(0)] });
    assert.equal(e.claim.availability.status, "terminal_supplier");
    assert.equal(e.claim.availability.quantity, null);
  });
  it("leaves a missing price null and labels the source as the sandbox", () => {
    const e = buildPriceAvailabilityEnvelope("1", undefined, { productId: "1", closingTime: null, salesBlock: false, logisticModel: "Stock", scheduleLines: [line(5)] });
    assert.equal(e.claim.price, null);
    assert.equal(e.provenance.source_system, "junction26_mock_backend");
    assert.equal(e.verification.status, "mock_verified");
  });
});

describe("demo order flow against the database", () => {
  let ctx: TestContext;
  const lines = JSON.stringify([{ requested_product_id: "p1", requested_product_name: "Milk", requested_qty: 10, status: "available", unit_price_eur: 1, line_total_eur: 10, alternatives: [] }]);

  async function insertQuote(id: string, buyerId: string, totalEur: number, expiresInMs = 600_000) {
    await ctx.db.query(
      `INSERT INTO quotes (id, buyer_id, lines, issued_at, expires_at, requested_delivery_date, status, total_eur) VALUES ($1,$2,$3,now(),$4,'2026-11-16','active',$5)`,
      [id, buyerId, lines, new Date(Date.now() + expiresInMs).toISOString(), totalEur]
    );
  }

  before(async () => {
    ctx = await createTestContext({ organizations: false });
    await ctx.db.query(
      `INSERT INTO buyers (id, display_name, contract_tier, credit_limit_eur, aimo_side_auto_approve_limit_eur) VALUES
        ('k-hotel-espoo', 'Hotel Espoo', 'contract', 5000, 2000), ('k-canteen-turku', 'Canteen Turku', 'contract', 1500, 1500)`
    );
  });
  after(() => ctx.close());

  it("labels every response as sandbox and carries a correlation id", async () => {
    const res = await call(ctx.app, "GET", "/health");
    assert.equal(res.body.environment, "sandbox");
    assert.equal(res.headers["x-aimo-environment"], "sandbox");
    assert.ok(res.headers["x-correlation-id"]);
    const supplied = await ctx.app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "trace-12345678" } });
    assert.equal(supplied.headers["x-correlation-id"], "trace-12345678");
    const hostile = await ctx.app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "x\" injected=1" } });
    assert.notEqual(hostile.headers["x-correlation-id"], "x\" injected=1");
  });

  it("requires an API key", async () => {
    assert.equal((await call(ctx.app, "POST", "/v1/orders", { body: { quote_id: "q-none" } })).status, 401);
    assert.equal((await call(ctx.app, "POST", "/v1/orders", { apiKey: "wrong", body: { quote_id: "q-none" } })).status, 401);
  });

  it("confirms an order within the supplier's limits and consumes the quote once", async () => {
    await insertQuote("q-ok", "k-hotel-espoo", 1860);
    const order = await call(ctx.app, "POST", "/v1/orders", { apiKey: DEMO_KEYS.hotel, body: { quote_id: "q-ok" } });
    assert.equal(order.status, 200);
    assert.equal(order.body.status, "confirmed");
    assert.equal(order.body.approval.required, false);
    const again = await call(ctx.app, "POST", "/v1/orders", { apiKey: DEMO_KEYS.hotel, body: { quote_id: "q-ok" } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "quote_already_consumed");
  });

  it("refuses an expired quote", async () => {
    await insertQuote("q-old", "k-hotel-espoo", 100, -1000);
    const order = await call(ctx.app, "POST", "/v1/orders", { apiKey: DEMO_KEYS.hotel, body: { quote_id: "q-old" } });
    assert.equal(order.status, 409);
    assert.equal(order.body.error, "quote_expired");
  });

  it("holds an over-limit order for the supplier, and a buyer-side human cannot clear it", async () => {
    await insertQuote("q-big", "k-hotel-espoo", 8407.2);
    const order = await call(ctx.app, "POST", "/v1/orders", { apiKey: DEMO_KEYS.hotel, body: { quote_id: "q-big" } });
    assert.equal(order.body.status, "held_for_approval");
    assert.equal(order.body.approval.owner, "aimo");
    assert.deepEqual(order.body.lines_confirmed, []);

    const id = order.body.order_id;
    const wrongOwner = await call(ctx.app, "POST", `/v1/orders/${id}/approve`, { apiKey: DEMO_KEYS.hotel, body: { actor: "human:buyer" } });
    assert.equal(wrongOwner.status, 403);
    assert.equal((await call(ctx.app, "GET", `/v1/orders/${id}`, { apiKey: DEMO_KEYS.hotel })).body.status, "held_for_approval");

    const cleared = await call(ctx.app, "POST", `/v1/orders/${id}/approve`, { apiKey: DEMO_KEYS.hotel, body: { actor: "human:aimo" } });
    assert.equal(cleared.body.status, "confirmed");

    const audit = await call(ctx.app, "GET", `/v1/audit/${id}`, { apiKey: DEMO_KEYS.hotel });
    assert.deepEqual(audit.body.events.map((e: any) => e.action), ["order_submitted", "order_held", "approval_rejected_wrong_owner", "order_approved"]);
  });

  it("hides one demo buyer's quotes, orders and audit trail from another", async () => {
    await insertQuote("q-private", "k-hotel-espoo", 500);
    const order = await call(ctx.app, "POST", "/v1/orders", { apiKey: DEMO_KEYS.hotel, body: { quote_id: "q-private" } });
    const id = order.body.order_id;
    const other = DEMO_KEYS.canteen;
    assert.equal((await call(ctx.app, "GET", `/v1/orders/${id}`, { apiKey: other })).status, 404);
    assert.equal((await call(ctx.app, "GET", `/v1/audit/${id}`, { apiKey: other })).status, 404);
    assert.equal((await call(ctx.app, "GET", "/v1/quote/q-private", { apiKey: other })).status, 404);
    assert.equal((await call(ctx.app, "POST", `/v1/orders/${id}/approve`, { apiKey: other, body: { actor: "human:aimo" } })).status, 404);
    assert.equal((await call(ctx.app, "GET", "/v1/buyers/k-hotel-espoo", { apiKey: other })).status, 403);
    await insertQuote("q-theirs", "k-hotel-espoo", 500);
    assert.equal((await call(ctx.app, "POST", "/v1/orders", { apiKey: other, body: { quote_id: "q-theirs" } })).status, 404);
  });

  it("re-runs migrations as a no-op", async () => {
    assert.deepEqual(await runMigrations(), []);
    assert.deepEqual(listMigrationFiles(), ["001_baseline.sql", "002_platform_tenancy.sql"]);
  });
});

describe("migration statement splitting", () => {
  it("drops comment lines and empty statements", () => {
    assert.deepEqual(splitStatements("-- note; with a semicolon\nCREATE TABLE a (id INT);\n\n-- more\nCREATE INDEX i ON a (id);\n"), ["CREATE TABLE a (id INT)", "CREATE INDEX i ON a (id)"]);
  });
});
