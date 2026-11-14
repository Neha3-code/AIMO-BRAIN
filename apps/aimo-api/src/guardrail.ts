import { POLICY_VERSION_AIMO } from "@aimo/shared";

export interface AimoGuardrailInput {
  totalEur: number;
  buyer: { credit_limit_eur: number; aimo_side_auto_approve_limit_eur: number };
}

export interface AimoGuardrailResult {
  requiresApproval: boolean;
  reason: string | null;
  policyVersion: string;
}

/**
 * Aimo's OWN commercial guardrail. Deliberately has no access to a buyer's
 * allergen/dietary policy — it only knows about Aimo's own commercial risk
 * (credit limit, auto-approve ceiling). Keep this file and its inputs
 * separate from apps/buyer-demo/lib/policyEngine.ts; do not merge them.
 */
export function checkAimoGuardrail(input: AimoGuardrailInput): AimoGuardrailResult {
  const { totalEur, buyer } = input;

  if (totalEur > buyer.credit_limit_eur) {
    return {
      requiresApproval: true,
      reason: `Order total €${totalEur.toFixed(2)} exceeds buyer's standing credit limit of €${buyer.credit_limit_eur.toFixed(2)} without manual review.`,
      policyVersion: POLICY_VERSION_AIMO
    };
  }

  if (totalEur > buyer.aimo_side_auto_approve_limit_eur) {
    return {
      requiresApproval: true,
      reason: `Order total €${totalEur.toFixed(2)} exceeds Aimo's auto-approval ceiling of €${buyer.aimo_side_auto_approve_limit_eur.toFixed(2)} for this buyer.`,
      policyVersion: POLICY_VERSION_AIMO
    };
  }

  return { requiresApproval: false, reason: null, policyVersion: POLICY_VERSION_AIMO };
}
