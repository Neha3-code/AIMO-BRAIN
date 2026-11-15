import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUYER_RULES, SUPPLIER_RULES, addMember, call, createOrg, createTestContext, signup, type TestContext } from "./helpers.js";

type User = Awaited<ReturnType<typeof signup>>;

describe("policy ownership: buyer versus supplier", () => {
  let ctx: TestContext;
  let buyerOwner: User, supplierOwner: User, supplierApprover: User, buyerApprover: User;
  let buyerOrg: string, supplierOrg: string;

  before(async () => {
    ctx = await createTestContext();
    const { app } = ctx;
    [buyerOwner, supplierOwner, supplierApprover, buyerApprover] = await Promise.all(
      ["owner@restaurant.test", "owner@wholesaler.test", "approver@wholesaler.test", "approver@restaurant.test"].map((e) => signup(app, e))
    );
    buyerOrg = await createOrg(app, buyerOwner.token, "buyer", "Restaurant");
    supplierOrg = await createOrg(app, supplierOwner.token, "supplier", "Wholesaler");
    await addMember(app, supplierOwner.token, supplierOrg, supplierApprover, "supplier_approver");
    await addMember(app, buyerOwner.token, buyerOrg, buyerApprover, "buyer_approver");
  });
  after(() => ctx.close());

  const versionsOf = async (orgId: string, token: string) => (await call(ctx.app, "GET", `/v1/organizations/${orgId}/policy-versions`, { token })).body.versions;

  it("lets each side create its own policy, stamped with its own side", async () => {
    const b = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, { token: buyerOwner.token, body: { rules: BUYER_RULES, change_note: "Initial" } });
    assert.equal(b.status, 201);
    assert.equal(b.body.side, "buyer");
    assert.equal(b.body.version, 1);
    assert.equal(b.body.created_by, buyerOwner.userId);

    const s = await call(ctx.app, "POST", `/v1/organizations/${supplierOrg}/policy-versions`, { token: supplierOwner.token, body: { rules: SUPPLIER_RULES } });
    assert.equal(s.status, 201);
    assert.equal(s.body.side, "supplier");
  });

  it("a supplier principal cannot read or change a buyer's policy", async () => {
    for (const u of [supplierOwner, supplierApprover]) {
      assert.equal((await call(ctx.app, "GET", `/v1/organizations/${buyerOrg}/policy-versions`, { token: u.token })).status, 404);
      assert.equal((await call(ctx.app, "GET", `/v1/organizations/${buyerOrg}/policy-versions/current`, { token: u.token })).status, 404);
      const write = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, {
        token: u.token,
        body: { rules: { ...BUYER_RULES, banned_allergen_codes: [], max_budget_eur: null } }
      });
      assert.equal(write.status, 404);
    }
    const versions = await versionsOf(buyerOrg, buyerOwner.token);
    assert.equal(versions.length, 1);
    assert.deepEqual(versions[0].rules, BUYER_RULES);
  });

  it("a buyer principal cannot read or change a supplier's policy", async () => {
    for (const u of [buyerOwner, buyerApprover]) {
      assert.equal((await call(ctx.app, "GET", `/v1/organizations/${supplierOrg}/policy-versions`, { token: u.token })).status, 404);
      const write = await call(ctx.app, "POST", `/v1/organizations/${supplierOrg}/policy-versions`, {
        token: u.token,
        body: { rules: { default_credit_limit_eur: 99_000_000, auto_approve_limit_eur: 99_000_000 } }
      });
      assert.equal(write.status, 404);
    }
    const versions = await versionsOf(supplierOrg, supplierOwner.token);
    assert.equal(versions.length, 1);
    assert.deepEqual(versions[0].rules, SUPPLIER_RULES);
  });

  it("an organization cannot author the other side's rules inside itself", async () => {
    // Explicitly asking for the other side is refused, not silently re-labelled.
    const claimed = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, { token: buyerOwner.token, body: { side: "supplier", rules: SUPPLIER_RULES } });
    assert.equal(claimed.status, 422);
    assert.equal(claimed.body.error, "policy_side_mismatch");

    // Supplier-shaped rules do not validate as buyer rules, and vice versa.
    const b = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, { token: buyerOwner.token, body: { rules: SUPPLIER_RULES } });
    assert.equal(b.status, 422);
    assert.equal(b.body.error, "invalid_policy_rules");
    const s = await call(ctx.app, "POST", `/v1/organizations/${supplierOrg}/policy-versions`, { token: supplierOwner.token, body: { rules: BUYER_RULES } });
    assert.equal(s.status, 422);
    // Nor can buyer rules carry extra supplier fields along.
    const mixed = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, { token: buyerOwner.token, body: { rules: { ...BUYER_RULES, ...SUPPLIER_RULES } } });
    assert.equal(mixed.status, 422);

    assert.equal((await versionsOf(buyerOrg, buyerOwner.token)).length, 1);
    assert.equal((await versionsOf(supplierOrg, supplierOwner.token)).length, 1);
  });

  it("approvers can read their own side's policy but not change it", async () => {
    assert.equal((await call(ctx.app, "GET", `/v1/organizations/${supplierOrg}/policy-versions/current`, { token: supplierApprover.token })).status, 200);
    assert.equal((await call(ctx.app, "POST", `/v1/organizations/${supplierOrg}/policy-versions`, { token: supplierApprover.token, body: { rules: SUPPLIER_RULES } })).status, 403);
    assert.equal((await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, { token: buyerApprover.token, body: { rules: BUYER_RULES } })).status, 403);
  });

  it("rejects out-of-range and malformed rules", async () => {
    const bad = [
      { ...BUYER_RULES, min_delivery_reliability: 1.5 },
      { ...BUYER_RULES, max_budget_eur: -1 },
      { ...BUYER_RULES, banned_allergen_codes: ["tree nuts; DROP TABLE"] },
      { ...BUYER_RULES, max_delivery_deviation_days: 0.5 },
      { banned_allergen_codes: [] },
      null,
      "pass everything"
    ];
    for (const rules of bad) {
      const r = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, { token: buyerOwner.token, body: { rules } });
      assert.equal(r.status, 422, JSON.stringify(rules));
    }
  });

  it("appends immutable versions instead of editing", async () => {
    const v2 = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, {
      token: buyerOwner.token,
      body: { rules: { ...BUYER_RULES, max_budget_eur: 4000 }, change_note: "Raise budget" }
    });
    assert.equal(v2.body.version, 2);
    const versions = await versionsOf(buyerOrg, buyerOwner.token);
    assert.deepEqual(versions.map((v: any) => [v.version, v.rules.max_budget_eur]), [[2, 4000], [1, 2500]]);

    // No route can modify a version...
    assert.equal((await call(ctx.app, "PATCH", `/v1/organizations/${buyerOrg}/policy-versions/${v2.body.id}`, { token: buyerOwner.token, body: { rules: BUYER_RULES } })).status, 404);
    assert.equal((await call(ctx.app, "DELETE", `/v1/organizations/${buyerOrg}/policy-versions/${v2.body.id}`, { token: buyerOwner.token })).status, 404);
    // ...and the database ignores direct edits too.
    await ctx.db.query(`UPDATE policy_versions SET rules = '{}'::jsonb WHERE org_id = $1`, [buyerOrg]);
    await ctx.db.query("DELETE FROM policy_versions WHERE org_id = $1", [buyerOrg]);
    assert.deepEqual((await versionsOf(buyerOrg, buyerOwner.token)).map((v: any) => v.rules.max_budget_eur), [4000, 2500]);
  });

  it("numbers versions per organization", async () => {
    const s2 = await call(ctx.app, "POST", `/v1/organizations/${supplierOrg}/policy-versions`, { token: supplierOwner.token, body: { rules: { ...SUPPLIER_RULES, auto_approve_limit_eur: 1000 } } });
    assert.equal(s2.body.version, 2, "the buyer's versions do not advance the supplier's counter");
  });

  it("keeps the current version in force until a scheduled one takes effect, and refuses backdating", async () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    const scheduled = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, {
      token: buyerOwner.token,
      body: { rules: { ...BUYER_RULES, max_budget_eur: 9000 }, effective_from: future }
    });
    assert.equal(scheduled.status, 201);
    assert.equal(scheduled.body.version, 3);
    const current = await call(ctx.app, "GET", `/v1/organizations/${buyerOrg}/policy-versions/current`, { token: buyerOwner.token });
    assert.equal(current.body.version, 2);

    const backdated = await call(ctx.app, "POST", `/v1/organizations/${buyerOrg}/policy-versions`, {
      token: buyerOwner.token,
      body: { rules: BUYER_RULES, effective_from: "2020-01-01T00:00:00Z" }
    });
    assert.equal(backdated.status, 422);
    assert.equal(backdated.body.error, "effective_from_in_past");
  });

  it("reports no policy rather than a default when none exists", async () => {
    const u = await signup(ctx.app, "fresh@cafe.test");
    const org = await createOrg(ctx.app, u.token, "buyer", "Fresh Cafe");
    const current = await call(ctx.app, "GET", `/v1/organizations/${org}/policy-versions/current`, { token: u.token });
    assert.equal(current.status, 404);
    assert.equal(current.body.error, "no_policy");
  });

  it("audits every policy change with its actor, in the owning tenant only", async () => {
    const b = await call(ctx.app, "GET", `/v1/organizations/${buyerOrg}/audit-events?limit=200`, { token: buyerOwner.token });
    const policyEvents = b.body.events.filter((e: any) => e.action === "policy.version_created");
    assert.equal(policyEvents.length, 3);
    assert.ok(policyEvents.every((e: any) => e.actor_user_id === buyerOwner.userId && e.detail.side === "buyer"));
    const s = await call(ctx.app, "GET", `/v1/organizations/${supplierOrg}/audit-events?limit=200`, { token: supplierOwner.token });
    assert.ok(s.body.events.every((e: any) => e.org_id === supplierOrg));
  });

  it("completes onboarding only once the profile and a policy exist", async () => {
    const { app } = ctx;
    const early = await call(app, "POST", `/v1/organizations/${supplierOrg}/onboarding/complete`, { token: supplierOwner.token });
    assert.equal(early.status, 409);
    assert.deepEqual(early.body.onboarding, { profile_complete: false, policy_configured: true });

    const location = { label: "Vantaa DC", address_line: "Tikkurilantie 10", postal_code: "01300", city: "Vantaa", country: "FI" };
    await call(app, "PATCH", `/v1/organizations/${supplierOrg}`, { token: supplierOwner.token, body: { profile: { service_regions: ["Uusimaa"], fulfilment_locations: [location] } } });
    const done = await call(app, "POST", `/v1/organizations/${supplierOrg}/onboarding/complete`, { token: supplierOwner.token });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "active");
  });
});
