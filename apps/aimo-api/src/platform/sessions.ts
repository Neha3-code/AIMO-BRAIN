import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlatformUser } from "@aimo/shared";
import { query } from "../db.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireUser. The only source of human identity for platform routes. */
    user?: PlatformUser;
    sessionTokenHash?: string;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Opaque random bearer token. Only its SHA-256 is stored, so a database read cannot be replayed
 *  as a session. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [hashToken(token), userId, expiresAt]);
  return { token, expiresAt };
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
}

/**
 * Human authentication for platform routes. Deliberately separate from requireBuyerAuth: the
 * demo's X-API-Key identifies a buyer *agent* and never grants organization access, and a user
 * session never grants access to the demo's /v1 quote and order routes.
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return reply.code(401).send({ error: "unauthorized", message: "Missing bearer session token." });
  }
  const tokenHash = hashToken(token);
  const rows = await query<PlatformUser>(
    `SELECT u.id, u.email, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [tokenHash]
  );
  if (!rows[0]) {
    return reply.code(401).send({ error: "unauthorized", message: "Session is invalid or expired." });
  }
  request.user = rows[0];
  request.sessionTokenHash = tokenHash;
}
