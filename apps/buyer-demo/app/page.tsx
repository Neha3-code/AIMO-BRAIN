"use client";

import { useState } from "react";
import type { ScenarioResult, ScenarioStep, StepStatus } from "../lib/scenarios";
import type { AuditEvent, Order, Quote, QuoteLine } from "@aimo/shared";

const SCENARIO_CARDS = [
  {
    id: "1",
    index: "01",
    title: "Autonomous purchasing",
    tagline: "Happy path",
    description: "The buyer agent finds a suitable product, obtains a quote and places an order within its permissions."
  },
  {
    id: "2",
    index: "02",
    title: "Two-sided approval",
    tagline: "Human approval",
    description: "The buyer policy permits the order, but Aimo requires its own human approval before release."
  },
  {
    id: "3",
    index: "03",
    title: "Stock-out and substitution",
    tagline: "Alternative selection",
    description: "The requested product is unavailable. Aimo returns ranked alternatives and the buyer agent checks its own constraints."
  }
];

const STAGE_LABEL: Record<string, string> = {
  request: "Buyer request",
  quote: "Product search and quote",
  buyer_policy: "Buyer policy check",
  aimo_policy: "Aimo policy check",
  approval: "Approval",
  audit: "Audit",
  result: "Order release"
};

function Pill({ status, children }: { status: StepStatus; children: React.ReactNode }) {
  return <span className={`pill pill-${status}`}>{children}</span>;
}

function Timeline({ steps }: { steps: ScenarioStep[] }) {
  return (
    <div className="timeline">
      {steps.map((s, i) => (
        <div className="timeline-item" key={i}>
          <div className={`timeline-dot pill-${s.status}`} />
          <div>
            <div className="timeline-stage">{STAGE_LABEL[s.stage] ?? s.stage}</div>
            <div className="timeline-title">{s.title}</div>
            <div className="timeline-detail">{s.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function QuoteCard({ quote }: { quote: Quote }) {
  return (
    <div className="detail-card">
      <h4>Quote {quote.quote_id}</h4>
      {quote.lines.map((line: QuoteLine, i: number) => (
        <div key={i}>
          <div className="kv-row">
            <span className="k">Product</span>
            <span className="v">{line.requested_product_id}</span>
          </div>
          <div className="kv-row">
            <span className="k">Quantity</span>
            <span className="v">{line.requested_qty}</span>
          </div>
          <div className="kv-row">
            <span className="k">Status</span>
            <span className="v">{line.status}</span>
          </div>
          {line.status === "available" && (
            <>
              <div className="kv-row">
                <span className="k">Unit price</span>
                <span className="v">{line.unit_price_eur !== null ? `€${line.unit_price_eur.toFixed(2)}` : "—"}</span>
              </div>
              <div className="kv-row">
                <span className="k">Line total</span>
                <span className="v">{line.line_total_eur !== null ? `€${line.line_total_eur.toFixed(2)}` : "—"}</span>
              </div>
            </>
          )}
          {line.alternatives.length > 0 && (
            <div className="alt-list">
              {line.alternatives.map((alt) => (
                <div className="alt-row" key={alt.product_id}>
                  <span>
                    #{alt.rank} {alt.name} ({alt.product_id})
                  </span>
                  <span>{alt.price_eur !== null ? `€${alt.price_eur.toFixed(2)}` : "—"}</span>
                </div>
              ))}
            </div>
          )}
          <details className="raw">
            <summary>Trust envelope (source, timestamp, validity, verification)</summary>
            <pre>{JSON.stringify(line.envelope, null, 2)}</pre>
          </details>
        </div>
      ))}
      <div className="kv-row" style={{ marginTop: 8, fontWeight: 700 }}>
        <span className="k">Quote total</span>
        <span className="v">€{quote.total_eur.toFixed(2)}</span>
      </div>
      <div className="kv-row">
        <span className="k">Expires</span>
        <span className="v">{new Date(quote.expires_at).toLocaleString()}</span>
      </div>
    </div>
  );
}

function ApprovalCard({ order }: { order: Order }) {
  return (
    <div className="detail-card">
      <h4>Order {order.order_id}</h4>
      <div className="kv-row">
        <span className="k">Status</span>
        <span className="v">{order.status}</span>
      </div>
      <div className="kv-row">
        <span className="k">Approval owner</span>
        <span className="v">{order.approval.owner ?? "—"}</span>
      </div>
      {order.approval.reason && (
        <div className="kv-row">
          <span className="k">Reason</span>
          <span className="v">{order.approval.reason}</span>
        </div>
      )}
      <div className="kv-row">
        <span className="k">Requested amount</span>
        <span className="v">{order.approval.requested_amount_eur !== null ? `€${order.approval.requested_amount_eur.toFixed(2)}` : "—"}</span>
      </div>
      <div className="kv-row">
        <span className="k">Approved amount</span>
        <span className="v">{order.approval.approved_amount_eur !== null ? `€${order.approval.approved_amount_eur.toFixed(2)}` : "—"}</span>
      </div>
    </div>
  );
}

function AuditList({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="detail-card">
      <h4>Audit events</h4>
      <div className="audit-list">
        {events.map((e, i) => (
          <div className="audit-item" key={i}>
            <div className="audit-top">
              <span className="audit-actor">{e.actor}</span>
              <span className="audit-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
            </div>
            <div>{e.action.replace(/_/g, " ")}</div>
            {e.reasons.length > 0 && <div className="audit-reasons">{e.reasons.join(" ")}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TransactionWorkspace({ result }: { result: ScenarioResult }) {
  return (
    <div className="workspace">
      <div className="workspace-header">
        <div>
          <h2>{result.name}</h2>
          {result.transactionId && <div className="txn-id">Transaction {result.transactionId}</div>}
        </div>
        <Pill status={result.ok ? "complete" : "blocked"}>{result.ok ? "Resolved" : "Blocked"}</Pill>
      </div>

      <Timeline steps={result.steps} />

      {(result.buyerPolicy || result.aimoPolicy) && (
        <div className="policy-grid">
          <div className="policy-card">
            <div className="policy-owner">Buyer policy — buyer-side decision</div>
            {result.buyerPolicy ? <Pill status={result.buyerPolicy.status}>{result.buyerPolicy.status.replace(/_/g, " ")}</Pill> : <Pill status="info">not evaluated</Pill>}
            <div className="policy-reason">{result.buyerPolicy?.reason ?? "No buyer-side check ran for this path."}</div>
          </div>
          <div className="policy-card">
            <div className="policy-owner">Aimo policy — supplier-side decision</div>
            {result.aimoPolicy ? <Pill status={result.aimoPolicy.status}>{result.aimoPolicy.status.replace(/_/g, " ")}</Pill> : <Pill status="info">no opinion</Pill>}
            <div className="policy-reason">{result.aimoPolicy?.reason ?? "Aimo's guardrail has no opinion on buyer-side allergen/budget rules."}</div>
          </div>
        </div>
      )}

      {result.quote && <QuoteCard quote={result.quote} />}
      {result.order && <ApprovalCard order={result.order} />}
      <AuditList events={result.audit} />
    </div>
  );
}

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
      <div className="eyebrow">
        <span className="brand">AIMO BRAIN — TRUSTED TRADE AGENTS</span>
        <span className="badge-sandbox">CHALLENGE SANDBOX</span>
      </div>
      <h1>Procurement control room</h1>
      <p className="lede">
        Watch a buyer agent source, evaluate, approve and order products through the Aimo trusted interface — two independent policy
        layers, explicit human approval, and an auditable result for every transaction.
      </p>
      <div className="problem">
        <strong>The problem:</strong> how can an autonomous buyer agent purchase from a supplier safely, without either side controlling
        the other's policies? Price and stock below are live from Valio Aimo's real Junction26 challenge backend; every claim carries a{" "}
        <code>mock_verified</code> trust envelope, never presented as a production feed.
      </div>

      <div className="flow">
        <span className="flow-step">Buyer agent</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Aimo API</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Supplier policy</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Order</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Audit trail</span>
      </div>

      <div className="role-grid">
        <div className="role-card">
          <div className="role-title">Buyer agent</div>
          <div className="role-desc">Purchasing on behalf of the buyer, applying its own allergen and budget policy after every response.</div>
        </div>
        <div className="role-card">
          <div className="role-title">Aimo interface</div>
          <div className="role-desc">Supplier rules and controls — credit limits and auto-approval ceilings, independent of the buyer's policy.</div>
        </div>
        <div className="role-card">
          <div className="role-title">Audit trail</div>
          <div className="role-desc">Evidence of every action: who decided what, why, and under which policy version.</div>
        </div>
      </div>

      <div className="section-title">Choose a scenario</div>
      <div className="scenario-grid">
        {SCENARIO_CARDS.map((s) => (
          <div className="scenario-card" key={s.id}>
            <span className="scenario-index">{s.index}</span>
            <h3>{s.title}</h3>
            <span className="scenario-tagline">{s.tagline}</span>
            <p>{s.description}</p>
            <button className="run-btn" onClick={() => run(s.id)} disabled={loading[s.id]}>
              {loading[s.id] ? "Running…" : "Explore scenario"}
            </button>
          </div>
        ))}
      </div>

      {SCENARIO_CARDS.map((s) => {
        const result = results[s.id];
        if (!result) return null;
        if ("error" in result) {
          return (
            <div className="workspace" key={s.id}>
              <Pill status="blocked">Error</Pill>
              <div className="timeline-detail" style={{ marginTop: 8 }}>
                {(result as any).message ?? (result as any).error}
              </div>
            </div>
          );
        }
        return <TransactionWorkspace result={result} key={s.id} />;
      })}

      <footer className="note">
        All price, stock and allergen data is from Valio Aimo's Junction26 challenge sandbox — not a production feed. See README.md for
        what's real, what's inferred, and what's invented for this demo.
      </footer>
    </div>
  );
}
