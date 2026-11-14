import { createAimoClient, type AimoClient } from "./aimoClient";
import { HOTEL_ESPOO_POLICY, checkCompliance, pickAllowedAlternative } from "./policyEngine";
import type { AllergenFact, AuditEvent, Order, Quote, QuoteLine } from "@aimo/shared";

export type Stage = "request" | "quote" | "buyer_policy" | "aimo_policy" | "approval" | "audit" | "result";
export type StepStatus = "complete" | "passed" | "blocked" | "human_review" | "pending" | "rejected" | "info";
export type Outcome = "confirmed_auto" | "confirmed_after_approval" | "held" | "no_viable_alternative" | "blocked";

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

export interface GovernanceCheckResult {
  attemptedBy: "human:buyer";
  rejected: boolean;
  httpStatus: number | null;
  rawMessage: string;
}

export interface AlternativeReview {
  rank: number;
  product_id: string;
  name: string;
  price_eur: number | null;
  availability_status: string;
  allergens: AllergenFact[];
  buyerDecision: "eligible" | "rejected";
  buyerReason: string;
}

export interface ScenarioResult {
  id: string;
  name: string;
  tagline: string;
  outcome: Outcome;
  headline: string;
  subheadline: string;
  transactionId: string | null;
  transactionIdKind: "order" | "quote" | null;
  ok: boolean;
  steps: ScenarioStep[];
  buyerPolicy: PolicyPanel | null;
  aimoPolicy: PolicyPanel | null;
  quote: Quote | null;
  order: Order | null;
  audit: AuditEvent[];
  governanceCheck?: GovernanceCheckResult;
  requestedProduct?: { id: string; name: string };
  alternatives?: AlternativeReview[];
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

async function withAudit(order: Order | null, client: AimoClient, steps: ScenarioStep[]): Promise<AuditEvent[]> {
  if (!order) return [];
  step(steps, "audit", "info", "Audit trail recorded", `${order.order_id}: evidence trail available below.`);
  const trail = await client.getAuditTrail(order.order_id);
  return trail.events;
}

/** Scenario 1 — autonomous purchasing, happy path. Mirrors the brief's own example almost verbatim. */
export async function scenario1Autonomous(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Autonomous purchasing";
  const tagline = "Happy path";

  step(steps, "request", "complete", "Buyer request received", "1,000 L of lactose-free milk, by Monday, price/availability-driven choice.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 1000 }]);
  const line = quote.lines[0];
  step(steps, "quote", "complete", "Quote obtained", `€${quote.total_eur.toFixed(2)} for 1,000 L of ${line.requested_product_name}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const buyerPolicy: PolicyPanel = {
    status: compliance.allowed ? "passed" : "blocked",
    reason: compliance.allowed ? "No allergen or budget violations against this kitchen's own policy." : compliance.reasons.join(" ")
  };
  step(steps, "buyer_policy", buyerPolicy.status, "Buyer policy check", buyerPolicy.status === "passed" ? "Passed." : "Blocked.");

  if (!compliance.allowed) {
    return {
      id: "1",
      name,
      tagline,
      outcome: "blocked",
      headline: "Order not placed",
      subheadline: buyerPolicy.reason,
      transactionId: quote.quote_id,
      transactionIdKind: "quote",
      ok: false,
      steps,
      buyerPolicy,
      aimoPolicy: null,
      quote,
      order: null,
      audit: []
    };
  }

  const order = await client.placeOrder(quote.quote_id);
  const aimoPolicy: PolicyPanel = {
    status: order.status === "confirmed" ? "passed" : "human_review",
    reason: order.status === "confirmed" ? "Within credit limit and auto-approval ceiling — released without a human in the loop." : (order.approval.reason ?? "Held for review.")
  };
  step(steps, "aimo_policy", aimoPolicy.status, "Aimo policy check", aimoPolicy.status === "passed" ? "Passed, auto-approved." : "Held for review.");
  step(steps, "result", order.status === "confirmed" ? "complete" : "pending", "Order release", order.status === "confirmed" ? "Released." : "Pending.");

  const audit = await withAudit(order, client, steps);

  return {
    id: "1",
    name,
    tagline,
    outcome: "confirmed_auto",
    headline: `€${quote.total_eur.toFixed(2)}`,
    subheadline: `1,000 L of ${line.requested_product_name}`,
    transactionId: order.order_id,
    transactionIdKind: "order",
    ok: order.status === "confirmed",
    steps,
    buyerPolicy,
    aimoPolicy,
    quote,
    order,
    audit
  };
}

/** Scenario 2 — two-sided approval. Order exceeds the buyer's Aimo-side credit limit; Aimo holds it, a human on Aimo's side clears it. */
export async function scenario2TwoSidedApproval(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Two-sided approval";
  const tagline = "Human approval";

  step(steps, "request", "complete", "Buyer request received", "A large replenishment order that will exceed this buyer's Aimo-side credit limit.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 4520 }]);
  const line = quote.lines[0];
  step(steps, "quote", "complete", "Quote obtained", `€${quote.total_eur.toFixed(2)} for 4,520 L of ${line.requested_product_name}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const buyerPolicy: PolicyPanel = {
    status: compliance.allowed ? "passed" : "blocked",
    reason: compliance.allowed ? "Buyer policy clears the product selection — no opinion on Aimo's commercial risk." : compliance.reasons.join(" ")
  };
  step(steps, "buyer_policy", buyerPolicy.status, "Buyer policy check", buyerPolicy.status === "passed" ? "Passed." : "Blocked.");
  if (!compliance.allowed) {
    return {
      id: "2",
      name,
      tagline,
      outcome: "blocked",
      headline: "Order not placed",
      subheadline: buyerPolicy.reason,
      transactionId: quote.quote_id,
      transactionIdKind: "quote",
      ok: false,
      steps,
      buyerPolicy,
      aimoPolicy: null,
      quote,
      order: null,
      audit: []
    };
  }

  let order = await client.placeOrder(quote.quote_id);
  const held = order.status === "held_for_approval";
  const aimoPolicy: PolicyPanel = {
    status: held ? "human_review" : "passed",
    reason: held ? (order.approval.reason ?? "Held for Aimo-side review.") : "Within credit limit and auto-approval ceiling."
  };
  step(steps, "aimo_policy", aimoPolicy.status, "Aimo policy check", held ? "Requires Aimo-side human approval." : "Passed, auto-approved.");

  let governanceCheck: GovernanceCheckResult | undefined;
  if (held) {
    try {
      await client.approveOrder(order.order_id, "human:buyer");
      governanceCheck = { attemptedBy: "human:buyer", rejected: false, httpStatus: 200, rawMessage: "Accepted (this would be a bug)." };
      step(steps, "approval", "blocked", "Governance check failed", "ERROR: buyer-side approval was incorrectly accepted for an Aimo-owned hold.");
    } catch (err) {
      const message = (err as Error).message;
      const statusMatch = message.match(/failed: (\d+)/);
      governanceCheck = { attemptedBy: "human:buyer", rejected: true, httpStatus: statusMatch ? Number(statusMatch[1]) : null, rawMessage: message };
      step(steps, "approval", "info", "Approval ownership enforced", "Buyer-side approval rejected — cannot clear an Aimo-owned hold.");
    }

    order = await client.approveOrder(order.order_id, "human:aimo");
    step(steps, "approval", "complete", "Aimo-side approval", "Authorized Aimo human cleared the hold.");
  }

  const audit = await withAudit(order, client, steps);

  return {
    id: "2",
    name,
    tagline,
    outcome: held ? "confirmed_after_approval" : "confirmed_auto",
    headline: `€${quote.total_eur.toFixed(2)}`,
    subheadline: "Large replenishment order",
    transactionId: order.order_id,
    transactionIdKind: "order",
    ok: order.status === "confirmed",
    steps,
    buyerPolicy,
    aimoPolicy,
    quote,
    order,
    audit,
    governanceCheck
  };
}

/** Scenario 3 — stock-out and substitution. Probes a curated candidate list of products with real substitution
 *  chains to find whichever is currently out of stock on the real upstream mock backend (the specific SKU that
 *  trips "unavailable" can change day to day), then shows ONLY that product's real disclosed alternatives —
 *  the other candidates are an internal probing detail, not substitutes of each other, so they're deliberately
 *  excluded from the rendered alternatives table to avoid implying they're viable substitutes. */
const SUBSTITUTION_CANDIDATES = ["468928", "469290", "460131", "460189", "460541", "461101", "463437", "471068"];

export async function scenario3StockOutSubstitution(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Stock-out and substitution";
  const tagline = "Alternative selection";

  step(steps, "request", "complete", "Buyer request received", `Checking ${SUBSTITUTION_CANDIDATES.length} candidate SKUs with real substitution chains for a live stock-out.`);

  const quote = await client.requestQuote(
    BUYER_ID,
    SUBSTITUTION_CANDIDATES.map((id) => ({ product_id: id, qty: 10 }))
  );
  step(steps, "quote", "complete", "Candidate SKUs checked", `${SUBSTITUTION_CANDIDATES.length} SKUs probed for availability (not substitutes of each other).`);

  const unavailable: QuoteLine | undefined = quote.lines.find((l) => l.status === "unavailable" && l.alternatives.length > 0);
  if (!unavailable) {
    step(steps, "result", "info", "Result", "All candidate SKUs were in stock on the real upstream backend at demo time.");
    return {
      id: "3",
      name,
      tagline,
      outcome: "no_viable_alternative",
      headline: "No stock-out to demonstrate right now",
      subheadline: "Every candidate SKU is currently in stock on the live upstream backend.",
      transactionId: quote.quote_id,
      transactionIdKind: "quote",
      ok: true,
      steps,
      buyerPolicy: null,
      aimoPolicy: null,
      quote,
      order: null,
      audit: []
    };
  }

  step(
    steps,
    "aimo_policy",
    "info",
    "Aimo discloses alternatives",
    `${unavailable.requested_product_name} is unavailable. Aimo returns ${unavailable.alternatives.length} ranked, fully-disclosed alternative(s).`
  );

  const { chosen, rejected } = pickAllowedAlternative(HOTEL_ESPOO_POLICY, unavailable.alternatives);
  const rejectedIds = new Set(rejected.map((r) => r.alt.product_id));

  const alternatives: AlternativeReview[] = unavailable.alternatives.map((alt) => {
    const isRejected = rejectedIds.has(alt.product_id);
    const rejectedEntry = rejected.find((r) => r.alt.product_id === alt.product_id);
    return {
      rank: alt.rank,
      product_id: alt.product_id,
      name: alt.name,
      price_eur: alt.price_eur,
      availability_status: alt.availability.status,
      allergens: alt.allergens,
      buyerDecision: isRejected ? "rejected" : "eligible",
      buyerReason: rejectedEntry ? rejectedEntry.reason : chosen?.product_id === alt.product_id ? "Best-ranked option that passes this kitchen's policy." : "Not evaluated (a higher-ranked eligible option was already chosen)."
    };
  });

  for (const r of rejected) {
    step(steps, "buyer_policy", "rejected", `Rejected: ${r.alt.name}`, r.reason);
  }

  const buyerPolicy: PolicyPanel = chosen
    ? { status: "passed", reason: `Selected rank ${chosen.rank}: ${chosen.product_id} (${chosen.name}) — best-ranked option that passes this kitchen's policy.` }
    : { status: "blocked", reason: "No disclosed alternative passes this kitchen's policy — reported honestly instead of silently substituting." };
  step(steps, "result", chosen ? "complete" : "blocked", "Buyer decision", chosen ? "Alternative selected." : "No compliant alternative.");

  return {
    id: "3",
    name,
    tagline,
    outcome: chosen ? "confirmed_auto" : "no_viable_alternative",
    headline: chosen ? `Substituted with ${chosen.name}` : "No suitable alternative",
    subheadline: `Requested product unavailable: ${unavailable.requested_product_name}`,
    transactionId: quote.quote_id,
    transactionIdKind: "quote",
    ok: true,
    steps,
    buyerPolicy,
    aimoPolicy: null,
    quote,
    order: null,
    audit: [],
    requestedProduct: { id: unavailable.requested_product_id, name: unavailable.requested_product_name },
    alternatives
  };
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
