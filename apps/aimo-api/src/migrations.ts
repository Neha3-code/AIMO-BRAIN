import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "./db.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Splits a migration file into single statements — the HTTP driver runs one per request. */
export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
}

/**
 * Applies every migration file not yet recorded in schema_migrations, in filename order.
 * A file is recorded only after all of its statements succeed. Because a file cannot run in a
 * transaction, statements must be idempotent so a half-applied file can simply be re-run.
 */
export async function runMigrations(log: (msg: string) => void = () => {}): Promise<string[]> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const ran: string[] = [];
  for (const file of listMigrationFiles()) {
    if (applied.has(file)) continue;
    log(`Applying ${file}`);
    for (const statement of splitStatements(readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"))) {
      await query(statement);
    }
    await query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
    ran.push(file);
  }
  return ran;
}
