/**
 * LLM proposal layer over the real 17,546-SKU catalog. Three features share one pattern:
 *
 *   1. the LLM turns a fuzzy human need into short catalog-style keyword queries,
 *   2. candidates are retrieved LOCALLY from data/catalog-index.json (no bulk upstream calls),
 *   3. the LLM picks from those candidates only — every returned id is validated server-side,
 *   4. live price / stock / allergens for the picks come from aimo-api, exactly as for a manual search.
 *
 * The LLM never sees or touches policy decisions. Anything it proposes is "suggest-only" until it
 * goes through the normal quote → buyer policy → supplier policy pipeline.
 */
import type { ProductLookupResult } from "@aimo/shared";
import catalogIndex from "../data/catalog-index.json";
import { chatJSON } from "./llm";
import { buildClient } from "./scenarios";
import { HOTEL_ESPOO_POLICY } from "./policyEngine";

/** Mirrors page.tsx's client-side check: a product that reads as relevant to the need but is
 *  out of stock or contains a banned allergen must never be presented as if it were a clean
 *  recommendation — the AI's own "why" would otherwise contradict the buyer policy that blocks it. */
function policyCaveat(r: ProductLookupResult): string | null {
  const bannedHits = r.allergens.filter((a) => a.relation === "CONTAINS" && HOTEL_ESPOO_POLICY.bannedAllergenCodes.includes(a.code)).map((a) => a.code);
  const reasons: string[] = [];
  if (r.envelope.claim.availability.status === "out_of_stock") reasons.push("it is out of stock");
  if (bannedHits.length > 0) reasons.push(`it contains banned allergen code${bannedHits.length > 1 ? "s" : ""} ${bannedHits.join(", ")}`);
  if (reasons.length === 0) return null;
  return `Potential catalogue match — blocked by buyer policy. This product looks relevant, but ${reasons.join(" and ")}. It can't be ordered directly.`;
}

type Row = [id: string, en: string, fi: string];
const ROWS = catalogIndex as Row[];
const NAME_BY_ID = new Map(ROWS.map((r) => [r[0], r[1]]));
const HAYSTACK = ROWS.map((r) => normalize(`${r[1]} ${r[2]}`));

const STOPWORDS = new Set(["a", "an", "the", "and", "or", "for", "of", "with", "in", "to", "x", "pcs"]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_/,()]+/g, " ").replace(/\s+/g, " ");
}

function tokens(q: string): string[] {
  return normalize(q)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface Candidate {
  id: string;
  name: string;
}

/** Token-AND match over English + Finnish names. Queries of 3+ tokens may miss one token. */
export function retrieveLocal(query: string, limit = 12): Candidate[] {
  const toks = tokens(query);
  if (toks.length === 0) return [];
  const need = toks.length >= 3 ? toks.length - 1 : toks.length;
  const scored: { i: number; score: number; len: number }[] = [];
  for (let i = 0; i < HAYSTACK.length; i++) {
    const hay = HAYSTACK[i];
    let score = 0;
    for (const t of toks) if (hay.includes(t)) score++;
    if (score >= need) scored.push({ i, score, len: ROWS[i][1].length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.slice(0, limit).map(({ i }) => ({ id: ROWS[i][0], name: ROWS[i][1] }));
}

function pool(queries: string[], perQuery: number, cap: number): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const q of queries) {
    for (const c of retrieveLocal(q, perQuery)) {
      if (!seen.has(c.id)) seen.set(c.id, c);
      if (seen.size >= cap) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

function candidateList(cands: Candidate[]): string {
  return cands.map((c) => `${c.id} | ${c.name}`).join("\n");
}

/** Live trust envelope for each id via aimo-api's normal product lookup (searched by exact name). */
export async function resolveLive(ids: string[]): Promise<Map<string, ProductLookupResult>> {
  const client = buildClient();
  const out = new Map<string, ProductLookupResult>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const name = NAME_BY_ID.get(id);
      if (!name) return;
      try {
        const { results } = await client.lookupProducts({ query: name });
        const hit = results.find((r) => r.envelope.claim.product_id === id);
        if (hit) out.set(id, hit);
      } catch {
        // A single failed lookup shouldn't sink the whole suggestion set.
      }
    })
  );
  return out;
}

/** Rank-preserving, but an out-of-stock pick drops behind anything orderable; unpriced picks are dropped. */
function stockRank(r: ProductLookupResult | undefined): number {
  if (!r) return 3;
  return r.envelope.claim.availability.status === "out_of_stock" ? 1 : 0;
}
function preferAvailable(ids: string[], live: Map<string, ProductLookupResult>, n: number): string[] {
  return ids
    .map((id, rank) => ({ id, rank, s: stockRank(live.get(id)) }))
    .filter((x) => x.s < 3)
    .sort((a, b) => a.s - b.s || a.rank - b.rank)
    .slice(0, n)
    .map((x) => x.id);
}

/** Grounding so the model doesn't guess Finnish seasonality (it put crayfish in November untold). */
const FINNISH_SEASONS = `Finnish foodservice seasonality guide:
Jan: storage root vegetables, burbot, citrus. Feb: Runeberg tortes (5 Feb), Shrove buns (laskiaispulla), burbot. Mar-Apr: Easter (mämmi, lamb, pasha), rhubarb starts late Apr.
May: Vappu (sima, munkki doughnuts), asparagus, first greens. Jun: new potatoes, Juhannus midsummer (grilling, herring, salmon), strawberries late Jun.
Jul: berries (blueberry, strawberry), chanterelles, crayfish season opens 21 Jul. Aug: crayfish parties, mushrooms, new harvest vegetables. Sep: mushrooms, apples, lingonberries, game season starts.
Oct: game (moose, reindeer), Baltic herring market, cabbage, pumpkin/Halloween. Nov: Father's Day (2nd Sunday), Pikkujoulu Christmas parties begin, game, root vegetables, glögi, gingerbread.
Dec: Independence Day (6 Dec), Christmas (ham, rosolli beetroot salad, lutefisk, casseroles, rice porridge, gingerbread, glögi), New Year.`;

const KEYWORD_RULES = `Catalog search matches product NAMES only (English and Finnish), token by token.
Write each query as 1-3 short words that would literally appear in a wholesale product name,
e.g. "lactose free cream", "salmon fillet", "oat drink", "gingerbread", "reindeer".
No adjectives like "delicious", no sentences.`;

// ---------------------------------------------------------------------------------------------
// 1. Semantic catalog search
// ---------------------------------------------------------------------------------------------

export interface AiSearchResult {
  mode: "ai";
  interpretation: string;
  queries: string[];
  results: (ProductLookupResult & { ai_reason?: string })[];
}

export async function aiSearch(userQuery: string): Promise<AiSearchResult> {
  const plan = await chatJSON<{ interpretation: string; queries: string[] }>([
    {
      role: "system",
      content: `You help a professional hotel kitchen buyer in Finland search a foodservice wholesale catalog of 17,546 products.
${KEYWORD_RULES}
Return JSON: {"interpretation": "<one short sentence restating what the buyer needs>", "queries": ["...", ...]} with 4-8 queries covering different ways the need could be satisfied.`
    },
    { role: "user", content: userQuery }
  ]);

  const queries = (plan.queries ?? []).filter((q) => typeof q === "string").slice(0, 8);
  const candidates = pool([userQuery, ...queries], 10, 70);
  if (candidates.length === 0) return { mode: "ai", interpretation: plan.interpretation ?? "", queries, results: [] };

  const ranked = await chatJSON<{ picks: { id: string; why: string }[] }>([
    {
      role: "system",
      content: `You rank wholesale catalog products for a hotel kitchen buyer. Pick ONLY products from the candidate list that genuinely fit the need — exclude non-food items and poor matches. Best fit first, at most 8.
Return JSON: {"picks": [{"id": "<id from list>", "why": "<max 12 words: why it fits>"}]}`
    },
    { role: "user", content: `Need: ${userQuery}\n\nCandidates (id | name):\n${candidateList(candidates)}` }
  ]);

  const valid = new Set(candidates.map((c) => c.id));
  const picks = (ranked.picks ?? []).filter((p) => valid.has(String(p.id))).slice(0, 8);
  const live = await resolveLive(picks.map((p) => String(p.id)));
  const results = picks
    .map((p) => {
      const r = live.get(String(p.id));
      return r ? { ...r, ai_reason: policyCaveat(r) ?? p.why } : null;
    })
    .filter((r): r is ProductLookupResult & { ai_reason: string } => r !== null);

  return { mode: "ai", interpretation: plan.interpretation ?? "", queries, results };
}

// ---------------------------------------------------------------------------------------------
// 6. Seasonal proactive suggestions (suggest-only)
// ---------------------------------------------------------------------------------------------

export interface SeasonalTheme {
  title: string;
  pitch: string;
  products: (ProductLookupResult & { ai_reason?: string })[];
}

export interface SeasonalSuggestions {
  date: string;
  season: string;
  themes: SeasonalTheme[];
}

const seasonalCache = new Map<string, SeasonalSuggestions>();

export async function seasonalSuggestions(date = new Date()): Promise<SeasonalSuggestions> {
  const day = date.toISOString().slice(0, 10);
  const cached = seasonalCache.get(day);
  if (cached) return cached;

  const plan = await chatJSON<{ season: string; themes: { title: string; why: string; queries: string[] }[] }>(
    [
      {
        role: "system",
        content: `You are Aimo AI, the proactive selling assistant of a Finnish foodservice wholesaler. The customer is a hotel restaurant kitchen in Espoo, Finland.
Given today's exact date, propose 3 timely menu themes driven by Finnish seasonality: produce and fish in season, game season, and upcoming holidays/events within the next ~6 weeks. Only use what the guide lists for this or next month.
A named day-specific event (e.g. a holiday on a specific date) that already fell earlier THIS month, before today's date, is in the past — never present it as upcoming. You may still reference the season or occasion it belongs to (e.g. "Pikkujoulu party season continues") if that's still current, but don't claim the specific past date is still ahead.
These are seasonality-driven suggestions you are reasoning about, not observed sales or demand data — don't claim products are "trending" or imply you have sales evidence.
${FINNISH_SEASONS}
${KEYWORD_RULES}
Return JSON: {"season": "<one sentence on what is seasonal right now>", "themes": [{"title": "<3-6 words>", "why": "<one sentence>", "queries": ["...", "..."]}]} with 3-5 queries per theme.`
      },
      { role: "user", content: `Today is ${day}.` }
    ],
    { temperature: 0.5 }
  );

  const themes = (plan.themes ?? []).slice(0, 3).map((t) => ({ ...t, candidates: pool(t.queries ?? [], 8, 30) }));

  const picked = await chatJSON<{ themes: { index: number; pitch: string; picks: { id: string; why: string }[] }[] }>([
    {
      role: "system",
      content: `You are Aimo AI writing short, honest, suggest-only sales nudges for a hotel kitchen buyer. For each theme rank up to 5 food products FROM THAT THEME'S CANDIDATES ONLY that best fit it (skip non-food and odd matches).
Write a pitch of max 30 words starting with "Aimo AI noticed" — mention the seasonal reason and the product type, no invented prices, discounts or stock claims.
Return JSON: {"themes": [{"index": <theme index>, "pitch": "...", "picks": [{"id": "<id>", "why": "<max 10 words>"}]}]}`
    },
    {
      role: "user",
      content: themes
        .map((t, i) => `Theme ${i}: ${t.title} — ${t.why}\nCandidates (id | name):\n${candidateList(t.candidates)}`)
        .join("\n\n")
    }
  ]);

  const chosen = (picked.themes ?? [])
    .map((pt) => {
      const theme = themes[Number(pt.index)];
      if (!theme) return null;
      const valid = new Set(theme.candidates.map((c) => c.id));
      return { theme, pitch: pt.pitch, picks: (pt.picks ?? []).filter((p) => valid.has(String(p.id))).slice(0, 5) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.picks.length > 0);

  const live = await resolveLive(chosen.flatMap((c) => c.picks.map((p) => String(p.id))));
  const result: SeasonalSuggestions = {
    date: day,
    season: plan.season ?? "",
    themes: chosen
      .map((c) => ({
        title: c.theme.title,
        pitch: c.pitch,
        products: preferAvailable(c.picks.map((p) => String(p.id)), live, 3).map((id) => {
          const r = live.get(id)!;
          return { ...r, ai_reason: policyCaveat(r) ?? c.picks.find((p) => String(p.id) === id)?.why };
        })
      }))
      .filter((t) => t.products.length > 0)
  };

  if (result.themes.length > 0) seasonalCache.set(day, result);
  return result;
}

// ---------------------------------------------------------------------------------------------
// 2. Recipe → order lines ("need → recipe → order")
// ---------------------------------------------------------------------------------------------

export interface RecipeLine {
  ingredient: string;
  role: "core" | "supporting";
  quantity_needed: string;
  order_units: number;
  /** "catalog_weight" = computed from the product's real net weight per sales unit; "ai_estimate" = LLM read the pack size off the name. */
  units_basis: "catalog_weight" | "ai_estimate";
  note: string;
  product: ProductLookupResult | null;
  alternatives_considered: number;
  /** "good" = the model is confident this SKU is the ingredient, not just a keyword hit (e.g. rejects
   *  BUTTER SPREADER for "butter"). "none" means no candidate was confident enough — product is null
   *  and the buyer must pick or search manually, instead of a weak guess looking like a recommendation. */
  match_confidence: "good" | "none";
  /** The chosen product is out of stock and no in-stock alternative was available — a planning
   *  exception the buyer must resolve (e.g. find a substitute) before this line can be ordered. */
  needs_substitute: boolean;
}

export interface RecipePlan {
  dish: string;
  covers: number;
  summary: string;
  lines: RecipeLine[];
}

/** "4.5 kg" / "800 g" / "3 l" / "2,5 dl" → kg (litres treated as ≈ kg). null for pcs, bunches, etc. */
function parseKg(q: string): number | null {
  const m = /([\d.,]+)\s*(kg|g|l|dl|cl|ml)\b/i.exec(q);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const factor = { kg: 1, l: 1, g: 0.001, ml: 0.001, cl: 0.01, dl: 0.1 }[m[2].toLowerCase() as "kg"];
  return n * factor;
}

function fmtKg(kg: number): string {
  return kg >= 1 ? `${+kg.toFixed(2)} kg` : `${Math.round(kg * 1000)} g`;
}

export async function planRecipe(dish: string, covers: number): Promise<RecipePlan> {
  const recipe = await chatJSON<{
    summary: string;
    ingredients: { ingredient: string; role: "core" | "supporting"; quantity_needed: string; queries: string[] }[];
  }>([
    {
      role: "system",
      content: `You are a head chef's purchasing assistant at a hotel restaurant in Finland. Turn the dish into a wholesale ingredient list for the given number of covers (portions).
List at most 8 ingredients that must be BOUGHT (skip water, salt, pepper and other pantry staples). Mark the 1-3 ingredients that define the dish as "core".
quantity_needed is the total for all covers with a unit, e.g. "4.5 kg", "3 l", "60 pcs".
${KEYWORD_RULES}
Return JSON: {"summary": "<one sentence describing the dish as you interpreted it>", "ingredients": [{"ingredient": "...", "role": "core|supporting", "quantity_needed": "...", "queries": ["...", "..."]}]} with 2-4 queries per ingredient.`
    },
    { role: "user", content: `Dish: ${dish}\nCovers: ${covers}` }
  ]);

  const ingredients = (recipe.ingredients ?? []).slice(0, 8).map((ing) => ({
    ...ing,
    candidates: pool([ing.ingredient, ...(ing.queries ?? [])], 6, 14)
  }));

  const chosen = await chatJSON<{
    lines: { index: number; ranked: { id: string; order_units: number; note: string; confidence: "good" | "weak" }[] }[];
  }>([
    {
      role: "system",
      content: `For each ingredient rank the best 3 wholesale products FROM THAT INGREDIENT'S CANDIDATES ONLY (prefer plain, unprocessed, foodservice pack sizes; best first). Leave ranked empty if nothing fits.
Match the ingredient as a chef means it: "cream" is dairy cream (not coconut or ice cream), "butter" is a block (not 10 g portions) — unless the dish explicitly asks otherwise.
A candidate only matched by a shared keyword but is really a different kind of product (e.g. "BUTTER SPREADER" or "BUTTER KNIFE" for ingredient "butter", a seasoning mix for a raw ingredient) is NOT the ingredient — mark it confidence "weak" rather than dropping it silently, so the buyer sees it was considered and rejected. Only mark "good" when you're confident the product IS the ingredient.
For each, compute order_units = how many sales units of that product cover quantity_needed, reading the pack size from the product name (round up; if the pack size is unclear, give your best estimate and say so in note).
note: max 15 words — pack size reasoning or why nothing fit.
Return JSON: {"lines": [{"index": <ingredient index>, "ranked": [{"id": "<id>", "order_units": <integer>, "note": "...", "confidence": "good|weak"}]}]}`
    },
    {
      role: "user",
      content: ingredients
        .map(
          (ing, i) =>
            `Ingredient ${i}: ${ing.ingredient} — need ${ing.quantity_needed}\nCandidates (id | name):\n${candidateList(ing.candidates) || "(none found)"}`
        )
        .join("\n\n")
    }
  ]);

  const byIndex = new Map((chosen.lines ?? []).map((l) => [Number(l.index), l]));
  const rankedPerIngredient = ingredients.map((ing, i) =>
    (byIndex.get(i)?.ranked ?? []).filter((r) => ing.candidates.some((c) => c.id === String(r.id))).slice(0, 3)
  );
  const live = await resolveLive(rankedPerIngredient.flatMap((rs) => rs.map((r) => String(r.id))));

  return {
    dish,
    covers,
    summary: recipe.summary ?? "",
    lines: ingredients.map((ing, i) => {
      const ranked = rankedPerIngredient[i];
      // Only a "good"-confidence pick counts as the ingredient; a "weak" match (keyword hit but
      // wrong product) must never present as a confident recommendation.
      const goodRanked = ranked.filter((r) => r.confidence !== "weak");
      const bestId = preferAvailable(goodRanked.map((r) => String(r.id)), live, 1)[0] ?? goodRanked[0]?.id;
      const best = goodRanked.find((r) => String(r.id) === bestId);
      const product = bestId ? (live.get(String(bestId)) ?? null) : null;
      const needKg = parseKg(ing.quantity_needed);
      const unitKg = product?.net_weight_kg_per_sales_unit ?? null;
      const computed = needKg !== null && unitKg ? Math.ceil(needKg / unitKg - 1e-9) : null;
      const needsSubstitute = product?.envelope.claim.availability.status === "out_of_stock";
      return {
        ingredient: ing.ingredient,
        role: ing.role === "core" ? "core" : "supporting",
        quantity_needed: ing.quantity_needed,
        order_units: Math.max(1, computed ?? Math.ceil(Number(best?.order_units) || 1)),
        units_basis: computed !== null ? "catalog_weight" : "ai_estimate",
        note:
          computed !== null && unitKg
            ? `Catalog weight ${fmtKg(unitKg)} per unit → ${computed} unit${computed === 1 ? "" : "s"} cover${computed === 1 ? "s" : ""} ${ing.quantity_needed}.`
            : best
              ? (best.note ?? "")
              : ranked.length
                ? `No sufficiently confident catalogue match for "${ing.ingredient}" — only keyword-similar products were found.`
                : "No matching product in the catalog.",
        product,
        alternatives_considered: ing.candidates.length,
        match_confidence: product ? "good" : "none",
        needs_substitute: needsSubstitute
      };
    })
  };
}
