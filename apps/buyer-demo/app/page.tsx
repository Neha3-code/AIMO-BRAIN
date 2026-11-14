"use client";

import { useState } from "react";

interface ScenarioStep {
  label: string;
  detail: string;
  data?: unknown;
}

interface ScenarioResult {
  name: string;
  steps: ScenarioStep[];
  ok: boolean;
}

const SCENARIOS = [
  { id: "1", title: "Scenario 1 — Autonomous purchasing (happy path)" },
  { id: "2", title: "Scenario 2 — Two-sided approval" },
  { id: "3", title: "Scenario 3 — Stock-out and substitution" }
];

export default function Page() {
  const [results, setResults] = useState<Record<string, ScenarioResult | { error: string; message?: string } | undefined>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  async function run(id: string) {
    setLoading((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch("/api/run-scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await res.json();
      setResults((r) => ({ ...r, [id]: data }));
    } finally {
      setLoading((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <div className="wrap">
      <h1>AIMO BRAIN — Trusted Trade Agents</h1>
      <p className="sub">
        Reference buyer-agent calling the Valio Aimo trusted interface (apps/aimo-api) over HTTP. Each run shows the trust
        envelope, the two independent guardrail layers, and the resulting audit trail.
      </p>

      {SCENARIOS.map((s) => {
        const result = results[s.id];
        const isError = result && "error" in result;
        return (
          <div className="scenario" key={s.id}>
            <div className="scenario-header">
              <h2>{s.title}</h2>
              <button onClick={() => run(s.id)} disabled={loading[s.id]}>
                {loading[s.id] ? "Running..." : "Run"}
              </button>
            </div>
            {result && !isError && "ok" in result && (
              <>
                <span className={result.ok ? "status-ok" : "status-fail"}>{result.ok ? "OK" : "FAILED"}</span>
                {result.steps.map((step, i) => (
                  <div className="step" key={i}>
                    <span className="label">{step.label}</span>
                    {step.detail}
                    {step.data !== undefined && (
                      <pre>{JSON.stringify(step.data, null, 2)}</pre>
                    )}
                  </div>
                ))}
              </>
            )}
            {isError && <div className="step status-fail">{(result as any).message ?? (result as any).error}</div>}
          </div>
        );
      })}
    </div>
  );
}
