import type { AuditActor, AuditEvent } from "@aimo/shared";
import { query } from "./db.js";

export async function recordAuditEvent(
  orderId: string,
  actor: AuditActor,
  action: string,
  reasons: string[],
  policyVersion: string
): Promise<void> {
  await query(
    `INSERT INTO audit_events (order_id, actor, action, reasons, policy_version) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, actor, action, JSON.stringify(reasons), policyVersion]
  );
}

export async function getAuditTrail(orderId: string): Promise<AuditEvent[]> {
  const rows = await query<any>(
    `SELECT order_id, timestamp, actor, action, reasons, policy_version FROM audit_events WHERE order_id = $1 ORDER BY id ASC`,
    [orderId]
  );
  return rows.map((r) => ({
    order_id: r.order_id,
    timestamp: new Date(r.timestamp).toISOString(),
    actor: r.actor,
    action: r.action,
    reasons: r.reasons,
    policy_version: r.policy_version
  }));
}
