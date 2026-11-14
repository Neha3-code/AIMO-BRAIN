import { createAimoClient, type AimoClient } from "./aimoClient";
import { HOTEL_ESPOO_POLICY, checkCompliance, checkDeliveryDate, pickAllowedAlternative, type DeliveryDateDecision } from "./policyEngine";
import type { AllergenFact, AuditEvent, Order, Quote, QuoteLine } from "@aimo/shared";

export type Stage = "request" | "quote" | "buyer_policy" | "aimo_policy" | "approval" | "order" | "audit" | "result";
export type StepStatus = "complete" | "passed" | "blocked" | "human_review" | "pending" | "rejected" | "info";
export type Outcome = "confirmed_auto" | "confirmed_after_approval" | "held" | "no_viable_alternative" | "blocked" | "partial" | "substituted" | "both_ready";

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
  alternativesNote?: string;
  buyerBannedAllergenCodes?: string[];
  eligibleLineValueEur?: number;
  deliveryDateDecision?: DeliveryDateDecision & { requestedDate: string; confirmedDate: string | null };
  /** The one or two quote lines actually relevant to this scenario's narrative, when the
   *  full quote (e.g. scenario 3/4's multi-candidate probe) contains unrelated noise lines. */
  relevantLines?: QuoteLine[];
}

function step(steps: ScenarioStep[], stage: Stage, status: StepStatus, title: string, detail: string, data?: unknown) {
  steps.push({ stage, status, title, detail, data });
}

export function formatEur(amount: number): string {
  return `€${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

  step(steps, "request", "complete", "Buyer request received", "1,000 L of lactose-free milk, price/availability-driven choice.");

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: "464073", qty: 1000 }]);
  const line = quote.lines[0];
  step(
    steps,
    "quote",
    "complete",
    "Quote obtained",
    `${formatEur(quote.total_eur)} for 1,000 L of ${line.requested_product_name}, requested for delivery ${quote.requested_delivery_date}.`,
    quote
  );

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const deliveryDecision = checkDeliveryDate(HOTEL_ESPOO_POLICY, quote.requested_delivery_date, line.envelope.claim.availability.confirmed_available_date);
  step(
    steps,
    "buyer_policy",
    deliveryDecision.allowed ? "passed" : "blocked",
    "Delivery date evaluation",
    deliveryDecision.reason
  );

  const allowed = compliance.allowed && deliveryDecision.allowed;
  const buyerPolicy: PolicyPanel = {
    status: allowed ? "passed" : "blocked",
    reason: allowed
      ? "No allergen, budget or delivery-date violations against this kitchen's own policy."
      : [...compliance.reasons, !deliveryDecision.allowed ? deliveryDecision.reason : null].filter(Boolean).join(" ")
  };
  step(steps, "buyer_policy", buyerPolicy.status, "Buyer policy check", buyerPolicy.status === "passed" ? "Passed." : "Blocked.");

  const deliveryDateDecision = {
    ...deliveryDecision,
    requestedDate: quote.requested_delivery_date,
    confirmedDate: line.envelope.claim.availability.confirmed_available_date
  };

  if (!allowed) {
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
      audit: [],
      deliveryDateDecision
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
    headline: `${formatEur(quote.total_eur)}`,
    subheadline: `1,000 L of ${line.requested_product_name}`,
    transactionId: order.order_id,
    transactionIdKind: "order",
    ok: order.status === "confirmed",
    steps,
    buyerPolicy,
    aimoPolicy,
    quote,
    order,
    audit,
    deliveryDateDecision
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
  step(steps, "quote", "complete", "Quote obtained", `${formatEur(quote.total_eur)} for 4,520 L of ${line.requested_product_name}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const deliveryDecision = checkDeliveryDate(HOTEL_ESPOO_POLICY, quote.requested_delivery_date, line.envelope.claim.availability.confirmed_available_date);
  step(steps, "buyer_policy", deliveryDecision.allowed ? "passed" : "blocked", "Delivery date evaluation", deliveryDecision.reason);

  const allowed = compliance.allowed && deliveryDecision.allowed;
  const buyerPolicy: PolicyPanel = {
    status: allowed ? "passed" : "blocked",
    reason: allowed
      ? "Buyer policy clears the product selection and delivery date — no opinion on Aimo's commercial risk."
      : [...compliance.reasons, !deliveryDecision.allowed ? deliveryDecision.reason : null].filter(Boolean).join(" ")
  };
  step(steps, "buyer_policy", buyerPolicy.status, "Buyer policy check", buyerPolicy.status === "passed" ? "Passed." : "Blocked.");

  const deliveryDateDecision = {
    ...deliveryDecision,
    requestedDate: quote.requested_delivery_date,
    confirmedDate: line.envelope.claim.availability.confirmed_available_date
  };

  if (!allowed) {
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
      audit: [],
      deliveryDateDecision
    };
  }

  step(steps, "order", "complete", "Order submitted", `Quote ${quote.quote_id} committed to Aimo for the commercial guardrail check.`);

  let order = await client.placeOrder(quote.quote_id);
  const held = order.status === "held_for_approval";
  const aimoPolicy: PolicyPanel = {
    status: held ? "human_review" : "passed",
    reason: held ? (order.approval.reason ?? "Held for Aimo-side review.") : "Within credit limit and auto-approval ceiling."
  };
  step(steps, "aimo_policy", aimoPolicy.status, held ? "Aimo places order on hold" : "Aimo policy check", held ? "Human approval required." : "Passed, auto-approved.");

  let governanceCheck: GovernanceCheckResult | undefined;
  if (held) {
    try {
      await client.approveOrder(order.order_id, "human:buyer");
      governanceCheck = { attemptedBy: "human:buyer", rejected: false, httpStatus: 200, rawMessage: "Accepted (this would be a bug)." };
      step(steps, "approval", "blocked", "Buyer-side approval attempted", "ERROR: incorrectly accepted for an Aimo-owned hold.");
    } catch (err) {
      const message = (err as Error).message;
      const statusMatch = message.match(/failed: (\d+)/);
      governanceCheck = { attemptedBy: "human:buyer", rejected: true, httpStatus: statusMatch ? Number(statusMatch[1]) : null, rawMessage: message };
      step(steps, "approval", "info", "Buyer-side approval attempted", `${governanceCheck.httpStatus ?? "error"} — unauthorized. Buyer cannot clear an Aimo-owned hold.`);
    }

    order = await client.approveOrder(order.order_id, "human:aimo");
    step(steps, "approval", "complete", "Aimo human approves", "Authorized.");
    step(steps, "order", "complete", "Order confirmed", "Released.");
  }

  const audit = await withAudit(order, client, steps);

  return {
    id: "2",
    name,
    tagline,
    outcome: held ? "confirmed_after_approval" : "confirmed_auto",
    headline: `${formatEur(quote.total_eur)}`,
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
    governanceCheck,
    deliveryDateDecision
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

  const alternativesNote = `${SUBSTITUTION_CANDIDATES.length} candidate SKUs were checked for availability — only the one that came back out of stock had a real substitute registered. The backend returned ${unavailable.alternatives.length} actual substitute(s) for that one product, from its own substitutions list (not the other 7 candidates).`;

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
    outcome: chosen ? "substituted" : "no_viable_alternative",
    headline: chosen ? `Substitute identified: ${chosen.name}` : "No suitable alternative",
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
    alternatives,
    alternativesNote,
    buyerBannedAllergenCodes: HOTEL_ESPOO_POLICY.bannedAllergenCodes
  };
}

/** Scenario 4 — partial availability. A single order request names several distinct products in one basket;
 *  one line is in stock and ready to order, another is genuinely out of stock. Tests that a mixed-result quote
 *  is handled line by line rather than the whole request succeeding or failing as one unit. This is a
 *  quote-level demonstration — deliberately doesn't place an order, since splitting a single commit into a
 *  partially-fulfilled order is real production work (idempotency, partial-shipment billing) out of scope here;
 *  see README "what production would also need". */
export async function scenario4PartialAvailability(client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Partial availability";
  const tagline = "Mixed basket";

  step(steps, "request", "complete", "Buyer request received", "One basket, two products: lactose-free milk plus a bakery item that may be out of stock.");

  const quote = await client.requestQuote(BUYER_ID, [
    { product_id: "464073", qty: 200 },
    ...SUBSTITUTION_CANDIDATES.map((id) => ({ product_id: id, qty: 10 }))
  ]);
  const milkLine = quote.lines.find((l) => l.requested_product_id === "464073")!;
  const otherLine = quote.lines.find((l) => l.requested_product_id !== "464073" && l.status === "unavailable") ?? quote.lines.find((l) => l.requested_product_id !== "464073")!;

  step(
    steps,
    "quote",
    "complete",
    "Quote obtained, line by line",
    `${milkLine.requested_product_name}: ${milkLine.status}. ${otherLine.requested_product_name}: ${otherLine.status}.`,
    quote
  );

  const bothReady = milkLine.status === "available" && otherLine.status === "available";
  if (bothReady) {
    step(steps, "result", "info", "Result", "Both lines were in stock on the live upstream backend at demo time — nothing partial to demonstrate right now.");
    return {
      id: "4",
      name,
      tagline,
      outcome: "both_ready",
      headline: "Both lines in stock right now",
      subheadline: "Nothing partial to demonstrate against the live backend at this moment.",
      transactionId: quote.quote_id,
      transactionIdKind: "quote",
      ok: true,
      steps,
      buyerPolicy: null,
      aimoPolicy: null,
      quote,
      order: null,
      audit: [],
      relevantLines: [milkLine, otherLine]
    };
  }

  const readyLines = [milkLine, otherLine].filter((l) => l.status === "available");
  const eligibleLineValueEur = Math.round(readyLines.reduce((sum, l) => sum + (l.line_total_eur ?? 0), 0) * 100) / 100;

  step(
    steps,
    "result",
    "complete",
    "Per-line evaluation",
    `${milkLine.requested_product_name} is eligible for ordering; ${otherLine.requested_product_name} requires a substitution decision — evaluated independently, not as one failed basket. This is a quote evaluation, not an order — nothing has been placed.`
  );

  return {
    id: "4",
    name,
    tagline,
    outcome: "partial",
    headline: `${readyLines.length} / 2 lines currently eligible for ordering`,
    subheadline: `${milkLine.requested_product_name} — ${milkLine.status}; ${otherLine.requested_product_name} — ${otherLine.status}`,
    transactionId: quote.quote_id,
    transactionIdKind: "quote",
    ok: true,
    steps,
    buyerPolicy: null,
    aimoPolicy: null,
    quote,
    order: null,
    audit: [],
    relevantLines: [milkLine, otherLine],
    eligibleLineValueEur
  };
}

export const SCENARIOS = [
  { id: "1", fn: scenario1Autonomous },
  { id: "2", fn: scenario2TwoSidedApproval },
  { id: "3", fn: scenario3StockOutSubstitution },
  { id: "4", fn: scenario4PartialAvailability }
] as const;

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const client = buildClient();
  return [
    await scenario1Autonomous(client),
    await scenario2TwoSidedApproval(client),
    await scenario3StockOutSubstitution(client),
    await scenario4PartialAvailability(client)
  ];
}
