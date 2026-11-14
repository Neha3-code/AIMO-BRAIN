import { createAimoClient, type AimoClient } from "./aimoClient";
import { HOTEL_ESPOO_POLICY, checkCompliance, pickAllowedAlternative } from "./policyEngine";
import type { AuditEvent, Order, Quote, QuoteLine } from "@aimo/shared";

export type Stage = "request" | "quote" | "buyer_policy" | "aimo_policy" | "approval" | "audit" | "result";
export type StepStatus = "complete" | "passed" | "blocked" | "human_review" | "pending" | "rejected" | "info";

export interface ScenarioStep {
  stage: Stage;
  status: StepStatus;
  title: string;
  detail: string;
  data?: unknown;
}

export interface PolicyPanel {
  status: StepStatus;
  reason: string;
}

export interface ScenarioResult {
  id: string;
  name: string;
  tagline: string;
  transactionId: string | null;
  ok: boolean;
  steps: ScenarioStep[];
  buyerPolicy: PolicyPanel | null;
  aimoPolicy: PolicyPanel | null;
  quote: Quote | null;
  order: Order | null;
  audit: AuditEvent[];
}

function step(steps: ScenarioStep[], stage: Stage, status: StepStatus, title: string, detail: string, data?: unknown) {
  steps.push({ stage, status, title, detail, data });
}

export function buildClient(): AimoClient {
  const baseUrl = process.env.AIMO_API_BASE_URL ?? "http://localhost:8080";
  const apiKey = process.env.AIMO_API_KEY ?? "demo-key-hotel-espoo";
  return createAimoClient({ baseUrl, apiKey });
}

const BUYER_ID = process.env.BUYER_ID ?? "k-hotel-espoo";

async function finish(
  steps: ScenarioStep[],
  id: string,
  name: string,
  tagline: string,
  opts: { ok: boolean; quote: Quote | null; order: Order | null; buyerPolicy: PolicyPanel | null; aimoPolicy: PolicyPanel | null },
  client: AimoClient
): Promise<ScenarioResult> {
  let audit: AuditEvent[] = [];
  if (opts.order) {
    step(steps, "audit", "info", "Audit trail retrieved", `Full, append-only trace for order ${opts.order.order_id}.`);
    const trail = await client.getAuditTrail(opts.order.order_id);
    audit = trail.events;
  }
  return {
    id,
    name,
    tagline,
    transactionId: opts.order?.order_id ?? opts.quote?.quote_id ?? null,
    ok: opts.ok,
    steps,
    buyerPolicy: opts.buyerPolicy,
    aimoPolicy: opts.aimoPolicy,
    quote: opts.quote,
    order: opts.order,
    audit
  };
}

/** Scenario 1 — autonomous purchasing, happy path. Mirrors the brief's own example almost verbatim. */
export async function scenario1Autonomous(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Autonomous purchasing";
  const tagline = "Happy path";

  step(steps, "request", "complete", "Buyer request received", "1,000 litres of lactose-free milk, by Monday, price/availability-driven choice.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 1000 }]);
  step(steps, "quote", "complete", "Product search and quote", `Quote ${quote.quote_id} issued, expires ${quote.expires_at}. Total €${quote.total_eur.toFixed(2)}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const buyerPolicy: PolicyPanel = {
    status: compliance.allowed ? "passed" : "blocked",
    reason: compliance.allowed ? "No allergen or budget violations against this kitchen's own policy." : compliance.reasons.join(" ")
  };
  step(steps, "buyer_policy", buyerPolicy.status, "Buyer policy check", buyerPolicy.reason);

  if (!compliance.allowed) {
    return finish(steps, "1", name, tagline, { ok: false, quote, order: null, buyerPolicy, aimoPolicy: null }, client);
  }

  const order = await client.placeOrder(quote.quote_id);
  const aimoPolicy: PolicyPanel = {
    status: order.status === "confirmed" ? "passed" : "human_review",
    reason: order.status === "confirmed" ? "Within credit limit and auto-approval ceiling — released without a human in the loop." : (order.approval.reason ?? "Held for review.")
  };
  step(steps, "aimo_policy", aimoPolicy.status, "Aimo policy check", aimoPolicy.reason, order);
  step(steps, "result", order.status === "confirmed" ? "complete" : "pending", "Order release", `Order ${order.order_id} status: ${order.status}.`, order);

  return finish(steps, "1", name, tagline, { ok: order.status === "confirmed", quote, order, buyerPolicy, aimoPolicy }, client);
}

/** Scenario 2 — two-sided approval. Order exceeds the buyer's Aimo-side credit limit; Aimo holds it, a human on Aimo's side clears it. */
export async function scenario2TwoSidedApproval(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Two-sided approval";
  const tagline = "Human approval";

  step(steps, "request", "complete", "Buyer request received", "A large replenishment order that will exceed this buyer's Aimo-side credit limit.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 4520 }]);
  step(steps, "quote", "complete", "Product search and quote", `Quote ${quote.quote_id} issued. Total €${quote.total_eur.toFixed(2)}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const buyerPolicy: PolicyPanel = {
    status: compliance.allowed ? "passed" : "blocked",
    reason: compliance.allowed ? "Buyer policy clears the product selection — no opinion on Aimo's commercial risk." : compliance.reasons.join(" ")
  };
  step(steps, "buyer_policy", buyerPolicy.status, "Buyer policy check", buyerPolicy.reason);
  if (!compliance.allowed) {
    return finish(steps, "2", name, tagline, { ok: false, quote, order: null, buyerPolicy, aimoPolicy: null }, client);
  }

  let order = await client.placeOrder(quote.quote_id);
  const held = order.status === "held_for_approval";
  const aimoPolicy: PolicyPanel = {
    status: held ? "human_review" : "passed",
    reason: held ? (order.approval.reason ?? "Held for Aimo-side review.") : "Within credit limit and auto-approval ceiling."
  };
  step(steps, "aimo_policy", aimoPolicy.status, "Aimo policy check", aimoPolicy.reason, order);
  step(
    steps,
    "result",
    held ? "human_review" : "complete",
    "Order release",
    held ? `Order held. owner=${order.approval.owner}.` : `Order confirmed directly: ${order.order_id}.`,
    order
  );

  if (held) {
    // A buyer's agent must NOT be able to clear an Aimo-owned hold — proves the governance boundary.
    try {
      await client.approveOrder(order.order_id, "human:buyer");
      step(steps, "approval", "blocked", "Governance check", "ERROR: buyer-side approval was incorrectly accepted for an Aimo-owned hold.");
    } catch (err) {
      step(steps, "approval", "info", "Governance check", `Confirmed: a buyer-side human cannot clear this Aimo-owned hold (${(err as Error).message}).`);
    }

    order = await client.approveOrder(order.order_id, "human:aimo");
    step(steps, "approval", "complete", "Aimo-side approval", `Approved by human:aimo. Order status now: ${order.status}.`, order);
  }

  return finish(steps, "2", name, tagline, { ok: order.status === "confirmed", quote, order, buyerPolicy, aimoPolicy }, client);
}

/** Scenario 3 — stock-out and substitution. Finds whichever currently-unavailable product (from a curated candidate
 *  list of products with real substitution chains) demonstrates the ranked, fully-disclosed alternative list, then
 *  applies the kitchen's own policy to pick (or reject) from it. The specific SKU that trips "unavailable" can change
 *  day to day on the real upstream mock backend, so this probes several real candidates rather than hardcoding one. */
const SUBSTITUTION_CANDIDATES = ["468928", "469290", "460131", "460189", "460541", "461101", "463437", "471068"];

export async function scenario3StockOutSubstitution(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Stock-out and substitution";
  const tagline = "Alternative selection";

  step(steps, "request", "complete", "Buyer request received", `Checking ${SUBSTITUTION_CANDIDATES.length} candidate SKUs with real substitution chains for a stock-out.`);

  const quote = await client.requestQuote(
    BUYER_ID,
    SUBSTITUTION_CANDIDATES.map((id) => ({ product_id: id, qty: 10 }))
  );
  step(steps, "quote", "complete", "Product search and quote", `Quote ${quote.quote_id} requested across ${SUBSTITUTION_CANDIDATES.length} candidate SKUs.`, quote);

  const unavailable: QuoteLine | undefined = quote.lines.find((l) => l.status === "unavailable" && l.alternatives.length > 0);
  if (!unavailable) {
    step(steps, "result", "info", "Result", "All candidate SKUs were in stock on the real upstream backend at demo time — nothing to substitute right now.");
    return finish(steps, "3", name, tagline, { ok: true, quote, order: null, buyerPolicy: null, aimoPolicy: null }, client);
  }

  step(
    steps,
    "aimo_policy",
    "info",
    "Aimo discloses alternatives",
    `Requested product ${unavailable.requested_product_id} is unavailable. Aimo returns ${unavailable.alternatives.length} ranked alternative(s) by its own commercial attributes, allergens disclosed, no buyer-policy filtering applied.`,
    unavailable.alternatives
  );

  const { chosen, rejected } = pickAllowedAlternative(HOTEL_ESPOO_POLICY, unavailable.alternatives);
  for (const r of rejected) {
    step(steps, "buyer_policy", "rejected", `Alternative rejected: ${r.alt.name}`, `Rank ${r.alt.rank}, ${r.alt.product_id}: ${r.reason}`);
  }

  const buyerPolicy: PolicyPanel = chosen
    ? { status: "passed", reason: `Selected rank ${chosen.rank}: ${chosen.product_id} (${chosen.name}) — best-ranked option that passes this kitchen's policy.` }
    : { status: "blocked", reason: "No disclosed alternative passes this kitchen's policy — reported honestly instead of silently substituting." };
  step(steps, "result", chosen ? "complete" : "blocked", "Buyer policy check", buyerPolicy.reason);

  return finish(steps, "3", name, tagline, { ok: true, quote, order: null, buyerPolicy, aimoPolicy: null }, client);
}

export const SCENARIOS = [
  { id: "1", fn: scenario1Autonomous },
  { id: "2", fn: scenario2TwoSidedApproval },
  { id: "3", fn: scenario3StockOutSubstitution }
] as const;

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const client = buildClient();
  return [await scenario1Autonomous(client), await scenario2TwoSidedApproval(client), await scenario3StockOutSubstitution(client)];
}
