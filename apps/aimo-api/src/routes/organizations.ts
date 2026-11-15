import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  PRIVILEGED_ROLES,
  ROLES_BY_ORG_TYPE,
  type OnboardingChecklist,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
  type Organization
} from "@aimo/shared";
import { query } from "../db.js";
import { newLongId } from "../ids.js";
import { authorizeOrg, type OrgContext } from "../platform/authz.js";
import { listOrgAuditEvents, withAudit } from "../platform/audit.js";
import { hashToken, requireUser } from "../platform/sessions.js";
import { AcceptInviteSchema, ChangeRoleSchema, CreateOrgSchema, InviteSchema, ProfileSchemas, UpdateOrgSchema, issues } from "../platform/schemas.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function rowToOrg(row: any): Organization {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    legal_name: row.legal_name,
    display_name: row.display_name,
    profile: row.profile ?? {},
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString()
  };
}

function rowToInvitation(row: any): OrgInvitation {
  return {
    id: row.id,
    org_id: row.org_id,
    email: row.email,
    role: row.role,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString()
  };
}

async function onboardingChecklist(org: Organization): Promise<OnboardingChecklist> {
  const p = org.profile as { delivery_locations?: unknown[]; fulfilment_locations?: unknown[]; service_regions?: unknown[] };
  const profile_complete =
    org.type === "buyer" ? (p.delivery_locations?.length ?? 0) > 0 : (p.fulfilment_locations?.length ?? 0) > 0 && (p.service_regions?.length ?? 0) > 0;
  const rows = await query<{ n: string }>("SELECT count(*) AS n FROM policy_versions WHERE org_id = $1", [org.id]);
  return { profile_complete, policy_configured: Number(rows[0].n) > 0 };
}

/** Role rules shared by invitations and role changes. Returns an error reply body, or null. */
function roleRuleViolation(ctx: OrgContext, roles: OrgRole[]): { code: number; body: { error: string; message: string } } | null {
  for (const role of roles) {
    if (!ROLES_BY_ORG_TYPE[ctx.orgType].includes(role)) {
      return { code: 422, body: { error: "role_not_allowed_for_org_type", message: `Role '${role}' cannot exist in a ${ctx.orgType} organization.` } };
    }
  }
  if (roles.some((r) => PRIVILEGED_ROLES.includes(r)) && ctx.role !== "org_owner") {
    return { code: 403, body: { error: "forbidden", message: "Only an organization owner can grant, change or remove owner and admin roles." } };
  }
  return null;
}

export function registerOrganizationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.post("/v1/organizations", async (request, reply) => {
    const parsed = CreateOrgSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });
    const { type, legal_name, display_name } = parsed.data;
    const userId = request.user!.id;

    // Organization, its first owner and the audit record in one statement: an organization can
    // never exist without an owner.
    const rows = await query<any>(
      `WITH o AS (
         INSERT INTO organizations (id, type, legal_name, display_name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *
       ),
       m AS (INSERT INTO memberships (org_id, user_id, role) SELECT o.id, o.created_by, 'org_owner' FROM o),
       a AS (
         INSERT INTO org_audit_events (org_id, actor_user_id, action, entity_type, entity_id, detail, correlation_id)
         SELECT o.id, o.created_by, 'organization.created', 'organization', o.id, $6::jsonb, $7 FROM o
       )
       SELECT * FROM o`,
      [newLongId("org"), type, legal_name, display_name, userId, JSON.stringify({ type }), request.id]
    );
    return reply.code(201).send({ ...rowToOrg(rows[0]), my_role: "org_owner" });
  });

  app.get("/v1/organizations/:orgId", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "org:read");
    if (!ctx) return;
    const rows = await query<any>("SELECT * FROM organizations WHERE id = $1", [ctx.orgId]);
    const org = rowToOrg(rows[0]);
    return reply.send({ ...org, my_role: ctx.role, onboarding: await onboardingChecklist(org) });
  });

  app.patch("/v1/organizations/:orgId", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "org:update");
    if (!ctx) return;
    const parsed = UpdateOrgSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });

    let profileJson: string | null = null;
    if (parsed.data.profile !== undefined) {
      // Validated against the schema for THIS organization's type, taken from the database.
      const profile = ProfileSchemas[ctx.orgType].safeParse(parsed.data.profile);
      if (!profile.success) return reply.code(422).send({ error: "invalid_profile", details: issues(profile.error) });
      profileJson = JSON.stringify(profile.data);
    }

    const stmt = withAudit(
      `UPDATE organizations
          SET display_name = COALESCE($2, display_name), legal_name = COALESCE($3, legal_name),
              profile = COALESCE($4::jsonb, profile), updated_at = now()
        WHERE id = $1 RETURNING id AS org_id, id AS entity_id`,
      [ctx.orgId, parsed.data.display_name ?? null, parsed.data.legal_name ?? null, profileJson],
      {
        actorUserId: ctx.user.id,
        action: "organization.updated",
        entityType: "organization",
        detail: { fields: Object.keys(parsed.data) },
        correlationId: request.id
      }
    );
    await query(stmt.text, stmt.params);
    const rows = await query<any>("SELECT * FROM organizations WHERE id = $1", [ctx.orgId]);
    const org = rowToOrg(rows[0]);
    return reply.send({ ...org, my_role: ctx.role, onboarding: await onboardingChecklist(org) });
  });

  app.post("/v1/organizations/:orgId/onboarding/complete", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "org:update");
    if (!ctx) return;
    const rows = await query<any>("SELECT * FROM organizations WHERE id = $1", [ctx.orgId]);
    const org = rowToOrg(rows[0]);
    const onboarding = await onboardingChecklist(org);
    if (!onboarding.profile_complete || !onboarding.policy_configured) {
      return reply.code(409).send({ error: "onboarding_incomplete", onboarding });
    }
    const stmt = withAudit(
      `UPDATE organizations SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'onboarding' RETURNING id AS org_id, id AS entity_id`,
      [ctx.orgId],
      { actorUserId: ctx.user.id, action: "organization.onboarding_completed", entityType: "organization", correlationId: request.id }
    );
    await query(stmt.text, stmt.params);
    const updated = await query<any>("SELECT * FROM organizations WHERE id = $1", [ctx.orgId]);
    return reply.send({ ...rowToOrg(updated[0]), my_role: ctx.role, onboarding });
  });

  // ---- Members -----------------------------------------------------------

  app.get("/v1/organizations/:orgId/members", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "members:read");
    if (!ctx) return;
    const rows = await query<any>(
      `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 ORDER BY m.created_at ASC`,
      [ctx.orgId]
    );
    const members: OrgMember[] = rows.map((r) => ({
      user_id: r.user_id,
      email: r.email,
      display_name: r.display_name,
      role: r.role,
      joined_at: new Date(r.created_at).toISOString()
    }));
    return reply.send({ members });
  });

  app.patch("/v1/organizations/:orgId/members/:userId", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "members:manage");
    if (!ctx) return;
    const parsed = ChangeRoleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });
    const { userId } = request.params as { userId: string };

    const target = (await query<{ role: OrgRole }>("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [ctx.orgId, userId]))[0];
    if (!target) return reply.code(404).send({ error: "not_found" });
    const violation = roleRuleViolation(ctx, [target.role, parsed.data.role]);
    if (violation) return reply.code(violation.code).send(violation.body);

    const stmt = withAudit(
      `UPDATE memberships SET role = $3
        WHERE org_id = $1 AND user_id = $2
          AND (role <> 'org_owner' OR $3 = 'org_owner'
               OR (SELECT count(*) FROM memberships WHERE org_id = $1 AND role = 'org_owner') > 1)
        RETURNING org_id, user_id AS entity_id`,
      [ctx.orgId, userId, parsed.data.role],
      {
        actorUserId: ctx.user.id,
        action: "member.role_changed",
        entityType: "membership",
        detail: { from: target.role, to: parsed.data.role },
        correlationId: request.id
      }
    );
    const changed = await query(stmt.text, stmt.params);
    if (!changed[0]) return reply.code(409).send({ error: "last_owner", message: "An organization must keep at least one owner." });
    return reply.send({ user_id: userId, role: parsed.data.role });
  });

  app.delete("/v1/organizations/:orgId/members/:userId", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "members:manage");
    if (!ctx) return;
    const { userId } = request.params as { userId: string };

    const target = (await query<{ role: OrgRole }>("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [ctx.orgId, userId]))[0];
    if (!target) return reply.code(404).send({ error: "not_found" });
    const violation = roleRuleViolation(ctx, [target.role]);
    if (violation) return reply.code(violation.code).send(violation.body);

    const stmt = withAudit(
      `DELETE FROM memberships
        WHERE org_id = $1 AND user_id = $2
          AND (role <> 'org_owner' OR (SELECT count(*) FROM memberships WHERE org_id = $1 AND role = 'org_owner') > 1)
        RETURNING org_id, user_id AS entity_id`,
      [ctx.orgId, userId],
      { actorUserId: ctx.user.id, action: "member.removed", entityType: "membership", detail: { role: target.role }, correlationId: request.id }
    );
    const removed = await query(stmt.text, stmt.params);
    if (!removed[0]) return reply.code(409).send({ error: "last_owner", message: "An organization must keep at least one owner." });
    return reply.code(204).send();
  });

  // ---- Member invitations --------------------------------------------------

  app.post("/v1/organizations/:orgId/invitations", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "members:manage");
    if (!ctx) return;
    const parsed = InviteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });
    const violation = roleRuleViolation(ctx, [parsed.data.role]);
    if (violation) return reply.code(violation.code).send(violation.body);

    const existing = await query(
      "SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2",
      [ctx.orgId, parsed.data.email]
    );
    if (existing[0]) return reply.code(409).send({ error: "already_member" });

    const token = randomBytes(32).toString("base64url");
    const stmt = withAudit(
      `INSERT INTO org_invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, org_id, email, role, status, expires_at, created_at, id AS entity_id`,
      [newLongId("inv"), ctx.orgId, parsed.data.email, parsed.data.role, hashToken(token), ctx.user.id, new Date(Date.now() + INVITATION_TTL_MS).toISOString()],
      {
        actorUserId: ctx.user.id,
        action: "invitation.created",
        entityType: "invitation",
        detail: { email: parsed.data.email, role: parsed.data.role },
        correlationId: request.id
      }
    );
    const rows = await query<any>(stmt.text, stmt.params);
    // The token is returned exactly once and only its hash is stored. There is no email delivery
    // yet: the inviter passes the token to the invitee out of band.
    return reply.code(201).send({ invitation: rowToInvitation(rows[0]), accept_token: token });
  });

  app.get("/v1/organizations/:orgId/invitations", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "members:manage");
    if (!ctx) return;
    const rows = await query<any>(
      "SELECT id, org_id, email, role, status, expires_at, created_at FROM org_invitations WHERE org_id = $1 ORDER BY created_at DESC",
      [ctx.orgId]
    );
    return reply.send({ invitations: rows.map(rowToInvitation) });
  });

  app.delete("/v1/organizations/:orgId/invitations/:invitationId", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "members:manage");
    if (!ctx) return;
    const { invitationId } = request.params as { invitationId: string };
    const stmt = withAudit(
      `UPDATE org_invitations SET status = 'revoked' WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING org_id, id AS entity_id`,
      [invitationId, ctx.orgId],
      { actorUserId: ctx.user.id, action: "invitation.revoked", entityType: "invitation", correlationId: request.id }
    );
    const rows = await query(stmt.text, stmt.params);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });

  /** Joining: the caller must hold the one-time token AND be signed in as the invited email. */
  app.post("/v1/invitations/accept", async (request, reply) => {
    const parsed = AcceptInviteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });
    const user = request.user!;

    const rows = await query<{ org_id: string; role: OrgRole }>(
      `WITH inv AS (
         UPDATE org_invitations SET status = 'accepted', accepted_by = $2, accepted_at = now()
          WHERE token_hash = $1 AND status = 'pending' AND expires_at > now() AND email = $3
          RETURNING id, org_id, role, accepted_by
       ),
       m AS (
         INSERT INTO memberships (org_id, user_id, role) SELECT inv.org_id, inv.accepted_by, inv.role FROM inv
         ON CONFLICT (org_id, user_id) DO NOTHING
       ),
       a AS (
         INSERT INTO org_audit_events (org_id, actor_user_id, action, entity_type, entity_id, detail, correlation_id)
         SELECT inv.org_id, inv.accepted_by, 'invitation.accepted', 'invitation', inv.id, jsonb_build_object('role', inv.role), $4 FROM inv
       )
       SELECT org_id, role FROM inv`,
      [hashToken(parsed.data.token), user.id, user.email, request.id]
    );
    // One answer for unknown, expired, revoked, already-used and wrong-recipient tokens.
    if (!rows[0]) return reply.code(404).send({ error: "invitation_not_found", message: "This invitation is invalid, expired, or was issued to a different email." });
    return reply.send({ org_id: rows[0].org_id, role: rows[0].role });
  });

  // ---- Tenant-scoped audit -------------------------------------------------

  app.get("/v1/organizations/:orgId/audit-events", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "audit:read");
    if (!ctx) return;
    const limit = Math.min(200, Math.max(1, Number((request.query as { limit?: string }).limit) || 50));
    return reply.send({ events: await listOrgAuditEvents(ctx.orgId, limit) });
  });
}
