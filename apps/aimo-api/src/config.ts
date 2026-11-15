import { z } from "zod";

const flag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const EnvSchema = z.object({
  AIMO_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(8080),
  AIMO_UPSTREAM_API_KEY: z.string().optional(),
  AIMO_BUYER_API_KEYS: z.string().optional(),
  AIMO_FEATURE_ORGS: flag
});

export interface AppConfig {
  /** `sandbox` is the only environment this build can run in — see loadConfig. */
  environment: "sandbox";
  port: number;
  features: {
    /** Phase 1 organizations, memberships, RBAC and tenant-owned policies. Off by default. */
    organizations: boolean;
  };
  warnings: string[];
}

/**
 * Validates configuration once at startup and is the sandbox/production boundary.
 *
 * AIMO_ENV=production is refused outright: this build has no production supplier connector, no
 * order submission to a real supplier and none of the PROJECT.md Phase 2 launch gates, so there
 * is nothing "production" could safely mean. Every order this service records is a row in its
 * own database against the Junction26 challenge sandbox.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  if (e.AIMO_ENV === "production") {
    throw new Error(
      "AIMO_ENV=production is not available in this build: there is no production supplier connector or order submission, and the Phase 2 launch gates have not been met. Use AIMO_ENV=sandbox."
    );
  }
  const warnings: string[] = [];
  if (!e.AIMO_UPSTREAM_API_KEY) warnings.push("AIMO_UPSTREAM_API_KEY is not set: product, quote and substitute routes will fail against the Junction26 sandbox.");
  if (!e.AIMO_BUYER_API_KEYS) warnings.push("AIMO_BUYER_API_KEYS is not set: no demo buyer agent can authenticate.");
  return { environment: "sandbox", port: e.PORT, features: { organizations: e.AIMO_FEATURE_ORGS }, warnings };
}
