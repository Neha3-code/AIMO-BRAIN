/**
 * Extracts the static "recipe chemistry" and package-weight facts from the
 * 87 MB challenge product file into a compact file the API loads at startup
 * (apps/aimo-api/data/product-facts.json, ~1 MB, committed).
 *
 * Why a generated file instead of new Neon columns: these are static,
 * read-only facts straight from the challenge export (same provenance as the
 * seeded catalog), and shipping them with the code means the API can be
 * redeployed without a schema migration + re-seed of the live database.
 *
 *   npm run build-facts -w @aimo/aimo-api
 *
 * Output row format (positional, to keep the file small):
 *   [fat_g, protein_g, carbohydrate_g, sugar_g, salt_g, lactose_g, net_weight_kg_per_sales_unit]
 * Composition values are per 100 g / 100 ml as declared in the product's own
 * GS1/Synkka nutritionalContent; any value can be null when not declared.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const OUT = path.resolve(__dirname, "../data/product-facts.json");

const NUTRIENT_IDS = ["FAT", "PRO-", "CHOAVL", "SUGAR-", "SALTEQ", "LACS"] as const;

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function composition(p: any): (number | null)[] {
  const byId = new Map<string, number>();
  for (const n of p.synkkaData?.nutritionalContent ?? []) {
    // Only gram-denominated values on a mass/volume basis; per-portion ("PTN")
    // declarations can't be compared across products, so they're skipped.
    if (n.unit !== "GRM" || typeof n.value !== "number") continue;
    if (n.basisQuantityUnit !== "GRM" && n.basisQuantityUnit !== "MLT") continue;
    if (!n.basisQuantity) continue;
    if (!byId.has(n.id)) byId.set(n.id, round((n.value * 100) / n.basisQuantity));
  }
  return NUTRIENT_IDS.map((id) => byId.get(id) ?? null);
}

function netWeightKg(p: any): number | null {
  const levels: any[] = p.synkkaData?.unitConversions ?? [];
  if (levels.length !== 1) return null;
  const level = levels[0];
  // A sales unit that differs from the base unit is a case; only trust a CASE
  // weight for it. PALLET-level weights are not a per-sales-unit figure.
  if (level.synkkaPackagingType === "PALLET") return null;
  if (p.salesUnit !== p.baseUnit && level.synkkaPackagingType !== "CASE") return null;
  const w = level.netWeight;
  if (!w || typeof w.value !== "number") return null;
  if (w.unit === "GRM") return round(w.value / 1000, 4);
  if (w.unit === "KGM") return round(w.value, 4);
  return null;
}

const products: any[] = JSON.parse(readFileSync(path.join(REPO_ROOT, "valio_aimo_junction26_product_data.json"), "utf-8"));
const out: Record<string, (number | null)[]> = {};
let withComposition = 0;
let withWeight = 0;
for (const p of products) {
  const comp = composition(p);
  const weight = netWeightKg(p);
  if (comp.some((v) => v !== null)) withComposition++;
  if (weight !== null) withWeight++;
  if (comp.every((v) => v === null) && weight === null) continue;
  out[p.id] = [...comp, weight];
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${Object.keys(out).length} rows to ${OUT} (${withComposition} with composition, ${withWeight} with net weight).`);
