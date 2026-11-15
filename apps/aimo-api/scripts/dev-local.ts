// Local preview of the organizations workspace with NO external services: an in-memory Postgres
// (PGlite) with the real migrations applied. Data is lost on exit. The catalogue is not seeded
// and the Junction26 upstream is not configured, so the demo's product, quote and order routes
// are not usable here — use `npm run dev:api` with a real DATABASE_URL for those.
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setQueryRunner } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";

const db = new PGlite();
setQueryRunner(async (text, params) => (await db.query(text, params)).rows);
await runMigrations(console.log);

const config = loadConfig({ ...process.env, DATABASE_URL: "pglite://in-memory", AIMO_ENV: "sandbox", AIMO_FEATURE_ORGS: "1" });
const app = buildApp(config);
await app.listen({ port: config.port, host: "127.0.0.1" });
app.log.info("In-memory preview: organizations enabled, nothing is persisted.");
