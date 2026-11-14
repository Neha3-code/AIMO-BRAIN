import { NextRequest, NextResponse } from "next/server";
import { buildClient } from "../../../lib/scenarios";

export async function POST(req: NextRequest) {
  const { query, category, max_price } = await req.json();
  const client = buildClient();
  try {
    const data = await client.lookupProducts({
      query: query || undefined,
      category: category || undefined,
      max_price: max_price ? Number(max_price) : undefined
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: "search_failed", message: (err as Error).message }, { status: 500 });
  }
}
