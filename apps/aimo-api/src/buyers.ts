import { query } from "./db.js";

export interface Buyer {
  id: string;
  display_name: string;
  contract_tier: string;
  credit_limit_eur: number;
  aimo_side_auto_approve_limit_eur: number;
}

export async function getBuyer(id: string): Promise<Buyer | null> {
  const rows = await query<Buyer>("SELECT * FROM buyers WHERE id = $1", [id]);
  return rows[0] ?? null;
}
