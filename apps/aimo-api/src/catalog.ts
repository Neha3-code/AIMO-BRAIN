import type { AllergenFact } from "@aimo/shared";
import { query } from "./db.js";

export interface CatalogProduct {
  id: string;
  name_en: string;
  category: string | null;
  country_of_origin: string | null;
  allergens: AllergenFact[];
  substitutions: string[];
  carbon_footprint_kg_co2e_per_kg: number | null;
  delivery_reliability: number | null;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Postgres NUMERIC columns come back from the Neon driver as strings; the contract promises numbers. */
function normalize(row: any): CatalogProduct {
  return {
    ...row,
    carbon_footprint_kg_co2e_per_kg: toNumberOrNull(row.carbon_footprint_kg_co2e_per_kg),
    delivery_reliability: toNumberOrNull(row.delivery_reliability)
  };
}

export async function findCatalogCandidates(opts: {
  queryText?: string;
  category?: string;
  maxPriceEur?: number;
  limit?: number;
}): Promise<CatalogProduct[]> {
  const limit = opts.limit ?? 20;
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.queryText) {
    params.push(`%${opts.queryText.toLowerCase()}%`);
    conditions.push(`LOWER(name_en) LIKE $${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    conditions.push(`category = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = await query<any>(
    `SELECT id, name_en, category, country_of_origin, allergens, substitutions, carbon_footprint_kg_co2e_per_kg, delivery_reliability
     FROM products ${where} ORDER BY id LIMIT $${params.length}`,
    params
  );
  return rows.map(normalize);
}

export async function getCatalogProduct(id: string): Promise<CatalogProduct | null> {
  const rows = await query<any>(
    `SELECT id, name_en, category, country_of_origin, allergens, substitutions, carbon_footprint_kg_co2e_per_kg, delivery_reliability
     FROM products WHERE id = $1`,
    [id]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

export async function getCatalogProducts(ids: string[]): Promise<CatalogProduct[]> {
  if (ids.length === 0) return [];
  const rows = await query<any>(
    `SELECT id, name_en, category, country_of_origin, allergens, substitutions, carbon_footprint_kg_co2e_per_kg, delivery_reliability
     FROM products WHERE id = ANY($1)`,
    [ids]
  );
  return rows.map(normalize);
}
