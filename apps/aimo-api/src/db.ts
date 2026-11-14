import { neon } from "@neondatabase/serverless";

// HTTP-based Neon driver: each query is a single HTTPS request, no raw TCP
// connection pool to manage. Fine for this service's volume and plays
// nicely everywhere (serverless or long-running Node alike).
const sql = neon(process.env.DATABASE_URL!);

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  return (await sql(text, params)) as T[];
}
