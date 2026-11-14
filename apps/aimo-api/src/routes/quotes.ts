import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Quote, QuoteAlternative, QuoteLine } from "@aimo/shared";
import { getCatalogProducts } from "../catalog.js";
import { getUpstreamPrices, getUpstreamAvailability, type UpstreamAvailability, type UpstreamPrice } from "../upstream.js";
import { buildPriceAvailabilityEnvelope } from "../trustEnvelope.js";
import { query } from "../db.js";
import { newId } from "../ids.js";
import { requireBuyerAuth, type AuthedRequest } from "../auth.js";
import { getBuyer } from "../buyers.js";

const QUOTE_TTL_MS = 10 * 60 * 1000;

const QuoteRequestSchema = z.object({
  buyer_id: z.string(),
  lines: z.array(z.object({ product_id: z.string(), qty: z.number().positive() })).min(1),
  requested_date: z.string().optional()
});

function isAvailable(avail: UpstreamAvailability | undefined): boolean {
  if (!avail) return false;
  if (avail.salesBlock) return false;
  const line = avail.scheduleLines?.[0];
  if (!line) return false;
  if (avail.logisticModel === "Terminal") return true; // supplier-fulfilled, treated as available
  return line.availableAmount > 0;
}

function unitPrice(price: UpstreamPrice | undefined): number | null {
  return price?.catalogPrice?.valueWithTax ?? null;
}

export function registerQuoteRoutes(app: FastifyInstance) {
  app.post("/v1/quote", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const parsed = QuoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const { lines, requested_date } = parsed.data;
    const buyerId = request.buyerId!; // authenticated buyer, not the body's buyer_id
    const buyer = await getBuyer(buyerId);
    if (!buyer) return reply.code(404).send({ error: "unknown_buyer" });

    const requestedDate = requested_date ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const requestedIds = lines.map((l) => l.product_id);
    const requestedCatalog = await getCatalogProducts(requestedIds);
    const catalogById = new Map(requestedCatalog.map((c) => [c.id, c]));

    const [prices, availabilities] = await Promise.all([
      getUpstreamPrices(requestedIds, requestedDate, buyerId),
      getUpstreamAvailability(requestedIds, requestedDate, buyerId)
    ]);
    const priceById = new Map(prices.map((p) => [p.productId, p]));
    const availById = new Map(availabilities.map((a) => [a.productId, a]));

    const quoteLines: QuoteLine[] = [];
    for (const line of lines) {
      const avail = availById.get(line.product_id);
      const catalogProduct = catalogById.get(line.product_id);

      if (isAvailable(avail)) {
        const price = unitPrice(priceById.get(line.product_id));
        quoteLines.push({
          requested_product_id: line.product_id,
          requested_qty: line.qty,
          status: "available",
          unit_price_eur: price,
          line_total_eur: price !== null ? Math.round(price * line.qty * 100) / 100 : null,
          alternatives: [],
          envelope: buildPriceAvailabilityEnvelope(line.product_id, priceById.get(line.product_id), avail)
        });
        continue;
      }

      // Unavailable: rank the product's real substitutions by Aimo's own
      // commercial attributes only (price, stock, delivery). Full list,
      // allergens disclosed on every option — no buyer-policy filtering
      // happens here (that's the §0 fix: filtering is strictly buyer-side).
      const subIds: string[] = (catalogProduct?.substitutions ?? []).slice(0, 10);
      const subCatalog = await getCatalogProducts(subIds);
      const subCatalogById = new Map(subCatalog.map((c) => [c.id, c]));

      const [subPrices, subAvail] = await Promise.all([
        getUpstreamPrices(subIds, requestedDate, buyerId),
        getUpstreamAvailability(subIds, requestedDate, buyerId)
      ]);
      const subPriceById = new Map(subPrices.map((p) => [p.productId, p]));
      const subAvailById = new Map(subAvail.map((a) => [a.productId, a]));

      const alternatives: QuoteAlternative[] = subIds
        .map((id) => {
          const c = subCatalogById.get(id);
          const a = subAvailById.get(id);
          const p = subPriceById.get(id);
          const schedule = a?.scheduleLines?.[0];
          return {
            product_id: id,
            name: c?.name_en ?? id,
            price_eur: unitPrice(p),
            availability: {
              status: isAvailable(a) ? ("in_stock" as const) : ("out_of_stock" as const),
              quantity: schedule?.availableAmount ?? null
            },
            delivery_lead_time_days: schedule?.availableDate
              ? Math.max(0, Math.round((new Date(schedule.availableDate).getTime() - Date.now()) / 86400000))
              : null,
            allergens: c?.allergens ?? [],
            envelope: buildPriceAvailabilityEnvelope(id, p, a),
            rank: 0
          };
        })
        .sort((a, b) => (a.price_eur ?? Infinity) - (b.price_eur ?? Infinity))
        .map((alt, idx) => ({ ...alt, rank: idx + 1 }));

      quoteLines.push({
        requested_product_id: line.product_id,
        requested_qty: line.qty,
        status: "unavailable",
        unit_price_eur: null,
        line_total_eur: null,
        alternatives,
        envelope: buildPriceAvailabilityEnvelope(line.product_id, priceById.get(line.product_id), avail)
      });
    }

    const totalEur = Math.round(quoteLines.reduce((sum, l) => sum + (l.line_total_eur ?? 0), 0) * 100) / 100;
    const quoteId = newId("q");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + QUOTE_TTL_MS);

    await query(
      `INSERT INTO quotes (id, buyer_id, lines, issued_at, expires_at, status, total_eur) VALUES ($1,$2,$3,$4,$5,'active',$6)`,
      [quoteId, buyerId, JSON.stringify(quoteLines), issuedAt.toISOString(), expiresAt.toISOString(), totalEur]
    );

    const quote: Quote = {
      quote_id: quoteId,
      buyer_id: buyerId,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active",
      lines: quoteLines,
      total_eur: totalEur
    };
    return reply.send(quote);
  });

  app.get("/v1/quote/:id", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const { id } = request.params as { id: string };
    const rows = await query<any>("SELECT * FROM quotes WHERE id = $1 AND buyer_id = $2", [id, request.buyerId]);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });

    const status = row.status === "consumed" ? "consumed" : new Date(row.expires_at) < new Date() ? "expired" : "active";
    const quote: Quote = {
      quote_id: row.id,
      buyer_id: row.buyer_id,
      issued_at: new Date(row.issued_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      status,
      lines: row.lines,
      total_eur: Number(row.total_eur)
    };
    return reply.send(quote);
  });
}
