import type { FastifyReply, FastifyRequest } from "fastify";
import { roleHasPermission, type OrgRole, type OrgType, type Permission, type PlatformUser } from "@aimo/shared";
import { query } from "../db.js";

export interface OrgContext {
  user: PlatformUser;
  orgId: string;
  orgType: OrgType;
  role: OrgRole;
}

/**
 * The single tenant gate. Every organization-scoped route resolves its OrgContext through here,
 * and every query in such a route filters on the `orgId` it returns — never on an id taken
 * straight from the request.
 *
 * - Not a member: 404, identical to an organization that does not exist, so ids cannot be probed.
 * - Member without the permission: 403.
 *
 * Returns null after replying; the caller must then just return.
 */
export async function authorizeOrg(request: FastifyRequest, reply: FastifyReply, permission: Permission): Promise<OrgContext | null> {
  const user = request.user;
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const { orgId } = request.params as { orgId: string };
  const rows = await query<{ role: OrgRole; type: OrgType }>(
    `SELECT m.role, o.type FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.org_id = $1 AND m.user_id = $2`,
    [orgId, user.id]
  );
  const membership = rows[0];
  if (!membership) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  if (!roleHasPermission(membership.role, permission)) {
    reply.code(403).send({ error: "forbidden", message: `Role '${membership.role}' lacks permission '${permission}'.` });
    return null;
  }
  return { user, orgId, orgType: membership.type, role: membership.role };
}
