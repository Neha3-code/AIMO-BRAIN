import { NextRequest, NextResponse } from "next/server";
import { scenario1Autonomous, scenario2TwoSidedApproval, scenario3StockOutSubstitution, scenario4PartialAvailability } from "../../../lib/scenarios";

const SCENARIOS = {
  "1": scenario1Autonomous,
  "2": scenario2TwoSidedApproval,
  "3": scenario3StockOutSubstitution,
  "4": scenario4PartialAvailability
} as const;

export async function POST(req: NextRequest) {
  const { id } = await req.json();
  const fn = SCENARIOS[id as keyof typeof SCENARIOS];
  if (!fn) {
    return NextResponse.json({ error: "unknown_scenario" }, { status: 400 });
  }
  try {
    const result = await fn();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: "scenario_failed", message: (err as Error).message }, { status: 500 });
  }
}
