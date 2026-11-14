import { NextRequest, NextResponse } from "next/server";
import { llmConfigured, withTimeout } from "../../../lib/llm";
import { explainAudit, narrateResult } from "../../../lib/llmExplain";
import type { ScenarioResult } from "../../../lib/scenarios";

export const maxDuration = 60;

/** Read-only narration of an already-decided result. Nothing returned here feeds back into a decision. */
export async function POST(req: NextRequest) {
  const { mode, result } = (await req.json()) as { mode: "narrate" | "audit"; result: ScenarioResult };
  if (!result || typeof result !== "object") return NextResponse.json({ error: "missing_result" }, { status: 400 });
  if (!llmConfigured()) return NextResponse.json({ error: "llm_not_configured", message: "Set VERDA_INFERENCE_KEY to enable AI explanations." }, { status: 503 });
  try {
    if (mode === "audit") return NextResponse.json(await withTimeout(explainAudit(result), 50_000, "AI explanation took too long"));
    return NextResponse.json(await withTimeout(narrateResult(result), 50_000, "AI explanation took too long"));
  } catch (err) {
    return NextResponse.json({ error: "explain_failed", message: (err as Error).message }, { status: 500 });
  }
}
