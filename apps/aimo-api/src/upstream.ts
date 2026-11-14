// Client for the REAL Valio Aimo Junction26 mock backend. Server-side only —
// AIMO_UPSTREAM_API_KEY never reaches the buyer-agent side of the demo.

const BASE_URL = process.env.AIMO_UPSTREAM_BASE_URL ?? "https://junction26.valioaimo.fi";
const API_KEY = process.env.AIMO_UPSTREAM_API_KEY ?? "";

export interface UpstreamPrice {
  productId: string;
  quantity: number;
  catalogPrice: { value: number; valueWithTax: number; currency: string } | null;
  comparisonPrice: { value: number; valueWithTax: number } | null;
  comparisonUnit: string | null;
  netPriceFound: boolean;
  error: boolean;
}

export interface UpstreamAvailability {
  productId: string;
  closingTime: string | null;
  salesBlock: boolean;
  logisticModel: "Stock" | "Terminal" | null;
  scheduleLines: {
    salesBlock: boolean;
    availableAmount: number;
    availableDate: string | null;
    salesUnit: string;
  }[];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Upstream ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Query price for a bounded set of product codes. Callers must narrow the
 * candidate set first (catalog filter, substitution list) — never bulk-query
 * the whole catalog; the upstream API documents undisclosed rate limits and
 * explicitly asks for this.
 */
export async function getUpstreamPrices(productIds: string[], requestedDate: string, customer: string) {
  if (productIds.length === 0) return [];
  const res = await post<{ products: UpstreamPrice[] }>("/api/price", {
    customer,
    requestedDate,
    products: productIds
  });
  return res.products;
}

export async function getUpstreamAvailability(productIds: string[], requestedDate: string, customer: string) {
  if (productIds.length === 0) return [];
  const res = await post<{ timeNow: string; products: UpstreamAvailability[] }>("/api/availability", {
    customer,
    requestedDate,
    products: productIds
  });
  return res.products;
}
