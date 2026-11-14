import type { ProductPriceClaim, TrustEnvelope } from "@aimo/shared";
import type { UpstreamAvailability, UpstreamPrice } from "./upstream.js";

const ENVELOPE_TTL_SECONDS = 600; // 10 minutes, matches the spec §3 example

let refCounter = 0;
function nextReferenceId(prefix: string): string {
  refCounter += 1;
  return `${prefix}-${Date.now()}-${refCounter}`;
}

export function buildPriceAvailabilityEnvelope(
  productId: string,
  price: UpstreamPrice | undefined,
  availability: UpstreamAvailability | undefined
): TrustEnvelope<ProductPriceClaim> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENVELOPE_TTL_SECONDS * 1000);

  const schedule = availability?.scheduleLines?.[0];
  let status: ProductPriceClaim["availability"]["status"] = "unknown";
  let quantity: number | null = null;
  if (availability) {
    if (availability.salesBlock || !schedule) {
      status = "out_of_stock";
      quantity = 0;
    } else if (availability.logisticModel === "Terminal") {
      status = "terminal_supplier";
      quantity = null; // real amount unknown for terminal products, per upstream docs
    } else if (schedule.availableAmount > 0) {
      status = "in_stock";
      quantity = schedule.availableAmount;
    } else {
      status = "out_of_stock";
      quantity = 0;
    }
  }

  const amount = price?.catalogPrice?.valueWithTax ?? null;

  return {
    claim: {
      product_id: productId,
      price: amount !== null ? { amount, currency: price?.catalogPrice?.currency ?? "EUR", unit: "sales_unit" } : null,
      availability: { status, quantity, confirmed_available_date: schedule?.availableDate ?? null }
    },
    provenance: {
      issuer: "Valio Aimo",
      source_system: "junction26_mock_backend",
      observed_at: now.toISOString()
    },
    validity: {
      expires_at: expiresAt.toISOString()
    },
    verification: {
      status: "mock_verified",
      reference_id: nextReferenceId("stock-check")
    }
  };
}
