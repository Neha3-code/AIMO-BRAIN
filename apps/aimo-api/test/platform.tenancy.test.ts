import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUYER_RULES, addMember, call, createOrg, createTestContext, signup, type TestContext } from "./helpers.js";

type User = Awaited<ReturnType<typeof signup>>;

describe("tenant isolation and RBAC", () => {
  let ctx: TestContext;
  let ownerA: User, ownerB: User, supplierOwner: User;
  let adminA: User, purchaserA: User, approverA: User, viewerA: User;
  let orgA: string, orgB: string, orgS: string;

  before(async () => {
    ctx = await createTestContext();
    const { app } = ctx;
    [ownerA, ownerB, supplierOwner, adminA, purchaserA, approverA, viewerA] = await Promise.all(
      ["owner@a.test", "owner@b.test", "owner@s.test", "admin@a.test", "purchaser@a.test", "approver@a.test", "viewer@a.test"].map((e) => signup(app, e))
    );
    orgA = await createOrg(app, ownerA.token, "buyer", "Buyer A");
    orgB = await createOrg(app, ownerB.token, "buyer", "Buyer B");
    orgS = await createOrg(app, supplierOwner.token, "supplier", "Supplier S");
    await addMember(app, ownerA.token, orgA, adminA, "org_admin");
    await addMember(app, ownerA.token, orgA, purchaserA, "buyer_purchaser");
    await addMember(app, ownerA.token, orgA, approverA, "buyer_approver");
    await addMember(app, ownerA.token, orgA, viewerA, "viewer");
    // Buyer B has a policy, so there is real data for Buyer A to fail to read.
    const p = await call(app, "POST", `/v1/organizations/${orgB}/policy-versions`, { token: ownerB.token, body: { rules: BUYER_RULES } });
    assert.equal(p.status, 201);
  });
  after(() => ctx.close());

  it("makes the creator the owner and lists only the caller's organizations", async () => {
    const me = await call(ctx.app, "GET", "/v1/me", { token: ownerA.token });
    assert.deepEqual(me.body.organizations.map((o: any) => [o.id, o.my_role]), [[orgA, "org_owner"]]);
    const meB = await call(ctx.app, "GET", "/v1/me", { token: ownerB.token });
    assert.deepEqual(meB.body.organizations.map((o: any) => o.id), [orgB]);
  });

  it("answers 404 for every read of another tenant, exactly as for an organization that does not exist", async () => {
    const paths = ["", "/members", "/invitations", "/policy-versions", "/policy-versions/current", "/audit-events"];
    for (const path of paths) {
      const other = await call(ctx.app, "GET", `/v1/organizations/${orgB}${path}`, { token: ownerA.token });
      const missing = await call(ctx.app, "GET", `/v1/organizations/org_does_not_exist${path}`, { token: ownerA.token });
      assert.equal(other.status, 404, `GET ${path}`);
      assert.deepEqual(other.body, missing.body, `GET ${path} must not reveal that the organization exists`);
    }
  });

  it("answers 404 for every write to another tenant and changes nothing", async () => {
    const { app } = ctx;
    const t = ownerA.token;
    const attempts = [
      await call(app, "PATCH", `/v1/organizations/${orgB}`, { token: t, body: { display_name: "Hijacked" } }),
      await call(app, "POST", `/v1/organizations/${orgB}/onboarding/complete`, { token: t }),
      await call(app, "POST", `/v1/organizations/${orgB}/invitations`, { token: t, body: { email: ownerA.email, role: "org_owner" } }),
      await call(app, "POST", `/v1/organizations/${orgB}/policy-versions`, { token: t, body: { rules: { ...BUYER_RULES, banned_allergen_codes: [] } } }),
      await call(app, "PATCH", `/v1/organizations/${orgB}/members/${ownerB.userId}`, { token: t, body: { role: "viewer" } }),
      await call(app, "DELETE", `/v1/organizations/${orgB}/members/${ownerB.userId}`, { token: t })
    ];
    for (const a of attempts) assert.equal(a.status, 404);

    const org = await call(app, "GET", `/v1/organizations/${orgB}`, { token: ownerB.token });
    assert.equal(org.body.display_name, "Buyer B");
    const versions = await call(app, "GET", `/v1/organizations/${orgB}/policy-versions`, { token: ownerB.token });
    assert.equal(versions.body.versions.length, 1);
    assert.deepEqual(versions.body.versions[0].rules.banned_allergen_codes, ["AW"]);
    const members = await call(app, "GET", `/v1/organizations/${orgB}/members`, { token: ownerB.token });
    assert.deepEqual(members.body.members.map((m: any) => [m.user_id, m.role]), [[ownerB.userId, "org_owner"]]);
  });

  it("cannot reach another tenant's member or invitation through its own organization's URL", async () => {
    const { app } = ctx;
    // ownerB is not a member of org A, so org A's URL must not be a handle on them.
    assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${ownerB.userId}`, { token: ownerA.token, body: { role: "viewer" } })).status, 404);
    assert.equal((await call(app, "DELETE", `/v1/organizations/${orgA}/members/${ownerB.userId}`, { token: ownerA.token })).status, 404);

    const inv = await call(app, "POST", `/v1/organizations/${orgB}/invitations`, { token: ownerB.token, body: { email: "new@b.test", role: "viewer" } });
    const crossRevoke = await call(app, "DELETE", `/v1/organizations/${orgA}/invitations/${inv.body.invitation.id}`, { token: ownerA.token });
    assert.equal(crossRevoke.status, 404);
    const list = await call(app, "GET", `/v1/organizations/${orgB}/invitations`, { token: ownerB.token });
    assert.equal(list.body.invitations.find((i: any) => i.id === inv.body.invitation.id).status, "pending");
  });

  it("isolates a supplier from a buyer in both directions", async () => {
    const { app } = ctx;
    assert.equal((await call(app, "GET", `/v1/organizations/${orgS}`, { token: ownerA.token })).status, 404);
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/policy-versions`, { token: supplierOwner.token })).status, 404);
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/audit-events`, { token: supplierOwner.token })).status, 404);
  });

  it("enforces the permission matrix on the server for non-admin roles", async () => {
    const { app } = ctx;
    for (const u of [purchaserA, approverA, viewerA]) {
      assert.equal((await call(app, "GET", `/v1/organizations/${orgA}`, { token: u.token })).status, 200);
      assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/members`, { token: u.token })).status, 200);
      assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/policy-versions`, { token: u.token })).status, 200);

      assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}`, { token: u.token, body: { display_name: "Nope" } })).status, 403);
      assert.equal((await call(app, "POST", `/v1/organizations/${orgA}/policy-versions`, { token: u.token, body: { rules: BUYER_RULES } })).status, 403);
      assert.equal((await call(app, "POST", `/v1/organizations/${orgA}/invitations`, { token: u.token, body: { email: "x@a.test", role: "viewer" } })).status, 403);
      assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/invitations`, { token: u.token })).status, 403);
      assert.equal((await call(app, "DELETE", `/v1/organizations/${orgA}/members/${viewerA.userId}`, { token: u.token })).status, 403);
      assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${u.userId}`, { token: u.token, body: { role: "org_owner" } })).status, 403, "no self-promotion");
    }
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/audit-events`, { token: approverA.token })).status, 200);
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/audit-events`, { token: purchaserA.token })).status, 403);
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}/audit-events`, { token: viewerA.token })).status, 403);
  });

  it("lets an admin manage ordinary members but not owner or admin roles", async () => {
    const { app } = ctx;
    const t = adminA.token;
    assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${viewerA.userId}`, { token: t, body: { role: "buyer_purchaser" } })).status, 200);
    assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${viewerA.userId}`, { token: t, body: { role: "viewer" } })).status, 200);

    assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${viewerA.userId}`, { token: t, body: { role: "org_admin" } })).status, 403);
    assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${adminA.userId}`, { token: t, body: { role: "org_owner" } })).status, 403);
    assert.equal((await call(app, "PATCH", `/v1/organizations/${orgA}/members/${ownerA.userId}`, { token: t, body: { role: "viewer" } })).status, 403);
    assert.equal((await call(app, "DELETE", `/v1/organizations/${orgA}/members/${ownerA.userId}`, { token: t })).status, 403);
    assert.equal((await call(app, "POST", `/v1/organizations/${orgA}/invitations`, { token: t, body: { email: "x@a.test", role: "org_admin" } })).status, 403);
  });

  it("refuses roles that belong to the other side of a trade", async () => {
    const { app } = ctx;
    const inv = await call(app, "POST", `/v1/organizations/${orgA}/invitations`, { token: ownerA.token, body: { email: "x@a.test", role: "supplier_approver" } });
    assert.equal(inv.status, 422);
    assert.equal(inv.body.error, "role_not_allowed_for_org_type");
    const change = await call(app, "PATCH", `/v1/organizations/${orgA}/members/${viewerA.userId}`, { token: ownerA.token, body: { role: "supplier_sales" } });
    assert.equal(change.status, 422);
    const sInv = await call(app, "POST", `/v1/organizations/${orgS}/invitations`, { token: supplierOwner.token, body: { email: "x@s.test", role: "buyer_approver" } });
    assert.equal(sInv.status, 422);
  });

  it("never leaves an organization without an owner", async () => {
    const { app } = ctx;
    const demote = await call(app, "PATCH", `/v1/organizations/${orgB}/members/${ownerB.userId}`, { token: ownerB.token, body: { role: "viewer" } });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error, "last_owner");
    assert.equal((await call(app, "DELETE", `/v1/organizations/${orgB}/members/${ownerB.userId}`, { token: ownerB.token })).status, 409);
  });

  it("binds an invitation to its recipient, its organization and a single use", async () => {
    const { app } = ctx;
    const invitee = await signup(app, "invitee@b.test");
    const inv = await call(app, "POST", `/v1/organizations/${orgB}/invitations`, { token: ownerB.token, body: { email: invitee.email, role: "buyer_approver" } });
    const token = inv.body.accept_token;
    assert.ok(!JSON.stringify(inv.body.invitation).includes(token));

    // Someone else holding the token cannot use it.
    assert.equal((await call(app, "POST", "/v1/invitations/accept", { token: ownerA.token, body: { token } })).status, 404);
    assert.equal((await call(app, "GET", `/v1/organizations/${orgB}`, { token: ownerA.token })).status, 404);

    const ok = await call(app, "POST", "/v1/invitations/accept", { token: invitee.token, body: { token } });
    assert.deepEqual(ok.body, { org_id: orgB, role: "buyer_approver" });
    assert.equal((await call(app, "GET", `/v1/organizations/${orgB}`, { token: invitee.token })).body.my_role, "buyer_approver");
    assert.equal((await call(app, "POST", "/v1/invitations/accept", { token: invitee.token, body: { token } })).status, 404, "single use");

    // Membership in B grants nothing in A.
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}`, { token: invitee.token })).status, 404);
  });

  it("rejects revoked and expired invitations", async () => {
    const { app } = ctx;
    const u1 = await signup(app, "revoked@b.test");
    const u2 = await signup(app, "late@b.test");
    const i1 = await call(app, "POST", `/v1/organizations/${orgB}/invitations`, { token: ownerB.token, body: { email: u1.email, role: "viewer" } });
    assert.equal((await call(app, "DELETE", `/v1/organizations/${orgB}/invitations/${i1.body.invitation.id}`, { token: ownerB.token })).status, 204);
    assert.equal((await call(app, "POST", "/v1/invitations/accept", { token: u1.token, body: { token: i1.body.accept_token } })).status, 404);

    const i2 = await call(app, "POST", `/v1/organizations/${orgB}/invitations`, { token: ownerB.token, body: { email: u2.email, role: "viewer" } });
    await ctx.db.query("UPDATE org_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [i2.body.invitation.id]);
    assert.equal((await call(app, "POST", "/v1/invitations/accept", { token: u2.token, body: { token: i2.body.accept_token } })).status, 404);
  });

  it("cuts off access immediately when a member is removed", async () => {
    const { app } = ctx;
    const temp = await signup(app, "temp@a.test");
    await addMember(app, ownerA.token, orgA, temp, "viewer");
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}`, { token: temp.token })).status, 200);
    assert.equal((await call(app, "DELETE", `/v1/organizations/${orgA}/members/${temp.userId}`, { token: adminA.token })).status, 204);
    assert.equal((await call(app, "GET", `/v1/organizations/${orgA}`, { token: temp.token })).status, 404);
  });

  it("validates the profile against the organization's own type", async () => {
    const { app } = ctx;
    const location = { label: "Kitchen", address_line: "Keilaranta 1", postal_code: "02150", city: "Espoo", country: "FI" };
    const ok = await call(app, "PATCH", `/v1/organizations/${orgA}`, { token: ownerA.token, body: { profile: { delivery_locations: [location] } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.onboarding.profile_complete, true);
    const wrongSide = await call(app, "PATCH", `/v1/organizations/${orgA}`, { token: ownerA.token, body: { profile: { service_regions: ["Uusimaa"] } } });
    assert.equal(wrongSide.status, 422);
    const cannotRetype = await call(app, "PATCH", `/v1/organizations/${orgA}`, { token: ownerA.token, body: { type: "supplier" } });
    assert.equal(cannotRetype.status, 422, "organization type is immutable");
  });

  it("records who did what in a tenant-scoped, append-only audit log", async () => {
    const { app } = ctx;
    const a = await call(app, "GET", `/v1/organizations/${orgA}/audit-events?limit=200`, { token: ownerA.token });
    assert.ok(a.body.events.every((e: any) => e.org_id === orgA), "no other tenant's events");
    const actions = new Set(a.body.events.map((e: any) => e.action));
    for (const expected of ["organization.created", "invitation.created", "invitation.accepted", "member.role_changed", "member.removed", "organization.updated"]) {
      assert.ok(actions.has(expected), `missing ${expected}`);
    }
    const created = a.body.events.find((e: any) => e.action === "organization.created");
    assert.equal(created.actor_user_id, ownerA.userId);
    assert.ok(created.correlation_id);

    const before = await ctx.db.query("SELECT count(*)::int AS n FROM org_audit_events");
    await ctx.db.query("UPDATE org_audit_events SET action = 'tampered'");
    await ctx.db.query("DELETE FROM org_audit_events");
    const afterRows = await ctx.db.query<{ n: number; tampered: number }>(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE action = 'tampered')::int AS tampered FROM org_audit_events"
    );
    assert.equal(afterRows.rows[0].n, (before.rows[0] as any).n);
    assert.equal(afterRows.rows[0].tampered, 0);
  });
});
