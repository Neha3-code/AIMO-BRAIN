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
  };
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
  /** Trust envelope backing the requested product's own price/availability claim. */
  envelope: TrustEnvelope<ProductPriceClaim>;
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
