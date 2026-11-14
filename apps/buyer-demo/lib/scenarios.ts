import { createAimoClient, type AimoClient } from "./aimoClient";
import {
  HOTEL_ESPOO_POLICY,
  checkCompliance,
  checkDeliveryDate,
  checkReliability,
  estimateOrderFootprint,
  evaluateSubstitutes,
  factsOf,
  type CheckResult,
  type DeliveryDateDecision,
  type OrderFootprint,
  type RecipeChemistryResult
} from "./policyEngine";
import type { AllergenFact, AuditEvent, Order, ProductFacts, ProductLookupResult, Quote, QuoteAlternative, QuoteLine } from "@aimo/shared";

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
  /** "eligible" = passes every check cleanly, no unknowns. "needs_review" = doesn't fail anything,
   *  but at least one check (typically unknown delivery reliability) can't be confirmed, so the
   *  agent won't auto-pick it — a human has to sign off. */
  buyerDecision: "selected" | "eligible" | "needs_review" | "rejected";
  buyerReason: string;
  checks: CheckResult[];
  recipe: RecipeChemistryResult;
  facts: ProductFacts;
  carbonDeltaPct: number | null;
  carbonOriginal: number | null;
  carbonSubstitute: number | null;
  carbonLimitPct: number;
}

/** Carbon footprint + delivery reliability of the product actually being ordered. */
export interface SustainabilityPanel {
  productName: string;
  footprint: OrderFootprint;
  reliability: CheckResult & { value: number | null };
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
  sustainability?: SustainabilityPanel;
  /** Facts for the requested (original) product a substitution is measured against. */
  originalFacts?: ProductFacts;
  alternativesRanking?: string;
  /** The one or two quote lines actually relevant to this scenario's narrative, when the
   *  full quote (e.g. scenario 3/4's multi-candidate probe) contains unrelated noise lines. */
  relevantLines?: QuoteLine[];
  /** True when the product has zero registered substitutes — distinct from having substitutes
   *  that were evaluated and rejected. */
  noRegisteredSubstitutes?: boolean;
  /** True when the requested product itself is out of stock — surfaced explicitly so the buyer
   *  isn't left to infer it from an empty substitutes list. */
  requestedProductOutOfStock?: boolean;
  /** Fallback when there are no registered substitutes: same-category products, evaluated
   *  against the same policy but never auto-selected. */
  categorySuggestions?: AlternativeReview[];
  categorySuggestionsNote?: string;
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

/** Carbon footprint + delivery reliability for the line being ordered. Reliability below the
 *  kitchen's minimum is flagged, not blocking: the buyer asked for this exact SKU, so the agent
 *  surfaces the delivery risk instead of second-guessing the request. Substitutes the agent picks
 *  on its own ARE held to the minimum (see evaluateSubstitutes). */
function assessSustainability(steps: ScenarioStep[], line: QuoteLine): SustainabilityPanel {
  const facts = factsOf(line);
  if (!line.facts) {
    const note = "The connected Aimo API version doesn't disclose carbon or delivery-reliability facts on quote lines yet — redeploy apps/aimo-api.";
    step(steps, "buyer_policy", "info", "Carbon footprint and delivery reliability", note);
    return {
      productName: line.requested_product_name,
      footprint: { intensityKgCo2ePerKg: null, netWeightKgPerUnit: null, totalWeightKg: null, totalKgCo2e: null, note },
      reliability: { check: "reliability", status: "warn", detail: "", value: null }
    };
  }
  const footprint = estimateOrderFootprint(facts, line.requested_qty);
  step(
    steps,
    "buyer_policy",
    "info",
    "Carbon footprint",
    footprint.intensityKgCo2ePerKg !== null ? `${footprint.intensityKgCo2ePerKg} kg CO2-eq/kg. ${footprint.note}` : footprint.note
  );
  const reliability = checkReliability(HOTEL_ESPOO_POLICY, facts.delivery_reliability);
  step(
    steps,
    "buyer_policy",
    reliability.status === "pass" ? "passed" : "info",
    "Delivery reliability",
    reliability.status === "fail" ? `${reliability.detail} Flagged for the buyer: consider a buffer stock — not blocking, since this exact SKU was requested.` : reliability.detail
  );
  return { productName: line.requested_product_name, footprint, reliability: { ...reliability, value: facts.delivery_reliability } };
}

function sustainabilitySentence(s: SustainabilityPanel): string {
  const parts: string[] = [];
  if (s.footprint.totalKgCo2e !== null) parts.push(`estimated footprint ≈ ${s.footprint.totalKgCo2e.toLocaleString("en-US")} kg CO2-eq`);
  else if (s.footprint.intensityKgCo2ePerKg !== null) parts.push(`${s.footprint.intensityKgCo2ePerKg} kg CO2-eq/kg`);
  if (s.reliability.value !== null) parts.push(`${Math.round(s.reliability.value * 1000) / 10} % historical on-time delivery${s.reliability.status === "fail" ? " (below the kitchen's minimum — flagged)" : ""}`);
  return parts.length ? ` Disclosed: ${parts.join(", ")}.` : "";
}

/** Runs every disclosed alternative through the kitchen's full substitution policy and records
 *  one timeline step per rejection plus the final pick. */
type SubstituteEvaluation = ReturnType<typeof evaluateSubstitutes>["evaluations"][number];

function toAlternativeReview(e: SubstituteEvaluation, isChosen: boolean): AlternativeReview {
    const failed = e.checks.filter((c) => c.status === "fail");
    const warned = e.checks.filter((c) => c.status === "warn");
    const buyerDecision: AlternativeReview["buyerDecision"] = isChosen ? "selected" : !e.eligible ? "rejected" : e.autoEligible ? "eligible" : "needs_review";
    return {
      rank: e.alt.rank,
      product_id: e.alt.product_id,
      name: e.alt.name,
      price_eur: e.alt.price_eur,
      availability_status: e.alt.availability.status,
      allergens: e.alt.allergens,
      buyerDecision,
      buyerReason:
        buyerDecision === "selected"
          ? `Selected: passes every check${e.recipe.score !== null ? ` with the closest recipe match (${e.recipe.score}/100)` : ""}.`
          : buyerDecision === "eligible"
            ? "Passes every check, but a closer recipe match (or lower-carbon option) was available."
            : buyerDecision === "needs_review"
              ? `Passes known checks, but can't be auto-selected: ${warned.map((c) => c.detail).join(" ")}`
              : failed.map((c) => c.detail).join(" "),
      checks: e.checks,
      recipe: e.recipe,
      facts: factsOf(e.alt),
      carbonDeltaPct: e.carbonDeltaPct,
      carbonOriginal: e.carbon.originalIntensity,
      carbonSubstitute: e.carbon.substituteIntensity,
      carbonLimitPct: e.carbon.limitPct
    };
}

function reviewAlternatives(
  steps: ScenarioStep[],
  originalFacts: ProductFacts,
  alts: QuoteAlternative[]
): { alternatives: AlternativeReview[]; chosen: QuoteAlternative | null } {
  const { evaluations, chosen } = evaluateSubstitutes(HOTEL_ESPOO_POLICY, originalFacts, alts);
  const alternatives = evaluations.map((e) => toAlternativeReview(e, chosen?.alt.product_id === e.alt.product_id));
  for (const a of alternatives.filter((x) => x.buyerDecision === "rejected")) {
    const failedChecks = a.checks.filter((c) => c.status === "fail").map((c) => c.check);
    step(steps, "buyer_policy", "rejected", `Rejected: ${a.name}`, `Failed ${failedChecks.join(", ")} — ${a.buyerReason}`);
  }
  return { alternatives, chosen: chosen?.alt ?? null };
}

const MAX_CATEGORY_SUGGESTIONS = 5;

/** Fallback when the catalog registers no substitutes for a product (true for ~99 % of SKUs):
 *  look up other products in the same catalog category and run them through the exact same
 *  substitution policy. These are suggestions, not registered substitutes, so the agent never
 *  auto-selects one: the best a suggestion can be is "eligible", and a human makes the call.
 *  Only orderable products are shown, best recipe match first. */
async function suggestFromCategory(
  client: AimoClient,
  steps: ScenarioStep[],
  originalId: string,
  originalFacts: ProductFacts
): Promise<{ suggestions: AlternativeReview[]; note: string } | null> {
  if (!originalFacts.category) return null;
  let results: ProductLookupResult[];
  try {
    ({ results } = await client.lookupProducts({ category: originalFacts.category }));
  } catch {
    return null; // suggestions are a nice-to-have; never fail the scenario over them
  }
  const toNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const candidates: QuoteAlternative[] = results
    .filter((r) => r.envelope.claim.product_id !== originalId)
    .map((r, i) => ({
      rank: i + 1,
      product_id: r.envelope.claim.product_id,
      name: r.name,
      price_eur: r.envelope.claim.price?.amount ?? null,
      availability: r.envelope.claim.availability,
      delivery_lead_time_days: r.delivery_lead_time_days,
      allergens: r.allergens,
      facts: {
        category: r.category || null,
        carbon_footprint_kg_co2e_per_kg: toNum(r.carbon_footprint_kg_co2e_per_kg),
        delivery_reliability: toNum(r.delivery_reliability),
        net_weight_kg_per_sales_unit: toNum(r.net_weight_kg_per_sales_unit),
        composition: r.composition ?? null
      },
      envelope: r.envelope
    }));
  if (candidates.length === 0) return null;

  const { evaluations } = evaluateSubstitutes(HOTEL_ESPOO_POLICY, originalFacts, candidates);
  const decisionOrder = { selected: 0, eligible: 0, needs_review: 1, rejected: 2 } as const;
  const suggestions = evaluations
    .filter((e) => e.checks.find((c) => c.check === "availability")?.status === "pass")
    .map((e) => toAlternativeReview(e, false))
    .sort(
      (a, b) =>
        decisionOrder[a.buyerDecision] - decisionOrder[b.buyerDecision] ||
        (b.recipe.score ?? -1) - (a.recipe.score ?? -1) ||
        (a.facts.carbon_footprint_kg_co2e_per_kg ?? Infinity) - (b.facts.carbon_footprint_kg_co2e_per_kg ?? Infinity)
    )
    .slice(0, MAX_CATEGORY_SUGGESTIONS)
    .map((a, i) => ({ ...a, rank: i + 1 }));

  const passing = suggestions.filter((a) => a.buyerDecision !== "rejected").length;
  step(
    steps,
    "buyer_policy",
    "info",
    "Same-category suggestions (not registered substitutes)",
    suggestions.length === 0
      ? `Checked ${candidates.length} other product(s) in category ${originalFacts.category} — none is orderable right now.`
      : `Checked ${candidates.length} other product(s) in category ${originalFacts.category}; showing ${suggestions.length} orderable one(s), ${passing} of which pass this kitchen's checks. A human has to choose — the agent never auto-substitutes an unregistered product.`
  );
  return {
    suggestions,
    note: `The catalog registers no substitutes for this product, so these are other in-stock products from the same catalog category (${originalFacts.category}), run through the same allergen, recipe, carbon and delivery-reliability checks. They are suggestions for a human to review — not catalog-registered substitutes, and never auto-selected.`
  };
}

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

  const sustainability = assessSustainability(steps, line);

  const allowed = compliance.allowed && deliveryDecision.allowed;
  const buyerPolicy: PolicyPanel = {
    status: allowed ? "passed" : "blocked",
    reason: allowed
      ? "No allergen, budget or delivery-date violations against this kitchen's own policy." + sustainabilitySentence(sustainability)
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
      deliveryDateDecision,
      sustainability
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
    deliveryDateDecision,
    sustainability
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

  const sustainability = assessSustainability(steps, line);

  const allowed = compliance.allowed && deliveryDecision.allowed;
  const buyerPolicy: PolicyPanel = {
    status: allowed ? "passed" : "blocked",
    reason: allowed
      ? "Buyer policy clears the product selection and delivery date — no opinion on Aimo's commercial risk." + sustainabilitySentence(sustainability)
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
      deliveryDateDecision,
      sustainability
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
    deliveryDateDecision,
    sustainability
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

  const { alternatives, chosen } = reviewAlternatives(steps, factsOf(unavailable), unavailable.alternatives);

  const buyerPolicy: PolicyPanel = chosen
    ? { status: "passed", reason: `Selected Aimo rank ${chosen.rank}: ${chosen.product_id} (${chosen.name}) — the closest recipe match that also passes this kitchen's allergen, carbon and delivery-reliability rules.` }
    : { status: "blocked", reason: "No disclosed alternative passes this kitchen's policy (allergens, recipe chemistry, carbon, delivery reliability) — reported honestly instead of silently substituting." };
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
    buyerBannedAllergenCodes: HOTEL_ESPOO_POLICY.bannedAllergenCodes,
    originalFacts: factsOf(unavailable),
    alternativesRanking: unavailable.alternatives_ranking
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

/** Scenario 5 — recipe-chemistry substitution. Coffee milk (464237) has three real registered
 *  substitutes in the catalog: an identical smaller pack, a vanilla-flavoured variant and a 10 % cream.
 *  All three are "valid substitutes" by the catalog's own data — but only some keep the kitchen's café
 *  drinks working. The buyer agent asks Aimo for the disclosed substitutes ahead of any stock-out and
 *  pre-qualifies a backup on composition (fat, protein, carbohydrate, sugar, salt, lactose), carbon
 *  intensity and historical delivery reliability. Lookup only — nothing is quoted or ordered. */
export const RECIPE_DEMO_PRODUCT_ID = "464237";

export async function scenario5RecipeChemistry(client: AimoClient = buildClient(), productId: string = RECIPE_DEMO_PRODUCT_ID): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Recipe-chemistry substitution";
  const tagline = "Policy-compliant backup";

  step(steps, "request", "complete", "Buyer request received", `Pre-qualify a policy-compliant backup for product ${productId} before it ever runs out.`);

  let subs;
  try {
    subs = await client.getSubstitutes(productId);
  } catch (err) {
    const message = (err as Error).message;
    if (/\b404\b/.test(message) && !/not_found/.test(message)) {
      throw new Error("The connected Aimo API doesn't expose GET /v1/products/:id/substitutes yet — redeploy apps/aimo-api to enable this scenario.");
    }
    throw err;
  }

  const original = subs.facts;
  const comp = original.composition;
  step(
    steps,
    "quote",
    "complete",
    "Aimo discloses registered substitutes",
    `${subs.name}: ${subs.alternatives.length} registered substitute(s), ranked by Aimo on stock, delivery reliability and price. ${
      comp ? `Original per 100 g: fat ${comp.fat_g ?? "?"} g, protein ${comp.protein_g ?? "?"} g, carbohydrate ${comp.carbohydrate_g ?? "?"} g, sugar ${comp.sugar_g ?? "?"} g, lactose ${comp.lactose_g ?? "?"} g` : "No declared composition for the original"
    }; ${original.carbon_footprint_kg_co2e_per_kg ?? "?"} kg CO2-eq/kg.`,
    subs
  );

  const originalOutOfStock = subs.envelope.claim.availability.status === "out_of_stock";
  if (originalOutOfStock) {
    step(steps, "quote", "blocked", "Requested product is out of stock", `${subs.name} is currently out of stock — it can't be ordered directly.`);
  }

  if (subs.alternatives.length === 0) {
    const fallback = await suggestFromCategory(client, steps, productId, original);
    step(steps, "result", "info", "Buyer decision", "No registered substitutes to evaluate — nothing selected, no order placed.");
    return {
      id: "5",
      name,
      tagline,
      outcome: "no_viable_alternative",
      headline: originalOutOfStock ? "Out of stock — and no registered substitutes" : "No registered substitutes found",
      subheadline: originalOutOfStock
        ? `${subs.name} is out of stock, and Aimo's catalogue has no registered substitutes for it. It can't be ordered right now and there is nothing for the buyer agent to switch to.`
        : `Aimo's catalogue has no registered substitutes for ${subs.name}. No alternatives were available for the buyer agent to evaluate.`,
      transactionId: null,
      transactionIdKind: null,
      ok: true,
      steps,
      buyerPolicy: { status: "info", reason: "No registered substitutes to evaluate — nothing selected, no order placed." },
      aimoPolicy: null,
      quote: null,
      order: null,
      audit: [],
      requestedProduct: { id: subs.product_id, name: subs.name },
      originalFacts: original,
      noRegisteredSubstitutes: true,
      requestedProductOutOfStock: originalOutOfStock,
      categorySuggestions: fallback?.suggestions,
      categorySuggestionsNote: fallback?.note
    };
  }

  const { alternatives, chosen } = reviewAlternatives(steps, original, subs.alternatives);

  const buyerPolicy: PolicyPanel = chosen
    ? {
        status: "passed",
        reason: `Best policy-compliant substitute identified: ${chosen.product_id} (${chosen.name}) — closest nutritional-composition match that also passes this kitchen's allergen, carbon and delivery-reliability rules. These thresholds (recipe tolerance, +${HOTEL_ESPOO_POLICY.maxSubstituteCarbonIncreasePct}% carbon, ${Math.round(HOTEL_ESPOO_POLICY.minDeliveryReliability * 100)}% reliability) are this kitchen's own configured policy, not Aimo's. ${alternatives.filter((a) => a.buyerDecision === "rejected").length} of ${alternatives.length} registered substitutes rejected.`
      }
    : {
        status: "blocked",
        reason: subs.alternatives.length === 0 ? "No substitutes are registered for this product in the catalog." : "None of the registered substitutes clears this kitchen's recipe-compatibility, carbon and delivery-reliability rules — a human has to choose."
      };
  step(steps, "result", chosen ? "complete" : "blocked", "Buyer decision", chosen ? `Backup set to ${chosen.name}.` : "No policy-compliant backup.");

  return {
    id: "5",
    name,
    tagline,
    outcome: chosen ? "substituted" : "no_viable_alternative",
    headline: chosen ? `Best policy-compliant substitute: ${chosen.name}` : "No policy-compliant substitute",
    subheadline: `For ${subs.name} — ${alternatives.filter((a) => a.buyerDecision === "rejected").length} of ${alternatives.length} catalog substitutes rejected on recipe compatibility, carbon or delivery reliability`,
    transactionId: null,
    transactionIdKind: null,
    ok: true,
    steps,
    buyerPolicy,
    aimoPolicy: null,
    quote: null,
    order: null,
    audit: [],
    requestedProduct: { id: subs.product_id, name: subs.name },
    requestedProductOutOfStock: originalOutOfStock,
    alternatives,
    buyerBannedAllergenCodes: HOTEL_ESPOO_POLICY.bannedAllergenCodes,
    originalFacts: original,
    alternativesRanking: subs.alternatives_ranking,
    alternativesNote:
      "Every option below is a real substitute registered in Valio Aimo's catalog. The catalog says it can replace the original; the kitchen's recipe-chemistry check decides whether it actually does."
  };
}

/** Try-it-yourself mode — same real pipeline as scenarios 1/2 (quote → buyer policy → order →
 *  Aimo guardrail → approval if held → audit), but parameterized by any real product from the live
 *  17,546-SKU catalog instead of a hardcoded demo SKU. Reuses the exact same policy engine and guardrail —
 *  nothing about the decision logic is special-cased for the canned scenarios. */
export async function runCustomPurchase(productId: string, qty: number, client: AimoClient = buildClient()): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const name = "Try it yourself";
  const tagline = "Custom purchase";

  step(steps, "request", "complete", "Buyer request received", `${qty.toLocaleString()} unit(s) of product ${productId}, price/availability-driven choice.`);

  const quote = await client.requestQuote(BUYER_ID, [{ product_id: productId, qty }]);
  const line = quote.lines[0];

  if (line.status === "unavailable") {
    step(steps, "quote", "blocked", "Requested product is out of stock", `${line.requested_product_name} is out of stock — it can't be ordered directly. Checking its registered substitutes.`, quote);

    if (line.alternatives.length === 0) {
      const fallback = await suggestFromCategory(client, steps, productId, factsOf(line));
      step(steps, "result", "info", "Buyer decision", "No registered substitutes to evaluate — nothing selected, no order placed.");
      return {
        id: "custom",
        name,
        tagline,
        outcome: "no_viable_alternative",
        headline: "Out of stock — order not placed",
        subheadline: `${line.requested_product_name} is out of stock, and Aimo's catalogue has no registered substitutes for it. Nothing was ordered.`,
        transactionId: quote.quote_id,
        transactionIdKind: "quote",
        ok: true,
        steps,
        buyerPolicy: { status: "info", reason: "No registered substitutes to evaluate — nothing selected, no order placed." },
        aimoPolicy: null,
        quote,
        order: null,
        audit: [],
        requestedProduct: { id: line.requested_product_id, name: line.requested_product_name },
        originalFacts: factsOf(line),
        noRegisteredSubstitutes: true,
        requestedProductOutOfStock: true,
        categorySuggestions: fallback?.suggestions,
        categorySuggestionsNote: fallback?.note
      };
    }

    const { alternatives, chosen } = reviewAlternatives(steps, factsOf(line), line.alternatives);
    const buyerPolicy: PolicyPanel = chosen
      ? { status: "passed", reason: `Selected Aimo rank ${chosen.rank}: ${chosen.product_id} (${chosen.name}) — the closest recipe match that also passes this kitchen's allergen, carbon and delivery-reliability rules.` }
      : { status: "blocked", reason: "No disclosed alternative passes this kitchen's policy (allergens, recipe chemistry, carbon, delivery reliability) — reported honestly instead of silently substituting." };
    step(steps, "result", chosen ? "complete" : "blocked", "Buyer decision", chosen ? "Alternative selected." : "No compliant alternative.");

    return {
      id: "custom",
      name,
      tagline,
      outcome: chosen ? "substituted" : "no_viable_alternative",
      headline: chosen ? `Substitute identified: ${chosen.name}` : "No suitable alternative",
      subheadline: `${line.requested_product_name} is out of stock — ${chosen ? "a policy-compliant registered substitute was found instead" : "none of its registered substitutes passes this kitchen's policy"}. Nothing was ordered.`,
      transactionId: quote.quote_id,
      transactionIdKind: "quote",
      ok: true,
      steps,
      buyerPolicy,
      aimoPolicy: null,
      quote,
      order: null,
      audit: [],
      requestedProduct: { id: line.requested_product_id, name: line.requested_product_name },
      requestedProductOutOfStock: true,
      alternatives,
      buyerBannedAllergenCodes: HOTEL_ESPOO_POLICY.bannedAllergenCodes,
      originalFacts: factsOf(line),
      alternativesRanking: line.alternatives_ranking
    };
  }

  step(steps, "quote", "complete", "Quote obtained", `${formatEur(quote.total_eur)} for ${qty.toLocaleString()} unit(s) of ${line.requested_product_name}.`, quote);

  const compliance = checkCompliance(HOTEL_ESPOO_POLICY, quote.lines);
  const deliveryDecision = checkDeliveryDate(HOTEL_ESPOO_POLICY, quote.requested_delivery_date, line.envelope.claim.availability.confirmed_available_date);
  step(steps, "buyer_policy", deliveryDecision.allowed ? "passed" : "blocked", "Delivery date evaluation", deliveryDecision.reason);

  const sustainability = assessSustainability(steps, line);

  const allowed = compliance.allowed && deliveryDecision.allowed;
  const buyerPolicy: PolicyPanel = {
    status: allowed ? "passed" : "blocked",
    reason: allowed
      ? "No allergen, budget or delivery-date violations against this kitchen's own policy." + sustainabilitySentence(sustainability)
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
      id: "custom",
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
      deliveryDateDecision,
      sustainability
    };
  }

  let order = await client.placeOrder(quote.quote_id);
  const held = order.status === "held_for_approval";
  const aimoPolicy: PolicyPanel = {
    status: held ? "human_review" : "passed",
    reason: held ? (order.approval.reason ?? "Held for Aimo-side review.") : "Within credit limit and auto-approval ceiling."
  };
  step(steps, "aimo_policy", aimoPolicy.status, held ? "Aimo places order on hold" : "Aimo policy check", held ? "Human approval required." : "Passed, auto-approved.");

  let governanceCheck: GovernanceCheckResult | undefined;
  if (held) {
    step(steps, "order", "complete", "Order submitted", `Quote ${quote.quote_id} committed to Aimo for the commercial guardrail check.`);
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
    id: "custom",
    name,
    tagline,
    outcome: held ? "confirmed_after_approval" : "confirmed_auto",
    headline: formatEur(quote.total_eur),
    subheadline: `${qty.toLocaleString()} unit(s) of ${line.requested_product_name}`,
    transactionId: order.order_id,
    transactionIdKind: "order",
    ok: order.status === "confirmed",
    steps,
    buyerPolicy,
    aimoPolicy,
    quote,
    order,
    audit,
    deliveryDateDecision,
    sustainability,
    governanceCheck
  };
}

export const SCENARIOS = [
  { id: "1", fn: scenario1Autonomous },
  { id: "2", fn: scenario2TwoSidedApproval },
  { id: "3", fn: scenario3StockOutSubstitution },
  { id: "4", fn: scenario4PartialAvailability },
  { id: "5", fn: scenario5RecipeChemistry }
] as const;

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const client = buildClient();
  return [
    await scenario1Autonomous(client),
    await scenario2TwoSidedApproval(client),
    await scenario3StockOutSubstitution(client),
    await scenario4PartialAvailability(client),
    await scenario5RecipeChemistry(client)
  ];
}
