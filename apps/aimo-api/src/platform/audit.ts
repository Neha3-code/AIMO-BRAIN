import type { OrgAuditEvent } from "@aimo/shared";
import { query } from "../db.js";

/**
 * Builds a single statement that performs `mutation` and, only if it changed a row, appends an
 * org_audit_events row. One statement means the change and its evidence commit or fail together —
 * the Neon HTTP driver has no multi-statement transactions.
 *
 * `mutation` must be a data-modifying statement with a RETURNING clause that exposes `org_id`
 * and `entity_id`. Audit parameters are appended after `mutationParams`.
 */
export function withAudit(
  mutation: string,
  mutationParams: any[],
  audit: { actorUserId: string; action: string; entityType: string; detail?: Record<string, unknown>; correlationId: string }
): { text: string; params: any[] } {
  const n = mutationParams.length;
  const text = `
    WITH m AS (${mutation}),
    a AS (
      INSERT INTO org_audit_events (org_id, actor_user_id, action, entity_type, entity_id, detail, correlation_id)
      SELECT m.org_id, $${n + 1}, $${n + 2}, $${n + 3}, m.entity_id, $${n + 4}::jsonb, $${n + 5} FROM m
    )
    SELECT * FROM m`;
  return { text, params: [...mutationParams, audit.actorUserId, audit.action, audit.entityType, JSON.stringify(audit.detail ?? {}), audit.correlationId] };
}

export async function listOrgAuditEvents(orgId: string, limit: number): Promise<OrgAuditEvent[]> {
  const rows = await query<any>(
    `SELECT id, org_id, actor_user_id, action, entity_type, entity_id, detail, correlation_id, created_at
       FROM org_audit_events WHERE org_id = $1 ORDER BY id DESC LIMIT $2`,
    [orgId, limit]
  );
  return rows.map((r) => ({ ...r, id: String(r.id), created_at: new Date(r.created_at).toISOString() }));
}
