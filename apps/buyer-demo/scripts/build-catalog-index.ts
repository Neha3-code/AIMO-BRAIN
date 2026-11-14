/**
 * Builds data/catalog-index.json — a compact [id, english name, finnish name] list of every SKU in
 * the Junction26 product file. The LLM proposal layer (lib/llm-catalog.ts) retrieves candidates
 * from this index locally, then fetches live price/stock for the picks through aimo-api, so the
 * 87 MB source file never ships with the app and aimo-api is never bulk-queried.
 *
 *   npx tsx scripts/build-catalog-index.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const products: any[] = JSON.parse(readFileSync(path.join(REPO_ROOT, "valio_aimo_junction26_product_data.json"), "utf-8"));

const nameFor = (p: any, lang: string): string => p.synkkaData?.names?.find((n: any) => n.language === lang)?.value ?? "";

const rows = products
  .filter((p) => !p.deleted)
  .map((p) => [String(p.id), nameFor(p, "en") || String(p.id), nameFor(p, "fi")]);

writeFileSync(path.join(__dirname, "../data/catalog-index.json"), JSON.stringify(rows));
console.log(`Wrote ${rows.length} rows`);
