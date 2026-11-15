import { neon } from "@neondatabase/serverless";

export type QueryRunner = (text: string, params: any[]) => Promise<any[]>;

// HTTP-based Neon driver: each query is a single HTTPS request, no raw TCP
// connection pool to manage. Fine for this service's volume and plays
// nicely everywhere (serverless or long-running Node alike).
//
// Consequence worth knowing: there are no interactive transactions. Anything
// that must be atomic is written as ONE statement (data-modifying CTEs).
let runner: QueryRunner | null = null;

function defaultRunner(): QueryRunner {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const sql = neon(url);
  return async (text, params) => (await sql(text, params)) as any[];
}

/** Tests swap in an in-process Postgres (PGlite) so the real SQL runs without a network. */
export function setQueryRunner(next: QueryRunner | null): void {
  runner = next;
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  runner ??= defaultRunner();
  return (await runner(text, params)) as T[];
}
