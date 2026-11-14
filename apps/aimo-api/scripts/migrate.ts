import "dotenv/config";
import { pool } from "../src/db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_fi TEXT,
  name_sv TEXT,
  category TEXT,
  country_of_origin TEXT,
  vendor_name TEXT,
  allowed_lot_size NUMERIC,
  sales_unit TEXT,
  allergens JSONB NOT NULL DEFAULT '[]',
  substitutions JSONB NOT NULL DEFAULT '[]',
  carbon_footprint_kg_co2e_per_kg NUMERIC,
  delivery_reliability NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_name_en ON products USING gin (to_tsvector('simple', name_en));

CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  contract_tier TEXT NOT NULL,
  credit_limit_eur NUMERIC NOT NULL,
  aimo_side_auto_approve_limit_eur NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES buyers(id),
  lines JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  total_eur NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  buyer_id TEXT NOT NULL REFERENCES buyers(id),
  status TEXT NOT NULL,
  approval_required BOOLEAN NOT NULL,
  approval_owner TEXT,
  approval_reason TEXT,
  requested_amount_eur NUMERIC,
  approved_amount_eur NUMERIC,
  lines_confirmed JSONB NOT NULL DEFAULT '[]',
  lines_held JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_order_id ON audit_events (order_id);
`;

async function main() {
  await pool.query(SCHEMA);
  console.log("Migration complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
