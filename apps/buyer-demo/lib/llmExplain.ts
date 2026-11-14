/**
 * Narration layer: turns an already-decided ScenarioResult into plain language. Pure translation of
 * facts the policy engines produced — the LLM sees the outcome after the fact and nothing it writes
 * is fed back into any decision.
 */
import type { ScenarioResult } from "./scenarios";
import { chatJSON } from "./llm";

const clip = (s: unknown, n = 400) => (typeof s === "string" ? s.slice(0, n) : s);

/** Compact, truncated fact sheet — keeps prompts small and drops anything the client could bloat. */
function factSheet(r: ScenarioResult) {
  return {
    scenario: clip(r.name, 120),
    outcome: r.outcome,
    headline: clip(r.headline),
    subheadline: clip(r.subheadline),
    requested_product: r.requestedProduct?.name ?? null,
    steps: (r.steps ?? []).slice(0, 30).map((s) => ({ stage: s.stage, status: s.status, title: clip(s.title, 160), detail: clip(s.detail, 400) })),
    buyer_policy: r.buyerPolicy ? { status: r.buyerPolicy.status, reason: clip(r.buyerPolicy.reason) } : null,
    supplier_policy: r.aimoPolicy ? { status: r.aimoPolicy.status, reason: clip(r.aimoPolicy.reason) } : null,
    alternatives: (r.alternatives ?? []).slice(0, 8).map((a) => ({
      name: clip(a.name, 120),
      decision: a.buyerDecision,
      reason: clip(a.buyerReason, 300),
      failed_or_warned_checks: (a.checks ?? []).filter((c) => c.status !== "pass").map((c) => `${c.check}:${c.status} ${clip(c.detail, 160)}`)
    })),
    order: r.order ? { status: r.order.status, approval: r.order.approval, lines_confirmed: r.order.lines_confirmed?.length ?? 0, lines_held: r.order.lines_held?.length ?? 0 } : null,
    governance_check: r.governanceCheck ? { rejected: r.governanceCheck.rejected, message: clip(r.governanceCheck.rawMessage, 200) } : null
  };
}

export interface Narration {
  note: string;
  narration: { agent: "Inventory agent" | "Supplier agent" | "Budget agent" | "Compliance agent"; text: string }[];
}

/** #3 + #4: one-sentence outcome note for any SKU, plus per-agent narration of this run's real steps. */
export async function narrateResult(r: ScenarioResult): Promise<Narration> {
  const out = await chatJSON<Narration>([
    {
      role: "system",
      content: `You narrate what an AI purchasing system just did for a hotel kitchen, for a non-technical viewer. Use ONLY the facts given — never invent prices, products, quantities or outcomes.
Return JSON: {"note": "<one sentence, max 25 words, summarising the outcome — e.g. how many substitutes were selected / need review / rejected and why>",
"narration": [{"agent": "Inventory agent" | "Supplier agent" | "Budget agent" | "Compliance agent", "text": "<1-2 sentences, first person, what this agent checked and found in THIS run>"}]}
Inventory agent = availability, stock, substitutes. Supplier agent = quote, supplier-side policy, approvals. Budget agent = prices, limits, totals. Compliance agent = allergens, recipe match, carbon, delivery reliability, audit.
Include only agents that had something to do in this run, in the order they acted.`
    },
    { role: "user", content: JSON.stringify(factSheet(r)) }
  ]);
  const agents = new Set(["Inventory agent", "Supplier agent", "Budget agent", "Compliance agent"]);
  return {
    note: String(out.note ?? ""),
    narration: (out.narration ?? []).filter((n) => agents.has(n.agent) && typeof n.text === "string").slice(0, 6)
  };
}

/** #5: plain-language paragraph explaining the audit trail of one decision. */
export async function explainAudit(r: ScenarioResult): Promise<{ explanation: string }> {
  const events = (r.audit ?? []).slice(0, 40).map((e) => ({
    time: e.timestamp,
    actor: e.actor,
    action: e.action,
    reasons: (e.reasons ?? []).map((x) => clip(x, 300)),
    policy_version: e.policy_version
  }));
  const out = await chatJSON<{ explanation: string }>([
    {
      role: "system",
      content: `Explain an order's audit trail to a non-technical hotel manager in ONE paragraph (max 120 words): who decided what, in what order, why, and under which policy version.
"buyer_agent" is the kitchen's purchasing software, "aimo_api" is the supplier's system, "human:*" actors are people. Use ONLY the given events and outcome — do not speculate or add advice.
Return JSON: {"explanation": "..."}`
    },
    { role: "user", content: JSON.stringify({ outcome: r.outcome, headline: clip(r.headline), order_id: r.transactionId, events }) }
  ]);
  return { explanation: String(out.explanation ?? "") };
}
