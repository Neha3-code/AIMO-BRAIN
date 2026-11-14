import type { FastifyInstance } from "fastify";
import type { ProductLookupResult } from "@aimo/shared";
import { findCatalogCandidates } from "../catalog.js";
import { getUpstreamPrices, getUpstreamAvailability } from "../upstream.js";
import { buildPriceAvailabilityEnvelope } from "../trustEnvelope.js";
import { requireBuyerAuth, type AuthedRequest } from "../auth.js";

export function registerProductRoutes(app: FastifyInstance) {
  app.get("/v1/products", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const q = request.query as { query?: string; category?: string; max_price?: string };
    const today = new Date().toISOString().slice(0, 10);

    // Filter the static catalog locally first — only the matched, capped
    // candidate set goes to the real upstream price/availability APIs, per
    // the upstream API's own guidance against bulk-querying all products.
    const candidates = await findCatalogCandidates({
      queryText: q.query,
      category: q.category,
      limit: 20
    });

    if (candidates.length === 0) {
      return reply.send({ results: [] as ProductLookupResult[] });
    }

    const ids = candidates.map((c) => c.id);
    const [prices, availabilities] = await Promise.all([
      getUpstreamPrices(ids, today, request.buyerId!),
      getUpstreamAvailability(ids, today, request.buyerId!)
    ]);
    const priceById = new Map(prices.map((p) => [p.productId, p]));
    const availById = new Map(availabilities.map((a) => [a.productId, a]));

    let results: ProductLookupResult[] = candidates.map((c) => {
      const envelope = buildPriceAvailabilityEnvelope(c.id, priceById.get(c.id), availById.get(c.id));
      return {
        envelope,
        name: c.name_en,
        category: c.category ?? "",
        country_of_origin: c.country_of_origin,
        allergens: c.allergens,
        sustainability_labels: [],
        carbon_footprint_kg_co2e_per_kg: c.carbon_footprint_kg_co2e_per_kg,
        delivery_reliability: c.delivery_reliability,
        delivery_lead_time_days: null
      };
    });

    if (q.max_price) {
      const maxPrice = Number(q.max_price);
      results = results.filter((r) => r.envelope.claim.price === null || r.envelope.claim.price.amount <= maxPrice);
    }

    return reply.send({ results });
  });
}
