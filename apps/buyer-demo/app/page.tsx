"use client";

import { useState } from "react";
import type { AlternativeReview, Outcome, ScenarioResult, ScenarioStep, StepStatus } from "../lib/scenarios";
import type { AuditEvent } from "@aimo/shared";

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
  },
  {
    id: "4",
    index: "04",
    title: "Partial availability",
    tagline: "Mixed basket",
    description: "One basket, two products — one ready to order, one out of stock. Each line is resolved on its own, not as one pass/fail outcome."
  }
];

const STAGE_LABEL: Record<string, string> = {
  request: "Buyer request",
  quote: "Product search and quote",
  buyer_policy: "Buyer policy",
  aimo_policy: "Aimo policy",
  approval: "Approval",
  audit: "Audit",
  result: "Outcome"
};

const OUTCOME_META: Record<Outcome, { label: string; tone: "good" | "warn" | "neutral" }> = {
  confirmed_auto: { label: "Order confirmed", tone: "good" },
  confirmed_after_approval: { label: "Order confirmed", tone: "good" },
  held: { label: "Held for approval", tone: "warn" },
  no_viable_alternative: { label: "No suitable alternative", tone: "neutral" },
  blocked: { label: "Order not placed", tone: "warn" },
  partial: { label: "Partially available", tone: "warn" }
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC"
    }) + " UTC"
  );
}

function quantityUnitFor(productId: string): string {
  // Scoped, honest display label — not a general unit-code translation system.
  // This specific product is sold in 1 L sales units; we know that from its own
  // product name, not from a generic code table (raw sales-unit codes like
  // "ST"/"KI" aren't translated anywhere in the challenge dataset).
  return productId === "464073" ? "L" : "units";
}

function Pill({ status, children }: { status: StepStatus; children: React.ReactNode }) {
  return <span className={`pill pill-${status}`}>{children}</span>;
}

function Hero({ result }: { result: ScenarioResult }) {
  const meta = OUTCOME_META[result.outcome];
  return (
    <div className={`hero hero-${meta.tone}`}>
      <div className="hero-top">
        <span className={`hero-label hero-label-${meta.tone}`}>{meta.label}</span>
        <span className="scenario-index">{result.name}</span>
      </div>
      <div className="hero-headline">{result.headline}</div>
      <div className="hero-sub">{result.subheadline}</div>
      <div className="hero-ref">
        {result.transactionIdKind === "order" ? "Order reference" : "Quote reference"}: <code>{result.transactionId}</code>
      </div>
    </div>
  );
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

function PolicyPanels({ result }: { result: ScenarioResult }) {
  if (!result.buyerPolicy && !result.aimoPolicy) return null;
  return (
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
  );
}

function QuoteDetail({ result }: { result: ScenarioResult }) {
  if (!result.quote) return null;
  // Scenarios 3 and 4 render their own dedicated views instead — their quote
  // carries several unrelated probe lines, not one meaningful line to show here.
  if (result.id === "3" || result.id === "4") return null;
  const line = result.quote.lines[0];
  const unit = quantityUnitFor(line.requested_product_id);
  return (
    <div className="detail-card">
      <h4>Quote detail</h4>
      <div className="kv-row">
        <span className="k">Product</span>
        <span className="v">{line.requested_product_name}</span>
      </div>
      <div className="kv-row">
        <span className="k">Quantity</span>
        <span className="v">
          {line.requested_qty.toLocaleString()} {unit}
        </span>
      </div>
      {line.unit_price_eur !== null && (
        <div className="kv-row">
          <span className="k">Unit price</span>
          <span className="v">
            €{line.unit_price_eur.toFixed(2)} / {unit}
          </span>
        </div>
      )}
      {line.line_total_eur !== null && (
        <div className="kv-row">
          <span className="k">Line total</span>
          <span className="v">€{line.line_total_eur.toFixed(2)}</span>
        </div>
      )}
      <div className="kv-row">
        <span className="k">Quote expires</span>
        <span className="v">{formatDateTime(result.quote.expires_at)}</span>
      </div>
      <details className="raw">
        <summary>Trust envelope (source, timestamp, validity, verification)</summary>
        <p className="mock-note">
          <code>mock_verified</code>: this claim is live from Valio Aimo's real challenge sandbox backend, but carries no cryptographic
          signature — an honest label, not a production verification standard.
        </p>
        <pre>{JSON.stringify(line.envelope, null, 2)}</pre>
      </details>
    </div>
  );
}

function AlternativesTable({ result }: { result: ScenarioResult }) {
  if (!result.alternatives || !result.requestedProduct) return null;
  return (
    <div className="detail-card">
      <h4>Requested vs. disclosed alternatives</h4>
      <div className="kv-row">
        <span className="k">Requested, unavailable</span>
        <span className="v">
          {result.requestedProduct.name} ({result.requestedProduct.id})
        </span>
      </div>
      <table className="alt-table">
        <thead>
          <tr>
            <th>Alternative</th>
            <th>Price</th>
            <th>Availability</th>
            <th>Allergen codes</th>
            <th>Buyer decision</th>
          </tr>
        </thead>
        <tbody>
          {result.alternatives.map((alt: AlternativeReview) => (
            <tr key={alt.product_id} className={alt.buyerDecision === "rejected" ? "alt-row-rejected" : "alt-row-eligible"}>
              <td>
                #{alt.rank} {alt.name}
                <div className="alt-sku">{alt.product_id}</div>
              </td>
              <td>{alt.price_eur !== null ? `€${alt.price_eur.toFixed(2)}` : "—"}</td>
              <td>{alt.availability_status.replace(/_/g, " ")}</td>
              <td>{alt.allergens.length > 0 ? alt.allergens.map((a) => a.code).join(", ") : "none disclosed"}</td>
              <td>
                <Pill status={alt.buyerDecision === "rejected" ? "rejected" : "passed"}>{alt.buyerDecision}</Pill>
                <div className="alt-reason">{alt.buyerReason}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PartialLinesCard({ result }: { result: ScenarioResult }) {
  if (!result.relevantLines) return null;
  return (
    <div className="detail-card">
      <h4>Line-by-line outcome</h4>
      <table className="alt-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Quantity</th>
            <th>Status</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {result.relevantLines.map((line) => {
            const unit = quantityUnitFor(line.requested_product_id);
            return (
              <tr key={line.requested_product_id} className={line.status === "unavailable" ? "alt-row-rejected" : "alt-row-eligible"}>
                <td>
                  {line.requested_product_name}
                  <div className="alt-sku">{line.requested_product_id}</div>
                </td>
                <td>
                  {line.requested_qty.toLocaleString()} {unit}
                </td>
                <td>
                  <Pill status={line.status === "available" ? "passed" : "blocked"}>{line.status}</Pill>
                </td>
                <td>{line.line_total_eur !== null ? `€${line.line_total_eur.toFixed(2)}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {result.relevantLines.some((l) => l.status === "unavailable") && (
        <p className="mock-note" style={{ marginTop: 10 }}>
          The unavailable line would go through the same substitution-ranking flow as scenario 3 (full disclosure, buyer policy applied
          per alternative) rather than blocking the whole basket.
        </p>
      )}
    </div>
  );
}

function ApprovalDetail({ result }: { result: ScenarioResult }) {
  const order = result.order;
  if (!order || !order.approval.required) return null;
  return (
    <div className="detail-card">
      <h4>Approval</h4>
      <div className="kv-row">
        <span className="k">Owner</span>
        <span className="v">{order.approval.owner}</span>
      </div>
      <div className="kv-row">
        <span className="k">Reason</span>
        <span className="v">{order.approval.reason}</span>
      </div>
      <div className="kv-row">
        <span className="k">Requested amount</span>
        <span className="v">€{order.approval.requested_amount_eur?.toFixed(2)}</span>
      </div>
      <div className="kv-row">
        <span className="k">Approved amount</span>
        <span className="v">{order.approval.approved_amount_eur !== null ? `€${order.approval.approved_amount_eur.toFixed(2)}` : "pending"}</span>
      </div>
    </div>
  );
}

function GovernanceCheckCard({ result }: { result: ScenarioResult }) {
  const check = result.governanceCheck;
  if (!check) return null;
  return (
    <div className="detail-card">
      <h4>Approval ownership enforced</h4>
      <div className="gov-row gov-bad">
        <span>Buyer approval rejected — cannot clear an Aimo-owned hold</span>
        <Pill status="blocked">{check.httpStatus ?? "error"}</Pill>
      </div>
      <div className="gov-row gov-good">
        <span>Aimo approval accepted — authorized Aimo human cleared the hold</span>
        <Pill status="complete">approved</Pill>
      </div>
      <details className="raw">
        <summary>Technical detail: raw API response</summary>
        <pre>{check.rawMessage}</pre>
      </details>
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
              <span className="audit-time">{formatDateTime(e.timestamp)}</span>
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
      <Hero result={result} />
      <Timeline steps={result.steps} />
      <PolicyPanels result={result} />
      <QuoteDetail result={result} />
      <AlternativesTable result={result} />
      <PartialLinesCard result={result} />
      <GovernanceCheckCard result={result} />
      <ApprovalDetail result={result} />
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
        <span className="badge-sandbox">CHALLENGE SANDBOX</span>
      </div>
      <h1>AIMO BRAIN</h1>
      <div className="tagline">Trusted trade agents</div>
      <p className="lede">Autonomous procurement, with independent controls on both sides.</p>

      <div className="flow">
        <span className="flow-step">Buyer agent</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Aimo API</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Policy</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Order</span>
        <span className="flow-arrow">→</span>
        <span className="flow-step">Audit</span>
      </div>

      <p className="problem">
        <strong>The problem:</strong> how can an autonomous buyer agent purchase from a supplier safely, without either side controlling
        the other's policies? Price and stock below are live from Valio Aimo's real Junction26 challenge backend; every claim carries a{" "}
        <code>mock_verified</code> trust envelope, never presented as a production feed.
      </p>

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
