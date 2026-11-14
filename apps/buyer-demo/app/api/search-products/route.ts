import { NextRequest, NextResponse } from "next/server";
import { buildClient } from "../../../lib/scenarios";
import { llmConfigured } from "../../../lib/llm";
import { aiSearch } from "../../../lib/llmCatalog";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { query, category, max_price, ai } = await req.json();

  // AI search interprets the need, then fetches live price/stock for its picks through aimo-api.
  // Any LLM failure falls back to the literal keyword search below, so search never breaks.
  let aiError: string | undefined;
  if (ai && query && llmConfigured()) {
    try {
      return NextResponse.json(await aiSearch(String(query)));
    } catch (err) {
      aiError = (err as Error).message;
    }
  }

  const client = buildClient();
  try {
    const data = await client.lookupProducts({
      query: query || undefined,
      category: category || undefined,
      max_price: max_price ? Number(max_price) : undefined
    });
    return NextResponse.json({ mode: "keyword", ...data, ...(aiError ? { ai_error: aiError } : {}) });
  } catch (err) {
    return NextResponse.json({ error: "search_failed", message: (err as Error).message }, { status: 500 });
  }
}
