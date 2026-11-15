import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProductFacts, QuoteAlternative, QuoteLine, RecipeComposition } from "@aimo/shared";
import {
  HOTEL_ESPOO_POLICY as POLICY,
  checkBudget,
  checkCompliance,
  checkDeliveryDate,
  checkReliability,
  checkSubstituteCarbon,
  estimateOrderFootprint,
  evaluateRecipeChemistry,
  evaluateSubstitutes
} from "../lib/policyEngine";

// Baseline for the demo's buyer-side policy engine: pure functions, no network. These pin the
// behaviour the Junction26 scenarios depend on before any of it is moved onto tenant-owned policy.

const envelope = {} as QuoteLine["envelope"];
const cream = (fat: number, extra: Partial<RecipeComposition> = {}): RecipeComposition => ({ fat_g: fat, protein_g: 2, carbohydrate_g: 3, sugar_g: 3, salt_g: 0.1, lactose_g: 3, ...extra });
const facts = (over: Partial<ProductFacts> = {}): ProductFacts => ({
  category: "cream",
  carbon_footprint_kg_co2e_per_kg: 2,
  delivery_reliability: 0.98,
  net_weight_kg_per_sales_unit: 1,
  composition: cream(38),
  ...over
});
const alt = (id: string, rank: number, over: Partial<QuoteAlternative> = {}, f: Partial<ProductFacts> = {}): QuoteAlternative => ({
  rank,
  product_id: id,
  name: `Alt ${id}`,
  price_eur: 1,
  availability: { status: "in_stock", quantity: 10, confirmed_available_date: null },
  delivery_lead_time_days: null,
  allergens: [],
  facts: facts(f),
  envelope,
  ...over
});

describe("allergen compliance", () => {
  const line = (over: Partial<QuoteLine>): QuoteLine => ({
    requested_product_id: "p",
    requested_product_name: "Product",
    requested_qty: 1,
    status: "available",
    unit_price_eur: 1,
    line_total_eur: 1,
    alternatives: [],
    envelope,
    ...over
  });

  it("blocks a requested product that contains a banned allergen", () => {
    const d = checkCompliance(POLICY, [line({ allergens: [{ code: "AW", relation: "CONTAINS", label: null }] })]);
    assert.equal(d.allowed, false);
  });
  it("does not block a FREE_FROM declaration of the same code", () => {
    assert.equal(checkCompliance(POLICY, [line({ allergens: [{ code: "AW", relation: "FREE_FROM", label: null }] })]).allowed, true);
  });
  it("checks the alternatives of an unavailable line", () => {
    const d = checkCompliance(POLICY, [line({ status: "unavailable", alternatives: [alt("a", 1, { allergens: [{ code: "AW", relation: "CONTAINS", label: null }] })] })]);
    assert.equal(d.allowed, false);
    assert.match(d.reasons[0], /AW/);
  });
});

describe("budget", () => {
  it("has no buyer-side cap when the policy sets none", () => {
    assert.equal(checkBudget(POLICY, 1_000_000).allowed, true);
  });
  it("allows the cap exactly and blocks above it", () => {
    const capped = { ...POLICY, maxBudgetEur: 500 };
    assert.equal(checkBudget(capped, 500).allowed, true);
    assert.equal(checkBudget(capped, 500.01).allowed, false);
  });
});

describe("delivery date tolerance", () => {
  it("accepts on time and within tolerance, rejects beyond it", () => {
    assert.equal(checkDeliveryDate(POLICY, "2026-11-16", "2026-11-16").allowed, true);
    assert.equal(checkDeliveryDate(POLICY, "2026-11-16", "2026-11-17").allowed, true);
    const late = checkDeliveryDate(POLICY, "2026-11-16", "2026-11-18");
    assert.equal(late.allowed, false);
    assert.equal(late.deviationDays, 2);
  });
});

describe("delivery reliability", () => {
  it("treats unknown reliability as unknown (warn), never as a pass or as zero", () => {
    const r = checkReliability(POLICY, null);
    assert.equal(r.status, "warn");
    assert.match(r.detail, /unknown/);
  });
  it("fails below the minimum and passes at it", () => {
    assert.equal(checkReliability(POLICY, 0.949).status, "fail");
    assert.equal(checkReliability(POLICY, 0.95).status, "pass");
  });
});

describe("substitute carbon", () => {
  it("fails above the limit and passes at it", () => {
    assert.equal(checkSubstituteCarbon(POLICY, 2, 2.4).status, "pass");
    assert.equal(checkSubstituteCarbon(POLICY, 2, 3.3).status, "fail");
  });
  it("warns when the substitute discloses no figure", () => {
    assert.equal(checkSubstituteCarbon(POLICY, 2, null).status, "warn");
  });
});

describe("order footprint", () => {
  it("multiplies quantity, net weight and intensity", () => {
    assert.equal(estimateOrderFootprint(facts({ carbon_footprint_kg_co2e_per_kg: 1.13, net_weight_kg_per_sales_unit: 1 }), 1000).totalKgCo2e, 1130);
  });
  it("reports no total when weight or intensity is missing, instead of zero", () => {
    assert.equal(estimateOrderFootprint(facts({ net_weight_kg_per_sales_unit: null }), 10).totalKgCo2e, null);
    assert.equal(estimateOrderFootprint(facts({ carbon_footprint_kg_co2e_per_kg: null }), 10).totalKgCo2e, null);
  });
});

describe("recipe chemistry", () => {
  it("accepts 35 % cream for 38 % but not 10 % for 15 %", () => {
    assert.equal(evaluateRecipeChemistry(POLICY, cream(38), cream(35)).verdict, "compatible");
    assert.equal(evaluateRecipeChemistry(POLICY, cream(15), cream(10)).verdict, "breaks_recipe");
  });
  it("is unverified, not compatible, when composition is missing", () => {
    assert.equal(evaluateRecipeChemistry(POLICY, cream(38), null).verdict, "unverified");
    assert.equal(evaluateRecipeChemistry(POLICY, null, cream(38)).score, null);
  });
  it("refuses a substitute that cannot be confirmed lactose-free for a lactose-free original", () => {
    const original = cream(38, { lactose_g: 0 });
    assert.equal(evaluateRecipeChemistry(POLICY, original, cream(38, { lactose_g: 3 })).verdict, "breaks_recipe");
    assert.equal(evaluateRecipeChemistry(POLICY, original, cream(38, { lactose_g: null })).lactoseRegression, true);
  });
});

describe("substitute selection", () => {
  it("picks the closest recipe match, not the supplier's top rank", () => {
    const { chosen } = evaluateSubstitutes(POLICY, facts(), [alt("far", 1, {}, { composition: cream(36.5) }), alt("exact", 2, {}, { composition: cream(38) })]);
    assert.equal(chosen?.alt.product_id, "exact");
  });
  it("never auto-selects an out-of-stock, allergen-banned or recipe-breaking substitute", () => {
    const { chosen, evaluations } = evaluateSubstitutes(POLICY, facts(), [
      alt("oos", 1, { availability: { status: "out_of_stock", quantity: 0, confirmed_available_date: null } }),
      alt("nuts", 2, { allergens: [{ code: "AW", relation: "CONTAINS", label: null }] }),
      alt("thin", 3, {}, { composition: cream(10) })
    ]);
    assert.equal(chosen, null);
    assert.ok(evaluations.every((e) => !e.eligible));
  });
  it("leaves a substitute with unknown delivery history to a human instead of auto-selecting it", () => {
    const { chosen, evaluations } = evaluateSubstitutes(POLICY, facts(), [alt("nohistory", 1, {}, { delivery_reliability: null })]);
    assert.equal(chosen, null);
    assert.equal(evaluations[0].eligible, true);
    assert.equal(evaluations[0].autoEligible, false);
  });
  it("does not auto-select when stock status is unknown", () => {
    const { chosen } = evaluateSubstitutes(POLICY, facts(), [alt("unknown", 1, { availability: { status: "unknown", quantity: null, confirmed_available_date: null } })]);
    assert.equal(chosen, null);
  });
});
