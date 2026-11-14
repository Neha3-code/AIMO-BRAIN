import type { AllergenFact, QuoteAlternative, QuoteLine } from "@aimo/shared";
import { POLICY_VERSION_BUYER } from "@aimo/shared";

/**
 * Buyer-side guardrail. Runs entirely on the kitchen's own data — it never
 * reads or imports anything from apps/aimo-api. Aimo discloses raw GS1
 * allergen codes on every option (see apps/aimo-api/src/allergens.ts for why
 * they're left untranslated); it's the BUYER's own kitchen that knows what
 * those codes mean for its own compliance rules. The code->label mapping
 * below and the specific banned codes are invented for this demo (see
 * README §9) — a real kitchen would sync this from its own allergen
 * register, not hardcode it.
 */
export interface KitchenPolicy {
  bannedAllergenCodes: string[]; // codes this kitchen's menu must never contain
  maxBudgetEur: number | null; // null = no local cap, defer to Aimo-side credit check
}

export const HOTEL_ESPOO_POLICY: KitchenPolicy = {
  // AW = tree nuts (this kitchen's own internal translation of the GS1 code).
  bannedAllergenCodes: ["AW"],
  maxBudgetEur: null
};

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  policyVersion: string;
}

function violatesBan(allergens: AllergenFact[], banned: string[]): string[] {
  return allergens.filter((a) => a.relation === "CONTAINS" && banned.includes(a.code)).map((a) => a.code);
}

/** Applied strictly buyer-side, AFTER the HTTP response comes back from Aimo. */
export function checkCompliance(policy: KitchenPolicy, lines: QuoteLine[]): PolicyDecision {
  const reasons: string[] = [];

  for (const line of lines) {
    if (line.status === "available") continue;
    for (const alt of line.alternatives) {
      const hits = violatesBan(alt.allergens, policy.bannedAllergenCodes);
      if (hits.length > 0) {
        reasons.push(`Alternative ${alt.product_id} (${alt.name}) rejected: contains banned allergen code(s) ${hits.join(", ")}.`);
      }
    }
  }

  return { allowed: reasons.length === 0, reasons, policyVersion: POLICY_VERSION_BUYER };
}

/** Picks the best allowed alternative for an unavailable line, by Aimo's own rank, filtered by this kitchen's own policy. */
export function pickAllowedAlternative(policy: KitchenPolicy, alternatives: QuoteAlternative[]): { chosen: QuoteAlternative | null; rejected: { alt: QuoteAlternative; reason: string }[] } {
  const rejected: { alt: QuoteAlternative; reason: string }[] = [];
  const sorted = [...alternatives].sort((a, b) => a.rank - b.rank);

  for (const alt of sorted) {
    const hits = violatesBan(alt.allergens, policy.bannedAllergenCodes);
    if (hits.length > 0) {
      rejected.push({ alt, reason: `Contains banned allergen code(s) ${hits.join(", ")} per this kitchen's policy.` });
      continue;
    }
    return { chosen: alt, rejected };
  }
  return { chosen: null, rejected };
}

export function checkBudget(policy: KitchenPolicy, totalEur: number): PolicyDecision {
  if (policy.maxBudgetEur === null || totalEur <= policy.maxBudgetEur) {
    return { allowed: true, reasons: [], policyVersion: POLICY_VERSION_BUYER };
  }
  return {
    allowed: false,
    reasons: [`Order total €${totalEur.toFixed(2)} exceeds this kitchen's own budget cap of €${policy.maxBudgetEur.toFixed(2)}.`],
    policyVersion: POLICY_VERSION_BUYER
  };
}
