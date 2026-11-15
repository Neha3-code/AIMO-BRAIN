import type { FastifyInstance } from "fastify";
import type { OrganizationMembershipView, PlatformUser } from "@aimo/shared";
import { query } from "../db.js";
import { newLongId } from "../ids.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../platform/passwords.js";
import { createSession, requireUser, revokeSession } from "../platform/sessions.js";
import { LoginSchema, SignupSchema, issues } from "../platform/schemas.js";
import { rowToOrg } from "./organizations.js";

const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;

/**
 * Per-email failed-login throttle. In-memory, so it only holds on a single instance and resets
 * on restart — a stopgap until auth moves to a managed provider and rate limiting to the edge.
 */
function createLoginThrottle() {
  const failures = new Map<string, { count: number; resetAt: number }>();
  return {
    blocked(email: string): boolean {
      const f = failures.get(email);
      if (f && f.resetAt <= Date.now()) failures.delete(email);
      return (failures.get(email)?.count ?? 0) >= MAX_FAILED_LOGINS;
    },
    fail(email: string) {
      const f = failures.get(email);
      if (f && f.resetAt > Date.now()) f.count += 1;
      else failures.set(email, { count: 1, resetAt: Date.now() + FAILED_LOGIN_WINDOW_MS });
      if (failures.size > 10_000) failures.clear();
    },
    clear(email: string) {
      failures.delete(email);
    }
  };
}

export function registerPlatformAuthRoutes(app: FastifyInstance) {
  const throttle = createLoginThrottle();

  app.post("/v1/auth/signup", async (request, reply) => {
    const parsed = SignupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });
    const { email, password, display_name } = parsed.data;

    const rows = await query<PlatformUser>(
      `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, display_name`,
      [newLongId("usr"), email, display_name, await hashPassword(password)]
    );
    if (!rows[0]) return reply.code(409).send({ error: "email_taken", message: "An account with this email already exists." });

    const session = await createSession(rows[0].id);
    return reply.code(201).send({ user: rows[0], session_token: session.token, expires_at: session.expiresAt });
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request", details: issues(parsed.error) });
    const { email, password } = parsed.data;

    if (throttle.blocked(email)) {
      return reply.code(429).send({ error: "too_many_attempts", message: "Too many failed sign-in attempts. Try again in 15 minutes." });
    }

    const rows = await query<PlatformUser & { password_hash: string; status: string }>(
      "SELECT id, email, display_name, password_hash, status FROM users WHERE email = $1",
      [email]
    );
    const user = rows[0];
    let ok = false;
    if (user) ok = (await verifyPassword(password, user.password_hash)) && user.status === "active";
    else await verifyAgainstDummy(password);

    if (!user || !ok) {
      throttle.fail(email);
      // One message for unknown email, wrong password and disabled account.
      return reply.code(401).send({ error: "invalid_credentials", message: "Email or password is incorrect." });
    }
    throttle.clear(email);

    const session = await createSession(user.id);
    return reply.send({
      user: { id: user.id, email: user.email, display_name: user.display_name },
      session_token: session.token,
      expires_at: session.expiresAt
    });
  });

  app.post("/v1/auth/logout", { preHandler: requireUser }, async (request, reply) => {
    await revokeSession(request.sessionTokenHash!);
    return reply.code(204).send();
  });

  /** The caller and the only organizations they may see or switch to. */
  app.get("/v1/me", { preHandler: requireUser }, async (request, reply) => {
    const rows = await query<any>(
      `SELECT o.*, m.role AS my_role FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 ORDER BY o.created_at ASC`,
      [request.user!.id]
    );
    const organizations: OrganizationMembershipView[] = rows.map((r) => ({ ...rowToOrg(r), my_role: r.my_role }));
    return reply.send({ user: request.user, organizations });
  });
}
