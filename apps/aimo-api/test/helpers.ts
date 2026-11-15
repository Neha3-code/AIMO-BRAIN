import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setQueryRunner } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";

export const DEMO_KEYS = { hotel: "test-key-hotel", canteen: "test-key-canteen" };

export interface TestContext {
  app: FastifyInstance;
  db: PGlite;
  close(): Promise<void>;
}

/** A fresh in-process Postgres with the real migrations applied, and the real Fastify app on top.
 *  Nothing here touches Neon or the Junction26 upstream. */
export async function createTestContext(opts: { organizations?: boolean } = {}): Promise<TestContext> {
  const db = new PGlite();
  setQueryRunner(async (text, params) => (await db.query(text, params)).rows);
  await runMigrations();
  process.env.AIMO_BUYER_API_KEYS = `${DEMO_KEYS.hotel}:k-hotel-espoo,${DEMO_KEYS.canteen}:k-canteen-turku`;
  const config = loadConfig({
    DATABASE_URL: "pglite://in-memory",
    AIMO_UPSTREAM_API_KEY: "unused-in-tests",
    AIMO_BUYER_API_KEYS: process.env.AIMO_BUYER_API_KEYS,
    AIMO_FEATURE_ORGS: opts.organizations === false ? "0" : "1"
  });
  const app = buildApp(config, { logger: false });
  await app.ready();
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.close();
      setQueryRunner(null);
    }
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export async function call<T = any>(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  opts: { token?: string; apiKey?: string; body?: unknown } = {}
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const res = await app.inject({ method, url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers };
}

export const PASSWORD = "correct horse battery";

export async function signup(app: FastifyInstance, email: string): Promise<{ token: string; userId: string; email: string }> {
  const res = await call(app, "POST", "/v1/auth/signup", { body: { email, password: PASSWORD, display_name: email.split("@")[0] } });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.session_token, userId: res.body.user.id, email };
}

export async function createOrg(app: FastifyInstance, token: string, type: "buyer" | "supplier", name: string): Promise<string> {
  const res = await call(app, "POST", "/v1/organizations", { token, body: { type, legal_name: `${name} Oy`, display_name: name } });
  if (res.status !== 201) throw new Error(`createOrg failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** Invites `email` into the org with `role` and has that (already signed-up) user accept. */
export async function addMember(app: FastifyInstance, ownerToken: string, orgId: string, member: { token: string; email: string }, role: string): Promise<void> {
  const inv = await call(app, "POST", `/v1/organizations/${orgId}/invitations`, { token: ownerToken, body: { email: member.email, role } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await call(app, "POST", "/v1/invitations/accept", { token: member.token, body: { token: inv.body.accept_token } });
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
}

export const BUYER_RULES = {
  banned_allergen_codes: ["AW"],
  max_budget_eur: 2500,
  max_delivery_deviation_days: 1,
  min_delivery_reliability: 0.95,
  max_substitute_carbon_increase_pct: 20,
  recipe_tolerance: { absolute: { fat_g: 2, protein_g: 1.5, carbohydrate_g: 2.5, sugar_g: 2.5, salt_g: 0.3 }, relative: 0.1 }
};

export const SUPPLIER_RULES = { default_credit_limit_eur: 5000, auto_approve_limit_eur: 2000 };
