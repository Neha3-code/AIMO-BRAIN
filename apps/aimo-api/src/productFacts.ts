import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ProductFacts, RecipeComposition } from "@aimo/shared";
import type { CatalogProduct } from "./catalog.js";

/**
 * Composition + package weight, generated from the challenge product file by
 * scripts/build-product-facts.ts (see that file for why it ships as a file
 * rather than as database columns). Loaded once, lazily.
 */
const FACTS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/product-facts.json");

type Row = [number | null, number | null, number | null, number | null, number | null, number | null, number | null];
let cache: Record<string, Row> | null = null;

function table(): Record<string, Row> {
  if (!cache) cache = JSON.parse(readFileSync(FACTS_PATH, "utf-8"));
  return cache!;
}

export function compositionFor(productId: string): RecipeComposition | null {
  const row = table()[productId];
  if (!row || row.slice(0, 6).every((v) => v === null)) return null;
  const [fat_g, protein_g, carbohydrate_g, sugar_g, salt_g, lactose_g] = row;
  return { fat_g, protein_g, carbohydrate_g, sugar_g, salt_g, lactose_g };
}

export function netWeightKgFor(productId: string): number | null {
  return table()[productId]?.[6] ?? null;
}

export function productFacts(productId: string, catalog: CatalogProduct | undefined | null): ProductFacts {
  return {
    category: catalog?.category ?? null,
    carbon_footprint_kg_co2e_per_kg: catalog?.carbon_footprint_kg_co2e_per_kg ?? null,
    delivery_reliability: catalog?.delivery_reliability ?? null,
    net_weight_kg_per_sales_unit: netWeightKgFor(productId),
    composition: compositionFor(productId)
  };
}
