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

// ---------------------------------------------------------------------------
// Multi-tenant platform contract (PROJECT.md Phase 1). Everything below is
// behind the organizations feature flag; none of it is used by the Junction26
// demo flow above.
// ---------------------------------------------------------------------------

/** An organization is exactly one side of a trade. A legal entity that both buys and sells
 *  registers two organizations, so policy ownership is never ambiguous. */
export type OrgType = "buyer" | "supplier";
export type OrgStatus = "onboarding" | "active" | "suspended";

export const ORG_ROLES = ["org_owner", "org_admin", "buyer_purchaser", "buyer_approver", "supplier_sales", "supplier_approver", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Roles that may exist in each organization type. A buyer organization can never hold a
 *  supplier_* role, and vice versa. */
export const ROLES_BY_ORG_TYPE: Record<OrgType, readonly OrgRole[]> = {
  buyer: ["org_owner", "org_admin", "buyer_purchaser", "buyer_approver", "viewer"],
  supplier: ["org_owner", "org_admin", "supplier_sales", "supplier_approver", "viewer"]
};

/** Only an org_owner may grant, change or remove these roles. */
export const PRIVILEGED_ROLES: readonly OrgRole[] = ["org_owner", "org_admin"];

export const PERMISSIONS = ["org:read", "org:update", "members:read", "members:manage", "policy:read", "policy:write", "audit:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: readonly Permission[] = ["org:read", "members:read", "policy:read"];

/** The permission matrix. Enforced server-side in apps/aimo-api (src/platform/authz.ts); the UI
 *  imports it only to hide controls the server would refuse anyway. */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  org_owner: PERMISSIONS,
  org_admin: PERMISSIONS,
  buyer_purchaser: READ_ONLY,
  buyer_approver: [...READ_ONLY, "audit:read"],
  supplier_sales: READ_ONLY,
  supplier_approver: [...READ_ONLY, "audit:read"],
  viewer: READ_ONLY
};

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface PlatformUser {
  id: string;
  email: string;
  display_name: string;
}

export interface PostalLocation {
  label: string;
  address_line: string;
  postal_code: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  notes?: string;
}

export interface ApprovalContact {
  name: string;
  email: string;
}

export interface BuyerOrgProfile {
  business_id?: string;
  contact_email?: string;
  delivery_locations?: PostalLocation[];
  approval_contacts?: ApprovalContact[];
}

export interface SupplierOrgProfile {
  business_id?: string;
  contact_email?: string;
  service_regions?: string[];
  fulfilment_locations?: PostalLocation[];
  approval_contacts?: ApprovalContact[];
}

export interface OnboardingChecklist {
  profile_complete: boolean;
  policy_configured: boolean;
}

export interface Organization {
  id: string;
  type: OrgType;
  status: OrgStatus;
  legal_name: string;
  display_name: string;
  profile: BuyerOrgProfile | SupplierOrgProfile;
  created_at: string;
  updated_at: string;
}

/** An organization as seen by one of its members. */
export interface OrganizationMembershipView extends Organization {
  my_role: OrgRole;
}

export interface OrgMember {
  user_id: string;
  email: string;
  display_name: string;
  role: OrgRole;
  joined_at: string;
}

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
  status: "pending" | "accepted" | "revoked";
  expires_at: string;
  created_at: string;
}

/** Buyer-owned rules. Mirrors the demo's KitchenPolicy so the same checks can later read from a
 *  tenant-owned version instead of a hardcoded constant. */
export interface BuyerPolicyRules {
  banned_allergen_codes: string[];
  /** null = no buyer-side cap. */
  max_budget_eur: number | null;
  max_delivery_deviation_days: number;
  /** 0–1. */
  min_delivery_reliability: number;
  max_substitute_carbon_increase_pct: number;
  recipe_tolerance: {
    absolute: { fat_g: number; protein_g: number; carbohydrate_g: number; sugar_g: number; salt_g: number };
    relative: number;
  };
}

/** Supplier-owned commercial rules. Per-buyer terms arrive with trading relationships. */
export interface SupplierPolicyRules {
  default_credit_limit_eur: number;
  auto_approve_limit_eur: number;
}

/** One immutable version of an organization's own policy. `side` always equals the owning
 *  organization's type. */
export interface PolicyVersion {
  id: string;
  org_id: string;
  side: OrgType;
  version: number;
  rules: BuyerPolicyRules | SupplierPolicyRules;
  effective_from: string;
  change_note: string | null;
  created_by: string;
  created_at: string;
}

export interface OrgAuditEvent {
  id: string;
  org_id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: Record<string, unknown>;
  correlation_id: string | null;
  created_at: string;
}

/** Binding policy results (PROJECT.md §6). `error` is never treated as `pass`. Declared here as
 *  the target vocabulary; the demo flow does not emit it yet. */
export type PolicyResult = "pass" | "manual_review" | "reject" | "error";
