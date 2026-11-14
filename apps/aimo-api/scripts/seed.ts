import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "../src/db.js";
import { extractAllergenFacts } from "../src/allergens.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Data files live at the repo root, as committed by the challenge export.
const REPO_ROOT = path.resolve(__dirname, "../../../");

function parseCsv(filePath: string): Map<string, number> {
  const text = readFileSync(filePath, "utf-8");
  const lines = text.trim().split("\n");
  const map = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const [id, value] = line.split(",");
    if (id && value !== undefined && value !== "") {
      map.set(id.trim(), Number(value));
    }
  }
  return map;
}

function nameFor(names: { language: string; value: string }[] | undefined, lang: string): string | null {
  return names?.find((n) => n.language === lang)?.value ?? null;
}

const COLS = 13;

async function main() {
  console.log("Reading data files from", REPO_ROOT);
  const carbonMap = parseCsv(path.join(REPO_ROOT, "valio_aimo_junction26_carbon_footprint.csv"));
  const reliabilityMap = parseCsv(path.join(REPO_ROOT, "valio_aimo_junction26_delivery_reliability.csv"));

  const raw = readFileSync(path.join(REPO_ROOT, "valio_aimo_junction26_product_data.json"), "utf-8");
  const products: any[] = JSON.parse(raw);
  console.log(`Loaded ${products.length} products`);

  await query("TRUNCATE products");

  const BATCH = 500;
  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const values: any[] = [];
    const placeholders: string[] = [];
    batch.forEach((p, idx) => {
      const base = idx * COLS;
      const names = p.synkkaData?.names;
      const allergens = extractAllergenFacts(p.synkkaData?.classifications ?? []);
      const substitutions = (p.substitutions ?? []).map((s: any) => s.substituteProduct);
      const slots = Array.from({ length: COLS }, (_, j) => `$${base + j + 1}`).join(",");
      placeholders.push(`(${slots})`);
      values.push(
        p.id,
        nameFor(names, "en") ?? p.id,
        nameFor(names, "fi"),
        nameFor(names, "sv"),
        p.category ?? null,
        p.countryOfOrigin ?? null,
        p.vendorName ?? null,
        p.allowedLotSize ?? null,
        p.salesUnit ?? null,
        JSON.stringify(allergens),
        JSON.stringify(substitutions),
        carbonMap.get(p.id) ?? null,
        reliabilityMap.get(p.id) ?? null
      );
    });

    const sql = `INSERT INTO products
      (id, name_en, name_fi, name_sv, category, country_of_origin, vendor_name, allowed_lot_size, sales_unit, allergens, substitutions, carbon_footprint_kg_co2e_per_kg, delivery_reliability)
      VALUES ${placeholders.join(",")}`;
    await query(sql, values);
    console.log(`Seeded ${Math.min(i + BATCH, products.length)}/${products.length}`);
  }

  // Demo buyers — invented for this demo (spec §9 category 3), labeled here explicitly.
  await query("TRUNCATE buyers CASCADE");
  await query(
    `INSERT INTO buyers (id, display_name, contract_tier, credit_limit_eur, aimo_side_auto_approve_limit_eur) VALUES
      ('k-hotel-espoo', 'Hotel Espoo', 'contract', 5000, 2000),
      ('k-canteen-turku', 'Canteen Turku', 'contract', 1500, 1500)`
  );

  console.log("Seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
