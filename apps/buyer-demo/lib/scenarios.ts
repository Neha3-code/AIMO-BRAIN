import { createAimoClient, type AimoClient } from "./aimoClient";
import { HOTEL_ESPOO_POLICY, checkCompliance, pickAllowedAlternative } from "./policyEngine";
import type { QuoteLine } from "@aimo/shared";

export interface ScenarioStep {
  label: string;
  detail: string;
  data?: unknown;
}

export interface ScenarioResult {
  name: string;
  steps: ScenarioStep[];
  ok: boolean;
}

function log(steps: ScenarioStep[], label: string, detail: string, data?: unknown) {
  steps.push({ label, detail, data });
}

export function buildClient(): AimoClient {
  const baseUrl = process.env.AIMO_API_BASE_URL ?? "http://localhost:8080";
  const apiKey = process.env.AIMO_API_KEY ?? "demo-key-hotel-espoo";
  return createAimoClient({ baseUrl, apiKey });
}

const BUYER_ID = process.env.BUYER_ID ?? "k-hotel-espoo";

/** Scenario 1 — autonomous purchasing, happy path. Mirrors the brief's own example almost verbatim. */
export async function scenario1Autonomous(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Scenario 1 — Autonomous purchasing (happy path)";

  log(steps, "request", "Kitchen request: 1,000 litres of lactose-free milk by Monday, price/availability-driven choice.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 1000 }]);
  log(steps, "quote", `Quote ${quote.quote_id} issued, expires ${quote.expires_at}. Total €${quote.total_eur.toFixed(2)}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  log(steps, "buyer_policy", compliance.allowed ? "Buyer policy engine: no violations." : `Buyer policy engine rejected: ${compliance.reasons.join(" ")}`);

  if (!compliance.allowed) return { name, steps, ok: false };

  const order = await client.placeOrder(quote.quote_id);
  log(steps, "order", `Order ${order.order_id} status: ${order.status}.`, order);

  const audit = await client.getAuditTrail(order.order_id);
  log(steps, "audit", "Full audit trail retrieved.", audit);

  return { name, steps, ok: order.status === "confirmed" };
}

/** Scenario 2 — two-sided approval. Order exceeds the buyer's Aimo-side credit limit; Aimo holds it, a human on Aimo's side clears it. */
export async function scenario2TwoSidedApproval(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Scenario 2 — Two-sided approval (autonomy and controls)";

  log(steps, "request", "Kitchen requests a large replenishment order that will exceed its Aimo-side credit limit.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 4520 }]);
  log(steps, "quote", `Quote ${quote.quote_id} issued. Total €${quote.total_eur.toFixed(2)}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  log(steps, "buyer_policy", compliance.allowed ? "Buyer policy engine clears the product selection." : `Buyer policy rejected: ${compliance.reasons.join(" ")}`);
  if (!compliance.allowed) return { name, steps, ok: false };

  let order = await client.placeOrder(quote.quote_id);
  log(
    steps,
    "order",
    order.status === "held_for_approval"
      ? `Aimo-side guardrail HELD the order. owner=${order.approval.owner}. Reason: ${order.approval.reason}`
      : `Order confirmed directly: ${order.order_id}`,
    order
  );

  if (order.status === "held_for_approval") {
    // A buyer's agent must NOT be able to clear an Aimo-owned hold — proves the governance boundary.
    try {
      await client.approveOrder(order.order_id, "human:buyer");
      log(steps, "governance_check", "ERROR: buyer-side approval was incorrectly accepted for an Aimo-owned hold.");
    } catch (err) {
      log(steps, "governance_check", `Confirmed: a buyer-side human cannot clear this Aimo-owned hold (${(err as Error).message}).`);
    }

    order = await client.approveOrder(order.order_id, "human:aimo");
    log(steps, "approval", `Aimo-side human approved. Order status now: ${order.status}.`, order);
  }

  const audit = await client.getAuditTrail(order.order_id);
  log(steps, "audit", "Full audit trail retrieved.", audit);

  return { name, steps, ok: order.status === "confirmed" };
}

/** Scenario 3 — stock-out and substitution. Finds whichever currently-unavailable product (from a curated candidate
 *  list of products with real substitution chains) demonstrates the ranked, fully-disclosed alternative list, then
 *  applies the kitchen's own policy to pick (or reject) from it. The specific SKU that trips "unavailable" can change
 *  day to day on the real upstream mock backend, so this probes several real candidates rather than hardcoding one. */
const SUBSTITUTION_CANDIDATES = ["468928", "469290", "460131", "460189", "460541", "461101", "463437", "471068"];

export async function scenario3StockOutSubstitution(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Scenario 3 — Stock-out and substitution (robustness)";

  const quote = await client.requestQuote(
    BUYER_ID,
    SUBSTITUTION_CANDIDATES.map((id) => ({ product_id: id, qty: 10 }))
  );
  log(steps, "quote", `Quote ${quote.quote_id} requested across ${SUBSTITUTION_CANDIDATES.length} candidate SKUs.`, quote);

  const unavailable: QuoteLine | undefined = quote.lines.find((l) => l.status === "unavailable" && l.alternatives.length > 0);
  if (!unavailable) {
    log(steps, "result", "All candidate SKUs were in stock on the real upstream backend at demo time — nothing to substitute right now.");
    return { name, steps, ok: true };
  }

  log(
    steps,
    "stock_out",
    `Requested product ${unavailable.requested_product_id} is unavailable. Aimo discloses ${unavailable.alternatives.length} ranked alternative(s), allergens included, no buyer-policy filtering applied.`,
    unavailable.alternatives
  );

  const { chosen, rejected } = pickAllowedAlternative(HOTEL_ESPOO_POLICY, unavailable.alternatives);
  for (const r of rejected) {
    log(steps, "buyer_policy_rejection", `Rank ${r.alt.rank} alternative ${r.alt.product_id} (${r.alt.name}) rejected: ${r.reason}`);
  }

  if (chosen) {
    log(steps, "chosen", `Buyer agent selects rank ${chosen.rank}: ${chosen.product_id} (${chosen.name}) — the best-ranked option that passes this kitchen's own policy.`);
  } else {
    log(steps, "no_viable_option", "No disclosed alternative passes this kitchen's policy. Buyer agent reports this honestly instead of silently picking the cheapest option.");
  }

  return { name, steps, ok: true };
}

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const client = buildClient();
  return [await scenario1Autonomous(client), await scenario2TwoSidedApproval(client), await scenario3StockOutSubstitution(client)];
}
