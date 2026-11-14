import type { AllergenFact } from "@aimo/shared";

/**
 * The dataset's `allergen`/`nonAllergen` classification groups use opaque
 * 2-3 letter GS1/Synkka codes (e.g. "AE", "BM") with no dictionary supplied
 * — same limitation the schema documents for unit codes like "KI". Rather
 * than guess a GS1 code table (risky to get wrong in a food-allergy
 * context), we disclose the raw code and relation verbatim and leave
 * `label` null. This is the honest answer, not a shortcut: Aimo's job here
 * is disclosure, not interpretation — the buyer's policy engine is what
 * knows what a code means to its own kitchen.
 */
export function extractAllergenFacts(classifications: any[]): AllergenFact[] {
  const facts: AllergenFact[] = [];
  for (const group of classifications ?? []) {
    if (group.name !== "allergen" && group.name !== "nonAllergen") continue;
    for (const value of group.values ?? []) {
      if (!value.id || !value.unit) continue;
      facts.push({ code: value.id, relation: value.unit, label: null });
    }
  }
  return facts;
}

/** Human-readable free-from dietary claims, the one part of this dataset that IS labeled. */
export function extractFreeFromClaims(classifications: any[]): string[] {
  const claims: string[] = [];
  for (const group of classifications ?? []) {
    if (group.name !== "nutritionalClaim") continue;
    for (const value of group.values ?? []) {
      if (value.unit === "FREE_FROM" && value.synkkaId) {
        claims.push(String(value.synkkaId).toLowerCase());
      }
    }
  }
  return claims;
}
