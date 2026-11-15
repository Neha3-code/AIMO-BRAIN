import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEMO_KEYS, PASSWORD, call, createOrg, createTestContext, signup, type TestContext } from "./helpers.js";

describe("platform authentication", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx.close());

  it("signs up, signs in and reads /v1/me", async () => {
    const u = await signup(ctx.app, "anna@buyer-a.test");
    const me = await call(ctx.app, "GET", "/v1/me", { token: u.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "anna@buyer-a.test");
    assert.deepEqual(me.body.organizations, []);

    const login = await call(ctx.app, "POST", "/v1/auth/login", { body: { email: "Anna@Buyer-A.test", password: PASSWORD } });
    assert.equal(login.status, 200, "email is case-insensitive");
    assert.ok(login.body.session_token);
  });

  it("never returns or stores the password or raw session token", async () => {
    const u = await signup(ctx.app, "store@buyer-a.test");
    const users = await ctx.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = 'store@buyer-a.test'");
    assert.ok(users.rows[0].password_hash.startsWith("scrypt$"));
    assert.ok(!users.rows[0].password_hash.includes(PASSWORD));
    const sessions = await ctx.db.query("SELECT 1 FROM sessions WHERE token_hash = $1", [u.token]);
    assert.equal(sessions.rows.length, 0, "the raw token must not be a valid lookup key");
  });

  it("rejects wrong passwords and unknown emails identically", async () => {
    await signup(ctx.app, "bo@buyer-a.test");
    const wrong = await call(ctx.app, "POST", "/v1/auth/login", { body: { email: "bo@buyer-a.test", password: "not the password" } });
    const unknown = await call(ctx.app, "POST", "/v1/auth/login", { body: { email: "nobody@buyer-a.test", password: "not the password" } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it("throttles repeated failed sign-ins for one email", async () => {
    await signup(ctx.app, "throttle@buyer-a.test");
    for (let i = 0; i < 10; i++) {
      await call(ctx.app, "POST", "/v1/auth/login", { body: { email: "throttle@buyer-a.test", password: "wrong wrong wrong" } });
    }
    const blocked = await call(ctx.app, "POST", "/v1/auth/login", { body: { email: "throttle@buyer-a.test", password: PASSWORD } });
    assert.equal(blocked.status, 429);
  });

  it("rejects weak passwords, duplicate emails and unknown fields", async () => {
    const weak = await call(ctx.app, "POST", "/v1/auth/signup", { body: { email: "weak@buyer-a.test", password: "short", display_name: "Weak" } });
    assert.equal(weak.status, 422);
    await signup(ctx.app, "dup@buyer-a.test");
    const dup = await call(ctx.app, "POST", "/v1/auth/signup", { body: { email: "DUP@buyer-a.test", password: PASSWORD, display_name: "Dup" } });
    assert.equal(dup.status, 409);
    const extra = await call(ctx.app, "POST", "/v1/auth/signup", { body: { email: "x@buyer-a.test", password: PASSWORD, display_name: "X", role: "org_owner" } });
    assert.equal(extra.status, 422);
  });

  it("requires a valid session and invalidates it on logout", async () => {
    assert.equal((await call(ctx.app, "GET", "/v1/me")).status, 401);
    assert.equal((await call(ctx.app, "GET", "/v1/me", { token: "not-a-real-token" })).status, 401);
    assert.equal((await call(ctx.app, "POST", "/v1/organizations", { body: { type: "buyer", legal_name: "X", display_name: "X" } })).status, 401);

    const u = await signup(ctx.app, "carl@buyer-a.test");
    assert.equal((await call(ctx.app, "POST", "/v1/auth/logout", { token: u.token })).status, 204);
    assert.equal((await call(ctx.app, "GET", "/v1/me", { token: u.token })).status, 401);
  });

  it("rejects an expired session", async () => {
    const u = await signup(ctx.app, "expired@buyer-a.test");
    await ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u.userId]);
    assert.equal((await call(ctx.app, "GET", "/v1/me", { token: u.token })).status, 401);
  });

  it("keeps the demo agent key and human sessions as separate credentials", async () => {
    const u = await signup(ctx.app, "dana@buyer-a.test");
    const orgId = await createOrg(ctx.app, u.token, "buyer", "Dana Bistro");

    // A demo buyer-agent API key is not a platform identity.
    assert.equal((await call(ctx.app, "GET", "/v1/me", { apiKey: DEMO_KEYS.hotel })).status, 401);
    assert.equal((await call(ctx.app, "GET", `/v1/organizations/${orgId}`, { apiKey: DEMO_KEYS.hotel })).status, 401);
    // A platform session cannot drive the demo's quote/order routes.
    assert.equal((await call(ctx.app, "GET", "/v1/buyers/k-hotel-espoo", { token: u.token })).status, 401);
    assert.equal((await call(ctx.app, "POST", "/v1/orders", { token: u.token, body: { quote_id: "q-1" } })).status, 401);
  });
});

describe("organizations feature flag off", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext({ organizations: false });
  });
  after(() => ctx.close());

  it("exposes no platform routes at all", async () => {
    for (const [method, url] of [
      ["POST", "/v1/auth/signup"],
      ["POST", "/v1/auth/login"],
      ["GET", "/v1/me"],
      ["POST", "/v1/organizations"],
      ["GET", "/v1/organizations/org_x/policy-versions"],
      ["POST", "/v1/invitations/accept"]
    ] as const) {
      assert.equal((await call(ctx.app, method, url, { body: {} })).status, 404, `${method} ${url}`);
    }
  });

  it("still serves the demo and reports the flag in /health", async () => {
    const health = await call(ctx.app, "GET", "/health");
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.features.organizations, false);
    assert.equal((await call(ctx.app, "GET", "/v1/buyers/k-hotel-espoo", { apiKey: DEMO_KEYS.hotel })).status, 404, "authenticated, buyer simply not seeded");
  });
});
