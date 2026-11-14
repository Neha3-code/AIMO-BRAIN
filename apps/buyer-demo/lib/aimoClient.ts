import type { Order, ProductLookupResult, Quote } from "@aimo/shared";

export interface AimoClientConfig {
  baseUrl: string;
  apiKey: string;
}

async function request<T>(config: AimoClientConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Aimo API ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export function createAimoClient(config: AimoClientConfig) {
  return {
    lookupProducts(params: { query?: string; category?: string; max_price?: number }) {
      const qs = new URLSearchParams();
      if (params.query) qs.set("query", params.query);
      if (params.category) qs.set("category", params.category);
      if (params.max_price !== undefined) qs.set("max_price", String(params.max_price));
      return request<{ results: ProductLookupResult[] }>(config, `/v1/products?${qs.toString()}`);
    },
    requestQuote(buyerId: string, lines: { product_id: string; qty: number }[]) {
      return request<Quote>(config, "/v1/quote", {
        method: "POST",
        body: JSON.stringify({ buyer_id: buyerId, lines })
      });
    },
    getQuote(id: string) {
      return request<Quote>(config, `/v1/quote/${id}`);
    },
    placeOrder(quoteId: string) {
      return request<Order>(config, "/v1/orders", {
        method: "POST",
        body: JSON.stringify({ quote_id: quoteId })
      });
    },
    getOrder(id: string) {
      return request<Order>(config, `/v1/orders/${id}`);
    },
    approveOrder(id: string, actor: "human:buyer" | "human:aimo") {
      return request<Order>(config, `/v1/orders/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ actor })
      });
    },
    getAuditTrail(orderId: string) {
      return request<{ order_id: string; events: unknown[] }>(config, `/v1/audit/${orderId}`);
    }
  };
}

export type AimoClient = ReturnType<typeof createAimoClient>;
