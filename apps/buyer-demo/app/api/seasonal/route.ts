import { NextResponse } from "next/server";
import { llmConfigured, withTimeout } from "../../../lib/llm";
import { seasonalSuggestions } from "../../../lib/llmCatalog";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET() {
  if (!llmConfigured()) return NextResponse.json({ error: "llm_not_configured", message: "Set VERDA_INFERENCE_KEY to enable Aimo AI suggestions." }, { status: 503 });
  try {
    return NextResponse.json(await withTimeout(seasonalSuggestions(), 50_000, "Seasonal suggestions took too long"));
  } catch (err) {
    return NextResponse.json({ error: "seasonal_failed", message: (err as Error).message }, { status: 500 });
  }
}
