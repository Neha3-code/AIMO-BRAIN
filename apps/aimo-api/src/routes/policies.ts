import type { FastifyInstance } from "fastify";
import type { PolicyVersion } from "@aimo/shared";
import { query } from "../db.js";
import { newLongId } from "../ids.js";
import { authorizeOrg } from "../platform/authz.js";
import { withAudit } from "../platform/audit.js";
import { requireUser } from "../platform/sessions.js";
import { CreatePolicyVersionSchema, PolicyRulesSchemas, issues } from "../platform/schemas.js";

const COLUMNS = "id, org_id, side, version, rules, effective_from, change_note, created_by, created_at";

function rowToPolicyVersion(row: any): PolicyVersion {
  return {
    id: row.id,
    org_id: row.org_id,
    side: row.side,
    version: Number(row.version),
    rules: row.rules,
    effective_from: new Date(row.effective_from).toISOString(),
    change_note: row.change_note,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString()
  };
}

/**
 * Tenant-owned, versioned policy configuration.
 *
 * Ownership invariant: a policy version can only be created inside the caller's own
 * organization, and its side is that organization's type. There is no route, parameter or role
 * through which a buyer principal can write supplier rules or a supplier principal buyer rules.
 *
 * Versions are immutable: there is no update or delete route, and the database rewrites UPDATE
 * and DELETE on policy_versions to nothing. Changing a policy means appending a new version.
 *
 * NOT YET WIRED: the Junction26 demo flow still evaluates its hardcoded demo policies. These
 * records do not influence any quote or order until the trade state machine reads them.
 */
export function registerPolicyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/v1/organizations/:orgId/policy-versions", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "policy:read");
    if (!ctx) return;
    const rows = await query<any>(`SELECT ${COLUMNS} FROM policy_versions WHERE org_id = $1 ORDER BY version DESC`, [ctx.orgId]);
    return reply.send({ side: ctx.orgType, versions: rows.map(rowToPolicyVersion) });
  });

  /** The version in force now: the highest version whose effective date has passed. */
  app.get("/v1/organizations/:orgId/policy-versions/current", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "policy:read");
    if (!ctx) return;
    const rows = await query<any>(
      `SELECT ${COLUMNS} FROM policy_versions WHERE org_id = $1 AND effective_from <= now() ORDER BY version DESC LIMIT 1`,
      [ctx.orgId]
    );
    if (!rows[0]) return reply.code(404).send({ error: "no_policy", message: "This organization has no policy in effect yet." });
    return reply.send(rowToPolicyVersion(rows[0]));
  });

  app.post("/v1/organizations/:orgId/policy-versions", async (request, reply) => {
    const ctx = await authorizeOrg(request, reply, "policy:write");
    if (!ctx) return;
    const parsed = CreatePolicyVersionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });

    if (parsed.data.side && parsed.data.side !== ctx.orgType) {
      return reply.code(422).send({
        error: "policy_side_mismatch",
        message: `A ${ctx.orgType} organization owns only ${ctx.orgType}-side policy. It cannot define ${parsed.data.side}-side rules.`
      });
    }
    const rules = PolicyRulesSchemas[ctx.orgType].safeParse(parsed.data.rules);
    if (!rules.success) return reply.code(422).send({ error: "invalid_policy_rules", details: issues(rules.error) });

    const effectiveFrom = parsed.data.effective_from ? new Date(parsed.data.effective_from) : new Date();
    // No backdating: a version must not claim to have governed decisions made before it existed.
    if (effectiveFrom.getTime() < Date.now() - 60_000) {
      return reply.code(422).send({ error: "effective_from_in_past", message: "effective_from cannot be in the past." });
    }

    const stmt = withAudit(
      `INSERT INTO policy_versions (id, org_id, side, version, rules, effective_from, change_note, created_by)
       SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4::jsonb, $5, $6, $7 FROM policy_versions WHERE org_id = $2
       RETURNING ${COLUMNS}, id AS entity_id`,
      [newLongId("pol"), ctx.orgId, ctx.orgType, JSON.stringify(rules.data), effectiveFrom.toISOString(), parsed.data.change_note ?? null, ctx.user.id],
      { actorUserId: ctx.user.id, action: "policy.version_created", entityType: "policy_version", detail: { side: ctx.orgType }, correlationId: request.id }
    );
    try {
      const rows = await query<any>(stmt.text, stmt.params);
      return reply.code(201).send(rowToPolicyVersion(rows[0]));
    } catch (err) {
      // Two concurrent writers computed the same next version; UNIQUE (org_id, version) rejected one.
      if (/policy_versions_org_id_version_key|duplicate key/i.test((err as Error).message)) {
        return reply.code(409).send({ error: "version_conflict", message: "Another policy version was created at the same time. Reload and retry." });
      }
      throw err;
    }
  });
}
