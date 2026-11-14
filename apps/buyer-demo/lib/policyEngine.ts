import type { AllergenFact, ProductFacts, QuoteAlternative, QuoteLine, RecipeComposition } from "@aimo/shared";
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
export type RecipeComponent = "fat_g" | "protein_g" | "carbohydrate_g" | "sugar_g" | "salt_g";

/** How far (grams per 100 g) a substitute may drift from the original before it stops doing the
 *  same job in a recipe. The allowed drift is the larger of the absolute figure and the relative
 *  share of the original value — 35 % vs 38 % whipping cream still whips; 10 % vs 15 % cooking
 *  cream splits in a reduced sauce. */
export interface RecipeTolerance {
  absolute: Record<RecipeComponent, number>;
  relative: number;
}

export interface KitchenPolicy {
  bannedAllergenCodes: string[]; // codes this kitchen's menu must never contain
  maxBudgetEur: number | null; // null = no local cap, defer to Aimo-side credit check
  maxDeliveryDeviationDays: number; // how many days later than requested this kitchen will still accept
  /** Minimum historical delivery reliability (0–1) for a product the agent picks on its own. */
  minDeliveryReliability: number;
  /** A substitute may not raise carbon intensity (kg CO2-eq/kg) by more than this % over the original. */
  maxSubstituteCarbonIncreasePct: number;
  recipeTolerance: RecipeTolerance;
}

export const HOTEL_ESPOO_POLICY: KitchenPolicy = {
  // AW = tree nuts (this kitchen's own internal translation of the GS1 code).
  bannedAllergenCodes: ["AW"],
  maxBudgetEur: null,
  maxDeliveryDeviationDays: 1,
  minDeliveryReliability: 0.95,
  maxSubstituteCarbonIncreasePct: 20,
  recipeTolerance: {
    absolute: { fat_g: 2, protein_g: 1.5, carbohydrate_g: 2.5, sugar_g: 2.5, salt_g: 0.3 },
    relative: 0.1
  }
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

export const EMPTY_FACTS: ProductFacts = {
  category: null,
  carbon_footprint_kg_co2e_per_kg: null,
  delivery_reliability: null,
  net_weight_kg_per_sales_unit: null,
  composition: null
};

/** Facts are absent when talking to an Aimo server older than this contract version. */
export function factsOf(x: { facts?: ProductFacts } | null | undefined): ProductFacts {
  return x?.facts ?? EMPTY_FACTS;
}

// ---------------------------------------------------------------------------
// Recipe chemistry
// ---------------------------------------------------------------------------

export const RECIPE_COMPONENTS: { key: RecipeComponent; label: string; role: string }[] = [
  { key: "fat_g", label: "Fat", role: "texture, mouthfeel, emulsion stability" },
  { key: "protein_g", label: "Protein", role: "structure, setting, foaming" },
  { key: "carbohydrate_g", label: "Carbohydrate", role: "body, thickening, browning" },
  { key: "sugar_g", label: "Sugar", role: "sweetness, caramelisation" },
  { key: "salt_g", label: "Salt", role: "seasoning, preservation" }
];

/** At or below this (g lactose / 100 g) a product counts as lactose-free (Finnish/EU practice). */
const LACTOSE_FREE_MAX_G = 0.01;

export interface ComponentDelta {
  key: RecipeComponent;
  label: string;
  role: string;
  original: number;
  substitute: number;
  delta: number;
  tolerance: number;
  withinTolerance: boolean;
}

export interface RecipeChemistryResult {
  verdict: "compatible" | "breaks_recipe" | "unverified";
  /** 0–100, how closely the substitute's composition tracks the original's. null when unverified. */
  score: number | null;
  deltas: ComponentDelta[];
  lactoseRegression: boolean;
  summary: string;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Compares a substitute's declared per-100 g composition to the original's, component by
 *  component, against this kitchen's tolerance. Pure function of the two disclosures. */
export function evaluateRecipeChemistry(policy: KitchenPolicy, original: RecipeComposition | null, substitute: RecipeComposition | null): RecipeChemistryResult {
  const deltas: ComponentDelta[] = [];
  for (const c of RECIPE_COMPONENTS) {
    const o = original?.[c.key];
    const s = substitute?.[c.key];
    if (o === null || o === undefined || s === null || s === undefined) continue;
    const tolerance = Math.max(policy.recipeTolerance.absolute[c.key], policy.recipeTolerance.relative * o);
    const delta = s - o;
    deltas.push({ key: c.key, label: c.label, role: c.role, original: o, substitute: s, delta, tolerance, withinTolerance: Math.abs(delta) <= tolerance + 1e-9 });
  }

  const origLactose = original?.lactose_g;
  const subLactose = substitute?.lactose_g;
  const originalLactoseFree = origLactose !== null && origLactose !== undefined && origLactose <= LACTOSE_FREE_MAX_G;
  const lactoseRegression = originalLactoseFree && (subLactose === null || subLactose === undefined || subLactose > LACTOSE_FREE_MAX_G);

  const broken = deltas.filter((d) => !d.withinTolerance);
  if (broken.length > 0 || lactoseRegression) {
    const parts = broken.map(
      (d) => `${d.label} ${d.original} → ${d.substitute} g/100 g (${d.delta > 0 ? "+" : ""}${round1(d.delta)}, tolerance ±${round1(d.tolerance)}) changes ${d.role}`
    );
    if (lactoseRegression) {
      parts.push(
        subLactose === null || subLactose === undefined
          ? "original is lactose-free but the substitute declares no lactose content, so lactose-free can't be confirmed"
          : `original is lactose-free but the substitute declares ${subLactose} g lactose/100 g`
      );
    }
    const score = deltas.length > 0 ? scoreFor(deltas) : null;
    return { verdict: "breaks_recipe", score, deltas, lactoseRegression, summary: `Breaks the recipe: ${parts.join("; ")}.` };
  }

  if (deltas.length < 2) {
    return {
      verdict: "unverified",
      score: null,
      deltas,
      lactoseRegression,
      summary: "Not enough declared composition on both products to verify recipe compatibility."
    };
  }

  const score = scoreFor(deltas);
  const drifts = deltas.filter((d) => Math.abs(d.delta) > 1e-9);
  return {
    verdict: "compatible",
    score,
    deltas,
    lactoseRegression,
    summary:
      drifts.length === 0
        ? `Identical declared composition across ${deltas.length} components — a drop-in replacement.`
        : `Within tolerance on all ${deltas.length} compared components (largest drift: ${largestDrift(drifts)}).`
  };
}

function scoreFor(deltas: ComponentDelta[]): number {
  const mean = deltas.reduce((sum, d) => sum + Math.min(Math.abs(d.delta) / d.tolerance, 1), 0) / deltas.length;
  return Math.round(100 * (1 - mean));
}

function largestDrift(deltas: ComponentDelta[]): string {
  const d = [...deltas].sort((a, b) => Math.abs(b.delta) / b.tolerance - Math.abs(a.delta) / a.tolerance)[0];
  return `${d.label.toLowerCase()} ${d.delta > 0 ? "+" : ""}${round1(d.delta)} g/100 g`;
}

// ---------------------------------------------------------------------------
// Carbon footprint
// ---------------------------------------------------------------------------

export interface OrderFootprint {
  intensityKgCo2ePerKg: number | null;
  netWeightKgPerUnit: number | null;
  totalWeightKg: number | null;
  totalKgCo2e: number | null;
  note: string;
}

/** Order-level footprint: quantity × net weight per sales unit × kg CO2-eq per kg. */
export function estimateOrderFootprint(facts: ProductFacts, qty: number): OrderFootprint {
  const intensity = facts.carbon_footprint_kg_co2e_per_kg;
  const weight = facts.net_weight_kg_per_sales_unit;
  const totalWeightKg = weight !== null ? Math.round(weight * qty * 10) / 10 : null;
  const totalKgCo2e = intensity !== null && weight !== null ? Math.round(intensity * weight * qty) : null;
  let note: string;
  if (intensity === null) note = "No carbon footprint figure is disclosed for this product.";
  else if (weight === null) note = `${intensity} kg CO2-eq per kg disclosed, but no net weight per sales unit — order total can't be computed.`;
  else note = `${qty.toLocaleString("en-US")} × ${weight} kg × ${intensity} kg CO2-eq/kg ≈ ${totalKgCo2e!.toLocaleString("en-US")} kg CO2-eq.`;
  return { intensityKgCo2ePerKg: intensity, netWeightKgPerUnit: weight, totalWeightKg, totalKgCo2e, note };
}

export interface CheckResult {
  check: "availability" | "allergens" | "recipe" | "carbon" | "reliability";
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface CarbonCheckResult extends CheckResult {
  check: "carbon";
  deltaPct: number | null;
  originalIntensity: number | null;
  substituteIntensity: number | null;
  limitPct: number;
}

export function checkSubstituteCarbon(policy: KitchenPolicy, original: number | null, substitute: number | null): CarbonCheckResult {
  const limitPct = policy.maxSubstituteCarbonIncreasePct;
  if (substitute === null) {
    return { check: "carbon", status: "warn", deltaPct: null, originalIntensity: original, substituteIntensity: null, limitPct, detail: "No carbon footprint disclosed for this substitute — can't confirm it isn't a regression." };
  }
  if (original === null) {
    return { check: "carbon", status: "pass", deltaPct: null, originalIntensity: null, substituteIntensity: substitute, limitPct, detail: `${substitute} kg CO2-eq/kg (original has no disclosed figure to compare against).` };
  }
  const deltaPct = Math.round(((substitute - original) / original) * 100);
  if (deltaPct > limitPct) {
    return {
      check: "carbon",
      status: "fail",
      deltaPct,
      originalIntensity: original,
      substituteIntensity: substitute,
      limitPct,
      detail: `${original} → ${substitute} kg CO2-eq/kg (+${deltaPct} %) exceeds this kitchen's +${limitPct} % limit for substitutes.`
    };
  }
  return {
    check: "carbon",
    status: "pass",
    deltaPct,
    originalIntensity: original,
    substituteIntensity: substitute,
    limitPct,
    detail: deltaPct === 0 ? `Same carbon intensity (${substitute} kg CO2-eq/kg).` : `${original} → ${substitute} kg CO2-eq/kg (${deltaPct > 0 ? "+" : ""}${deltaPct} %).`
  };
}

// ---------------------------------------------------------------------------
// Delivery reliability
// ---------------------------------------------------------------------------

/** The challenge's delivery-reliability file discloses a single aggregate on-time ratio per SKU —
 *  no delivery count or measurement period. Say that plainly rather than implying more precision
 *  than the data actually has. */
export const RELIABILITY_DISCLOSURE_CAVEAT =
  "This is Valio Aimo's challenge-supplied aggregate on-time-delivery ratio for the SKU; the dataset doesn't disclose the underlying delivery count or measurement period.";

export function checkReliability(policy: KitchenPolicy, reliability: number | null): CheckResult {
  const min = `${Math.round(policy.minDeliveryReliability * 100)} %`;
  if (reliability === null) {
    return { check: "reliability", status: "warn", detail: "No delivery history disclosed for this SKU — reliability unknown, so it can't be auto-selected on its own; a human can still choose it." };
  }
  const pct = `${Math.round(reliability * 1000) / 10} %`;
  if (reliability < policy.minDeliveryReliability) {
    return { check: "reliability", status: "fail", detail: `Historically delivered as promised ${pct} of the time — below this kitchen's ${min} minimum.` };
  }
  return { check: "reliability", status: "pass", detail: `Historically delivered as promised ${pct} of the time (minimum ${min}).` };
}

// ---------------------------------------------------------------------------
// Substitute selection
// ---------------------------------------------------------------------------

export interface SubstituteEvaluation {
  alt: QuoteAlternative;
  /** Doesn't fail any check — shown as a real option, but may still need a human (see autoEligible). */
  eligible: boolean;
  /** Passes every check cleanly, no unknowns — the only tier the agent will pick automatically. */
  autoEligible: boolean;
  checks: CheckResult[];
  recipe: RecipeChemistryResult;
  carbon: CarbonCheckResult;
  carbonDeltaPct: number | null;
}

/**
 * Runs every disclosed alternative through this kitchen's full substitution policy — stock,
 * allergens, recipe chemistry, carbon and delivery reliability — and picks the best eligible one:
 * closest recipe match first, then lower carbon intensity, then Aimo's own rank. Aimo's ranking
 * is an input, not the decision.
 */
export function evaluateSubstitutes(
  policy: KitchenPolicy,
  originalFacts: ProductFacts,
  alternatives: QuoteAlternative[]
): { evaluations: SubstituteEvaluation[]; chosen: SubstituteEvaluation | null } {
  const evaluations = [...alternatives]
    .sort((a, b) => a.rank - b.rank)
    .map((alt): SubstituteEvaluation => {
      const facts = factsOf(alt);
      const checks: CheckResult[] = [];

      const status = alt.availability.status;
      const available = status === "in_stock" || status === "terminal_supplier";
      checks.push({
        check: "availability",
        status: available ? "pass" : "fail",
        detail: available ? (status === "terminal_supplier" ? "Available (supplier-fulfilled)." : "In stock.") : `Not orderable right now (${status.replace(/_/g, " ")}).`
      });

      const hits = violatesBan(alt.allergens, policy.bannedAllergenCodes);
      checks.push({
        check: "allergens",
        status: hits.length > 0 ? "fail" : "pass",
        detail: hits.length > 0 ? `Contains banned allergen code(s) ${hits.join(", ")} per this kitchen's policy.` : "No banned allergen codes."
      });

      const recipe = evaluateRecipeChemistry(policy, originalFacts.composition, facts.composition);
      const sameCategory = originalFacts.category !== null && originalFacts.category === facts.category;
      checks.push({
        check: "recipe",
        status: recipe.verdict === "compatible" ? "pass" : recipe.verdict === "breaks_recipe" ? "fail" : sameCategory ? "warn" : "fail",
        detail:
          recipe.verdict === "unverified"
            ? sameCategory
              ? `${recipe.summary} Accepted only because it's in the same product category.`
              : `${recipe.summary} Different product category, so not auto-substituted.`
            : recipe.summary
      });

      const carbon = checkSubstituteCarbon(policy, originalFacts.carbon_footprint_kg_co2e_per_kg, facts.carbon_footprint_kg_co2e_per_kg);
      checks.push({ check: carbon.check, status: carbon.status, detail: carbon.detail });

      checks.push(checkReliability(policy, facts.delivery_reliability));

      return {
        alt,
        eligible: checks.every((c) => c.status !== "fail"),
        autoEligible: checks.every((c) => c.status === "pass"),
        checks,
        recipe,
        carbon,
        carbonDeltaPct: carbon.deltaPct
      };
    });

  const chosen =
    [...evaluations]
      .filter((e) => e.autoEligible)
      .sort((a, b) => {
        const sa = a.recipe.score ?? -1;
        const sb = b.recipe.score ?? -1;
        if (sa !== sb) return sb - sa;
        const ca = factsOf(a.alt).carbon_footprint_kg_co2e_per_kg ?? Infinity;
        const cb = factsOf(b.alt).carbon_footprint_kg_co2e_per_kg ?? Infinity;
        if (ca !== cb) return ca - cb;
        return a.alt.rank - b.alt.rank;
      })[0] ?? null;

  return { evaluations, chosen };
}

export interface DeliveryDateDecision {
  allowed: boolean;
  deviationDays: number | null;
  reason: string;
  policyVersion: string;
}

/** Evaluates the supplier's confirmed delivery date against what the buyer actually requested —
 *  a real policy check, not narrative: an order only proceeds if the deviation is within this
 *  kitchen's own tolerance, exactly like the allergen and budget checks above. */
export function checkDeliveryDate(policy: KitchenPolicy, requestedDate: string, confirmedDate: string | null): DeliveryDateDecision {
  if (confirmedDate === null) {
    return {
      allowed: true,
      deviationDays: null,
      reason: "Supplier returned no confirmed delivery date for this line — nothing to evaluate yet.",
      policyVersion: POLICY_VERSION_BUYER
    };
  }

  const deviationDays = Math.round((new Date(confirmedDate).getTime() - new Date(requestedDate).getTime()) / 86400000);

  if (deviationDays <= policy.maxDeliveryDeviationDays) {
    return {
      allowed: true,
      deviationDays,
      reason:
        deviationDays <= 0
          ? `Supplier confirmed delivery on or before the requested date (${requestedDate}).`
          : `Supplier confirmed delivery ${deviationDays} day(s) later than requested (${requestedDate} → ${confirmedDate}) — within this kitchen's ${policy.maxDeliveryDeviationDays}-day tolerance.`,
      policyVersion: POLICY_VERSION_BUYER
    };
  }

  return {
    allowed: false,
    deviationDays,
    reason: `Supplier confirmed delivery ${deviationDays} day(s) later than requested (${requestedDate} → ${confirmedDate}) — exceeds this kitchen's ${policy.maxDeliveryDeviationDays}-day tolerance.`,
    policyVersion: POLICY_VERSION_BUYER
  };
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
