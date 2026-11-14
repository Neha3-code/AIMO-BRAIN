import { NextRequest, NextResponse } from "next/server";
import { runCustomPurchase } from "../../../lib/scenarios";

export async function POST(req: NextRequest) {
  const { productId, qty } = await req.json();
  if (!productId || !qty || qty <= 0) {
    return NextResponse.json({ error: "invalid_request", message: "productId and a positive qty are required." }, { status: 422 });
  }
  try {
    const result = await runCustomPurchase(String(productId), Number(qty));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: "purchase_failed", message: (err as Error).message }, { status: 500 });
  }
}
