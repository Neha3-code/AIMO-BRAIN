import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "../src/db.js";
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

async function main() {
  console.log("Reading data files from", REPO_ROOT);
  const carbonMap = parseCsv(path.join(REPO_ROOT, "valio_aimo_junction26_carbon_footprint.csv"));
  const reliabilityMap = parseCsv(path.join(REPO_ROOT, "valio_aimo_junction26_delivery_reliability.csv"));

  const raw = readFileSync(path.join(REPO_ROOT, "valio_aimo_junction26_product_data.json"), "utf-8");
  const products: any[] = JSON.parse(raw);
  console.log(`Loaded ${products.length} products`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE products");

    const BATCH = 500;
    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);
      const values: any[] = [];
      const placeholders: string[] = [];
      batch.forEach((p, idx) => {
        const base = idx * 10;
        const names = p.synkkaData?.names;
        const allergens = extractAllergenFacts(p.synkkaData?.classifications ?? []);
        const substitutions = (p.substitutions ?? []).map((s: any) => s.substituteProduct);
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`
        );
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
          carbonMap.get(p.id) ?? null
        );
      });
      // delivery_reliability appended separately below since it doesn't fit the 10-col pattern cleanly
      const sql = `INSERT INTO products
        (id, name_en, name_fi, name_sv, category, country_of_origin, vendor_name, allowed_lot_size, sales_unit, allergens, substitutions, carbon_footprint_kg_co2e_per_kg)
        VALUES ${placeholders.join(",")}`;
      await client.query(sql, values);

      for (const p of batch) {
        const rel = reliabilityMap.get(p.id);
        if (rel !== undefined) {
          await client.query("UPDATE products SET delivery_reliability = $1 WHERE id = $2", [rel, p.id]);
        }
      }
      console.log(`Seeded ${Math.min(i + BATCH, products.length)}/${products.length}`);
    }

    // Demo buyers — invented for this demo (spec §9 category 3), labeled here explicitly.
    await client.query("TRUNCATE buyers CASCADE");
    await client.query(
      `INSERT INTO buyers (id, display_name, contract_tier, credit_limit_eur, aimo_side_auto_approve_limit_eur) VALUES
        ('k-hotel-espoo', 'Hotel Espoo', 'contract', 5000, 2000),
        ('k-canteen-turku', 'Canteen Turku', 'contract', 1500, 1500)`
    );

    await client.query("COMMIT");
    console.log("Seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
