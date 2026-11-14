import { NextRequest, NextResponse } from "next/server";
import { llmConfigured } from "../../../lib/llm";
import { planRecipe } from "../../../lib/llmCatalog";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { dish, covers } = await req.json();
  if (!dish || typeof dish !== "string") return NextResponse.json({ error: "missing_dish" }, { status: 400 });
  if (!llmConfigured()) return NextResponse.json({ error: "llm_not_configured", message: "Set VERDA_INFERENCE_KEY to enable recipe planning." }, { status: 503 });
  const n = Math.min(500, Math.max(1, Math.round(Number(covers) || 20)));
  try {
    return NextResponse.json(await planRecipe(dish.slice(0, 300), n));
  } catch (err) {
    return NextResponse.json({ error: "recipe_failed", message: (err as Error).message }, { status: 500 });
  }
}
