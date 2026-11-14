// Shared types between the Aimo-side API (apps/aimo-api) and the reference
// buyer-agent (apps/buyer-demo). Keep this free of any runtime dependency on
// either app so it stays a pure contract.

export type VerificationStatus = "mock_verified";

export interface TrustEnvelope<TClaim> {
  claim: TClaim;
  provenance: {
    issuer: "Valio Aimo";
    source_system: string;
    observed_at: string; // ISO 8601
  };
  validity: {
    expires_at: string; // ISO 8601
  };
  verification: {
    status: VerificationStatus;
    reference_id: string;
  };
}

export interface ProductPriceClaim {
  product_id: string;
  price: { amount: number; currency: string; unit: string } | null;
  availability: {
    status: "in_stock" | "out_of_stock" | "unknown" | "terminal_supplier";
    quantity: number | null;
    /** The date the upstream schedule actually confirms the goods for, which can differ
     *  from the buyer's requested date — null if no schedule line was returned at all. */
    confirmed_available_date: string | null;
  };
}

/** Declared nutritional composition per 100 g (or 100 ml) from the product's own GS1/Synkka
 *  nutritionalContent — the functional "recipe chemistry" of an ingredient. Any value can be
 *  null when the product doesn't declare it. */
export interface RecipeComposition {
  fat_g: number | null;
  protein_g: number | null;
  carbohydrate_g: number | null;
  sugar_g: number | null;
  salt_g: number | null;
  lactose_g: number | null;
}

/** Static, challenge-supplied facts Aimo discloses on every product, quote line and alternative —
 *  disclosed, not judged: what counts as "too much carbon" or "breaks my recipe" is the buyer's call. */
export interface ProductFacts {
  category: string | null;
  /** Average kg CO2-eq per kg of product (challenge carbon footprint file). */
  carbon_footprint_kg_co2e_per_kg: number | null;
  /** Historical share of deliveries delivered as promised, 0–1 (challenge delivery reliability file).
   *  null = no delivery history for this SKU. */
  delivery_reliability: number | null;
  /** Net weight of one sales unit in kg, from the product's packaging data — lets a buyer turn
   *  CO2-eq/kg into an order-level footprint. */
  net_weight_kg_per_sales_unit: number | null;
  composition: RecipeComposition | null;
}

export interface ProductLookupResult {
  envelope: TrustEnvelope<ProductPriceClaim>;
  name: string;
  category: string;
  country_of_origin: string | null;
  allergens: AllergenFact[];
  sustainability_labels: string[];
  carbon_footprint_kg_co2e_per_kg: number | null;
  delivery_reliability: number | null;
  delivery_lead_time_days: number | null;
  net_weight_kg_per_sales_unit?: number | null;
  composition?: RecipeComposition | null;
  /** How many substitutes the catalog registers for this product. Only ~1 % of the catalog has any,
   *  so a buyer UI can say so upfront instead of letting the user discover an empty list. */
  registered_substitute_count?: number;
}

export interface AllergenFact {
  code: string;
  relation: "CONTAINS" | "FREE_FROM";
  /** Best-effort human label for known GS1 codes; null if we don't have a confident mapping. */
  label: string | null;
}

export type QuoteLineStatus = "available" | "unavailable";

export interface QuoteAlternative {
  rank: number;
  product_id: string;
  name: string;
  price_eur: number | null;
  availability: ProductPriceClaim["availability"];
  delivery_lead_time_days: number | null;
  allergens: AllergenFact[];
  /** Carbon, delivery reliability and composition facts — optional only because servers
   *  older than this contract version don't send them. */
  facts?: ProductFacts;
  /** The underlying trust-enveloped claim this ranking/price is based on, for display. */
  envelope: TrustEnvelope<ProductPriceClaim>;
}

export interface QuoteLine {
  requested_product_id: string;
  requested_product_name: string;
  requested_qty: number;
  status: QuoteLineStatus;
  unit_price_eur: number | null;
  line_total_eur: number | null;
  alternatives: QuoteAlternative[];
  /** How Aimo ordered `alternatives` (its own commercial attributes only). */
  alternatives_ranking?: string;
  /** Facts for the requested product itself (see QuoteAlternative.facts). */
  facts?: ProductFacts;
  /** Allergens of the requested product itself — disclosed so the buyer can check the product it's
   *  actually about to purchase, not just its substitution alternatives. Optional only because
   *  servers older than this contract version don't send it. */
  allergens?: AllergenFact[];
  /** Trust envelope backing the requested product's own price/availability claim. */
  envelope: TrustEnvelope<ProductPriceClaim>;
}

/** GET /v1/products/:id/substitutes — the product's registered substitutes, disclosed ahead of
 *  any stock-out so a buyer agent can pre-qualify a backup. */
export interface SubstitutesResponse {
  product_id: string;
  name: string;
  facts: ProductFacts;
  envelope: TrustEnvelope<ProductPriceClaim>;
  alternatives_ranking: string;
  alternatives: QuoteAlternative[];
}

export interface Quote {
  quote_id: string;
  buyer_id: string;
  issued_at: string;
  expires_at: string;
  requested_delivery_date: string;
  status: "active" | "expired" | "consumed";
  lines: QuoteLine[];
  total_eur: number;
}

export type ApprovalOwner = "buyer" | "aimo";

export interface OrderApproval {
  required: boolean;
  owner: ApprovalOwner | null;
  reason: string | null;
  requested_amount_eur: number | null;
  approved_amount_eur: number | null;
}

export type OrderStatus = "confirmed" | "held_for_approval" | "rejected";

export interface Order {
  order_id: string;
  quote_id: string;
  buyer_id: string;
  status: OrderStatus;
  approval: OrderApproval;
  lines_confirmed: QuoteLine[];
  lines_held: QuoteLine[];
  created_at: string;
  updated_at: string;
}

export type AuditActor = "buyer_agent" | "aimo_api" | "human:buyer" | "human:aimo";

export interface AuditEvent {
  order_id: string;
  timestamp: string;
  actor: AuditActor;
  action: string;
  reasons: string[];
  policy_version: string;
}

export const POLICY_VERSION_AIMO = "aimo-guardrail-v1";
export const POLICY_VERSION_BUYER = "buyer-policy-v1";
