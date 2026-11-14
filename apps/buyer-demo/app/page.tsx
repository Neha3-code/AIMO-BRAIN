"use client";

import { Fragment, useState } from "react";
import type { AlternativeReview, Outcome, ScenarioResult, ScenarioStep, StepStatus } from "../lib/scenarios";
import type { AuditEvent, QuoteLine, TrustEnvelope } from "@aimo/shared";

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
  order: "Order",
  audit: "Audit",
  result: "Outcome"
};

const FLOW_STEPS = [
  { title: "Buyer agent", sub: "Buyer-owned policy" },
  { title: "Aimo API", sub: "Supplier-owned policy" },
  { title: "Order decision", sub: "Auto-approve, hold or reject" },
  { title: "Audit trail", sub: "Decision evidence and provenance" }
];

const OUTCOME_META: Record<Outcome, { label: string; tone: "good" | "warn" | "neutral" }> = {
  confirmed_auto: { label: "Order confirmed", tone: "good" },
  confirmed_after_approval: { label: "Order confirmed", tone: "good" },
  held: { label: "Held for approval", tone: "warn" },
  no_viable_alternative: { label: "No suitable alternative", tone: "neutral" },
  blocked: { label: "Order not placed", tone: "warn" },
  partial: { label: "Partially available", tone: "warn" },
  substituted: { label: "Alternative identified", tone: "good" },
  both_ready: { label: "Both lines ready", tone: "good" }
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

/** The real upstream backend uses a sentinel value (observed as high as 9,999,999,999)
 *  to mean "effectively unlimited" rather than a literal unit count. Never show that
 *  number to a user as if it were real inventory. */
function formatStockQuantity(quantity: number | null): string {
  if (quantity === null) return "not disclosed";
  if (quantity >= 999999) return "quantity not capped in sandbox";
  return `${quantity.toLocaleString()} units`;
}

function Pill({ status, children }: { status: StepStatus; children: React.ReactNode }) {
  return <span className={`pill pill-${status}`}>{children}</span>;
}

function Hero({ result }: { result: ScenarioResult }) {
  const meta = OUTCOME_META[result.outcome];
  const wasHeldFirst = result.outcome === "confirmed_after_approval";
  return (
    <div className={`hero hero-${meta.tone}`}>
      <div className="hero-top">
        <span className={`hero-label hero-label-${meta.tone}`}>{meta.label}</span>
        <span className="scenario-index">{result.name}</span>
      </div>
      <div className="hero-headline">{result.headline}</div>
      <div className="hero-sub">{result.subheadline}</div>
      {wasHeldFirst && <div className="hero-journey">Held for Aimo-side approval first, then confirmed — not auto-approved.</div>}
      <div className="hero-ref">
        {result.transactionIdKind === "order" ? "Order reference" : "Quote reference (no order placed)"}: <code>{result.transactionId}</code>
      </div>
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

function AlternativesTable({ result }: { result: ScenarioResult }) {
  if (!result.alternatives || !result.requestedProduct) return null;
  const single = result.alternatives.length === 1;
  return (
    <div className="detail-card">
      <h4>{single ? "Actual substitute returned by Aimo" : "Requested vs. disclosed alternatives"}</h4>
      <div className="kv-row">
        <span className="k">Requested, unavailable</span>
        <span className="v">
          {result.requestedProduct.name} ({result.requestedProduct.id})
        </span>
      </div>
      {result.alternativesNote && <p className="mock-note">{result.alternativesNote}</p>}
      <table className="alt-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Price</th>
            <th>Availability</th>
            <th>Buyer policy</th>
          </tr>
        </thead>
        <tbody>
          {result.alternatives.map((alt: AlternativeReview) => (
            <Fragment key={alt.product_id}>
              <tr className={alt.buyerDecision === "rejected" ? "alt-row-rejected" : "alt-row-eligible"}>
                <td>#{alt.rank} {alt.name}</td>
                <td>{alt.price_eur !== null ? `€${alt.price_eur.toFixed(2)}` : "—"}</td>
                <td>{alt.availability_status.replace(/_/g, " ")}</td>
                <td>
                  <Pill status={alt.buyerDecision === "rejected" ? "rejected" : "passed"}>{alt.buyerDecision}</Pill>
                </td>
              </tr>
              <tr className="alt-detail-row">
                <td colSpan={4}>
                  <span className="alt-sku">SKU {alt.product_id}</span>
                  {" · allergen codes: "}
                  {alt.allergens.length > 0 ? alt.allergens.map((a) => a.code).join(", ") : "none disclosed"}
                  {" — "}
                  {alt.buyerReason}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BasketOutcome({ result }: { result: ScenarioResult }) {
  if (!result.relevantLines) return null;
  const eligibleCount = result.relevantLines.filter((l) => l.status === "available").length;
  return (
    <div className="detail-card">
      <div className="basket-header">
        <h4 style={{ margin: 0 }}>Basket evaluation</h4>
        <span className="badge-sandbox" style={{ background: "var(--info-dim)", color: "var(--info)", borderColor: "#233a5c" }}>
          Quote only
        </span>
      </div>
      <div className="basket-fraction">
        {eligibleCount} / {result.relevantLines.length}
      </div>
      <div className="basket-fraction-caption">Lines currently eligible for ordering</div>
      <div className="basket-grid">
        {result.relevantLines.map((line) => {
          const unit = quantityUnitFor(line.requested_product_id);
          const eligible = line.status === "available";
          return (
            <div className={`basket-line ${eligible ? "basket-line-ready" : "basket-line-pending"}`} key={line.requested_product_id}>
              <div className="basket-line-name">{line.requested_product_name}</div>
              <Pill status={eligible ? "passed" : "blocked"}>{eligible ? "Eligible" : "Unavailable"}</Pill>
              <div className="basket-line-meta">
                {line.requested_qty.toLocaleString()} {unit}
                {line.line_total_eur !== null && ` · €${line.line_total_eur.toFixed(2)}`}
              </div>
              {!eligible && <div className="basket-line-note">Substitution required — would follow the same disclosure flow as scenario 3.</div>}
            </div>
          );
        })}
      </div>
      {result.eligibleLineValueEur !== undefined && (
        <div className="kv-row" style={{ marginTop: 10, fontWeight: 700 }}>
          <span className="k">Eligible line value</span>
          <span className="v">€{result.eligibleLineValueEur.toFixed(2)}</span>
        </div>
      )}
      <p className="mock-note" style={{ marginTop: 8 }}>
        No order has been placed. Both lines remain part of the quote evaluation.
      </p>
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

function ApprovalSequence({ result }: { result: ScenarioResult }) {
  if (!result.governanceCheck) return null;
  return (
    <div className="detail-card sequence-card">
      <h4>Approval sequence — chronological</h4>
      <ol className="sequence">
        {result.steps.map((s, i) => (
          <li className={`sequence-item pill-${s.status}`} key={i}>
            <span className="sequence-num">{i + 1}</span>
            <div>
              <div className="sequence-title">{s.title}</div>
              <div className="sequence-detail">{s.detail}</div>
            </div>
          </li>
        ))}
      </ol>
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

function EnvelopeSummary({ envelope }: { envelope: TrustEnvelope<any> }) {
  return (
    <div>
      <div className="kv-row">
        <span className="k">Issuer</span>
        <span className="v">{envelope.provenance.issuer}</span>
      </div>
      <div className="kv-row">
        <span className="k">Source</span>
        <span className="v">{envelope.provenance.source_system}</span>
      </div>
      <div className="kv-row">
        <span className="k">Observed</span>
        <span className="v">{formatDateTime(envelope.provenance.observed_at)}</span>
      </div>
      <div className="kv-row">
        <span className="k">Valid until</span>
        <span className="v">{formatDateTime(envelope.validity.expires_at)}</span>
      </div>
      <div className="kv-row">
        <span className="k">Verification</span>
        <span className="v">{envelope.verification.status}</span>
      </div>
      <p className="mock-note">
        <code>mock_verified</code> — retrieved live from the designated sandbox with structured provenance, but not cryptographically
        signed.
      </p>
      <details className="raw">
        <summary>Raw trust envelope JSON</summary>
        <pre>{JSON.stringify(envelope, null, 2)}</pre>
      </details>
    </div>
  );
}

function QuoteEvidence({ line, requestedDeliveryDate }: { line: QuoteLine; requestedDeliveryDate: string }) {
  const unit = quantityUnitFor(line.requested_product_id);
  const stockQty = formatStockQuantity(line.envelope.claim.availability.quantity);
  const confirmedDate = line.envelope.claim.availability.confirmed_available_date;
  const datesMatch = confirmedDate === requestedDeliveryDate;
  return (
    <div>
      <div className="kv-row">
        <span className="k">Product</span>
        <span className="v">{line.requested_product_name}</span>
      </div>
      <div className="kv-row">
        <span className="k">Quantity requested</span>
        <span className="v">
          {line.requested_qty.toLocaleString()} {unit}
        </span>
      </div>
      <div className="kv-row">
        <span className="k">Requested delivery date</span>
        <span className="v">{requestedDeliveryDate}</span>
      </div>
      <div className="kv-row">
        <span className="k">Supplier-confirmed date</span>
        <span className="v">
          {confirmedDate ?? "not confirmed"}
          {confirmedDate && !datesMatch && <span style={{ color: "var(--amber)" }}> (differs from requested)</span>}
        </span>
      </div>
      {line.unit_price_eur !== null && (
        <div className="kv-row">
          <span className="k">Supplier price</span>
          <span className="v">€{line.unit_price_eur.toFixed(2)} per sales unit</span>
        </div>
      )}
      {line.unit_price_eur !== null && unit !== "units" && (
        <div className="kv-row">
          <span className="k">Displayed as</span>
          <span className="v">
            €{line.unit_price_eur.toFixed(2)} / {unit} <span style={{ opacity: 0.6 }}>(this SKU's sales unit is 1 {unit})</span>
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
        <span className="k">Live stock level</span>
        <span className="v">{stockQty}</span>
      </div>
      <EnvelopeSummary envelope={line.envelope} />
    </div>
  );
}

function TechnicalEvidence({ result }: { result: ScenarioResult }) {
  const line = result.quote?.lines.find((l) => l.requested_product_id === result.quote?.lines[0].requested_product_id);
  const showQuoteLine = result.id === "1" || result.id === "2";
  return (
    <details className="tech-evidence">
      <summary>Show technical evidence — timeline, trust envelope, audit log</summary>
      <div className="tech-evidence-body">
        {!result.governanceCheck && (
          <div className="detail-card">
            <h4>Step-by-step timeline</h4>
            <div className="timeline">
              {result.steps.map((s, i) => (
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
          </div>
        )}

        {showQuoteLine && line && result.quote && (
          <div className="detail-card">
            <h4>Quote and trust envelope</h4>
            <QuoteEvidence line={line} requestedDeliveryDate={result.quote.requested_delivery_date} />
          </div>
        )}

        {result.quote && (
          <div className="kv-row">
            <span className="k">Quote expires</span>
            <span className="v">{formatDateTime(result.quote.expires_at)}</span>
          </div>
        )}

        {result.audit.length > 0 && (
          <div className="detail-card">
            <h4>Audit events</h4>
            <div className="audit-list">
              {result.audit.map((e: AuditEvent, i: number) => (
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
        )}
      </div>
    </details>
  );
}

function TransactionWorkspace({ result }: { result: ScenarioResult }) {
  return (
    <div className="workspace">
      <Hero result={result} />
      <ApprovalSequence result={result} />
      <PolicyPanels result={result} />
      <AlternativesTable result={result} />
      <BasketOutcome result={result} />
      <GovernanceCheckCard result={result} />
      <ApprovalDetail result={result} />
      <TechnicalEvidence result={result} />
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
        {FLOW_STEPS.map((f, i) => (
          <span className="flow-item" key={f.title}>
            <span className="flow-step">
              <span className="flow-step-title">{f.title}</span>
              <span className="flow-step-sub">{f.sub}</span>
            </span>
            {i < FLOW_STEPS.length - 1 && <span className="flow-arrow">→</span>}
          </span>
        ))}
      </div>

      <p className="problem">
        <strong>The problem:</strong> how can an autonomous buyer agent purchase from a supplier safely, without either side controlling
        the other's policies? Price and stock below are live from Valio Aimo's real Junction26 challenge backend. Live retrieval and
        cryptographic verification are different things: every claim carries a <code>mock_verified</code> trust envelope (explained once,
        under "technical evidence" in each scenario below) — never presented as a production-grade verification standard.
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
          <button className="scenario-card" key={s.id} onClick={() => run(s.id)} disabled={loading[s.id]}>
            <span className="scenario-index">{s.index}</span>
            <h3>{s.title}</h3>
            <span className="scenario-tagline">{s.tagline}</span>
            <p>{s.description}</p>
            <span className="run-btn">{loading[s.id] ? "Running…" : "Explore scenario"}</span>
          </button>
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
