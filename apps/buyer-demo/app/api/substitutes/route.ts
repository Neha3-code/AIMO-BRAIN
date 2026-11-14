import { NextRequest, NextResponse } from "next/server";
import { scenario5RecipeChemistry, buildClient } from "../../../lib/scenarios";

/** Try-it-yourself: run any catalog product's registered substitutes through the same
 *  recipe-chemistry / carbon / delivery-reliability evaluation as scenario 5. */
export async function POST(req: NextRequest) {
  const { productId } = await req.json();
  if (!productId || typeof productId !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await scenario5RecipeChemistry(buildClient(), productId);
    return NextResponse.json({ ...result, id: "custom-substitutes", name: "Try it yourself", tagline: "Recipe-safe substitutes" });
  } catch (err) {
    return NextResponse.json({ error: "substitutes_failed", message: (err as Error).message }, { status: 500 });
  }
}
