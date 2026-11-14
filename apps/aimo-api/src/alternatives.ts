import type { QuoteAlternative } from "@aimo/shared";
import { getCatalogProducts } from "./catalog.js";
import { getUpstreamPrices, getUpstreamAvailability, type UpstreamAvailability, type UpstreamPrice } from "./upstream.js";
import { buildPriceAvailabilityEnvelope } from "./trustEnvelope.js";
import { productFacts } from "./productFacts.js";

export function isAvailable(avail: UpstreamAvailability | undefined): boolean {
  if (!avail) return false;
  if (avail.salesBlock) return false;
  const line = avail.scheduleLines?.[0];
  if (!line) return false;
  if (avail.logisticModel === "Terminal") return true; // supplier-fulfilled, treated as available
  return line.availableAmount > 0;
}

export function unitPrice(price: UpstreamPrice | undefined): number | null {
  return price?.catalogPrice?.valueWithTax ?? null;
}

export const ALTERNATIVES_RANKING =
  "Ranked by Aimo's own commercial attributes only: available now first, then historical delivery reliability (no history ranks after any known figure), then price. Allergens, carbon footprint and composition are disclosed on every option but never used to filter — what fits a kitchen is the buyer's decision.";

/**
 * Builds the ranked, fully-disclosed alternatives list for a product's real
 * registered substitutes. Aimo ranks on what it is accountable for — can it
 * deliver, how reliably has it delivered this SKU, at what price — and
 * discloses everything else (allergens, CO2-eq/kg, composition) untouched.
 * No buyer policy is consulted here (spec §0).
 */
export async function buildAlternatives(substituteIds: string[], requestedDate: string, buyerId: string): Promise<QuoteAlternative[]> {
  const subIds = substituteIds.slice(0, 10);
  if (subIds.length === 0) return [];

  const [subCatalog, subPrices, subAvail] = await Promise.all([
    getCatalogProducts(subIds),
    getUpstreamPrices(subIds, requestedDate, buyerId),
    getUpstreamAvailability(subIds, requestedDate, buyerId)
  ]);
  const catalogById = new Map(subCatalog.map((c) => [c.id, c]));
  const priceById = new Map(subPrices.map((p) => [p.productId, p]));
  const availById = new Map(subAvail.map((a) => [a.productId, a]));

  return subIds
    .map((id) => {
      const c = catalogById.get(id);
      const a = availById.get(id);
      const p = priceById.get(id);
      const envelope = buildPriceAvailabilityEnvelope(id, p, a);
      const schedule = a?.scheduleLines?.[0];
      return {
        product_id: id,
        name: c?.name_en ?? id,
        price_eur: unitPrice(p),
        // Same status vocabulary as the trust envelope (incl. terminal_supplier), so the
        // two can never disagree about one product.
        availability: envelope.claim.availability,
        delivery_lead_time_days: schedule?.availableDate
          ? Math.max(0, Math.round((new Date(schedule.availableDate).getTime() - Date.now()) / 86400000))
          : null,
        allergens: c?.allergens ?? [],
        facts: productFacts(id, c),
        envelope,
        rank: 0,
        _available: isAvailable(a)
      };
    })
    .sort((x, y) => {
      if (x._available !== y._available) return x._available ? -1 : 1;
      const rx = x.facts.delivery_reliability ?? -1;
      const ry = y.facts.delivery_reliability ?? -1;
      if (rx !== ry) return ry - rx;
      return (x.price_eur ?? Infinity) - (y.price_eur ?? Infinity);
    })
    .map(({ _available, ...alt }, idx) => ({ ...alt, rank: idx + 1 }));
}
