"use client";

import { Fragment, useState } from "react";
import { formatEur, type AlternativeReview, type Outcome, type ScenarioResult, type StepStatus } from "../lib/scenarios";
import type { CheckResult } from "../lib/policyEngine";
import type { AuditEvent, ProductFacts, ProductLookupResult, QuoteLine, TrustEnvelope } from "@aimo/shared";

const SCENARIO_CARDS = [
  {
    id: "1",
    index: "01",
    badge: "AUTO",
    tone: "good" as const,
    icon: "cart" as const,
    title: "Autonomous purchasing",
    description: "Find, quote, approve and order automatically.",
    outcome: "Order confirmed"
  },
  {
    id: "2",
    index: "02",
    badge: "APPROVAL",
    tone: "warn" as const,
    icon: "userCheck" as const,
    title: "Two-sided approval",
    description: "Supplier approval required for a large order.",
    outcome: "Human approved"
  },
  {
    id: "3",
    index: "03",
    badge: "SAFETY",
    tone: "bad" as const,
    icon: "shield" as const,
    title: "Stock-out & substitution",
    description: "Reject alternatives that violate buyer rules.",
    outcome: "Unsafe option rejected"
  },
  {
    id: "4",
    index: "04",
    badge: "FLEXIBILITY",
    tone: "info" as const,
    icon: "box" as const,
    title: "Partial availability",
    description: "Handle available and unavailable lines separately.",
    outcome: "1 of 2 lines eligible"
  },
  {
    id: "5",
    index: "05",
    badge: "RECIPE",
    tone: "good" as const,
    icon: "flask" as const,
    title: "Recipe-chemistry substitution",
    description: "Pick a backup that keeps the recipe, carbon and delivery reliability intact.",
    outcome: "Recipe-safe backup chosen"
  }
];

const EXAMPLE_SEARCHES: { label: string; query: string }[] = [
  { label: "Search for lactose-free milk", query: "milk" },
  { label: "Find salmon", query: "salmon" },
  { label: "Search for yoghurt", query: "yoghurt" },
  { label: "Find wheat bread", query: "wheat bread" }
];

function ScenarioIcon({ name }: { name: "cart" | "userCheck" | "shield" | "box" | "flask" }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "cart":
      return (
        <svg {...common}>
          <circle cx="9" cy="20" r="1" />
          <circle cx="18" cy="20" r="1" />
          <path d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.8h8.2a2 2 0 0 0 2-1.6L21 8H6" />
        </svg>
      );
    case "userCheck":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M17 11l2 2 4-4" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
    case "box":
      return (
        <svg {...common}>
          <path d="M21 8l-9-5-9 5 9 5 9-5Z" />
          <path d="M3 8v8l9 5 9-5V8" />
          <path d="M12 13v8" />
        </svg>
      );
    case "flask":
      return (
        <svg {...common}>
          <path d="M9 3h6" />
          <path d="M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21.5h11.6a2 2 0 0 0 1.7-3L14 9V3" />
          <path d="M7 15h10" />
        </svg>
      );
  }
}

function RoleIcon({ name }: { name: "buyer" | "aimo" | "audit" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "buyer")
    return (
      <svg {...common}>
        <circle cx="9" cy="20" r="1" />
        <circle cx="18" cy="20" r="1" />
        <path d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.8h8.2a2 2 0 0 0 2-1.6L21 8H6" />
      </svg>
    );
  if (name === "aimo")
    return (
      <svg {...common}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h6M9 11h6M9 15h4" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M15 2a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" />
    </svg>
  );
}

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
function formatStockQuantity(status: string, quantity: number | null): string {
  const inStock = status === "in_stock" || status === "available";
  if (quantity === null) return inStock ? "In stock — quantity not disclosed" : "not disclosed";
  if (quantity >= 999999) return "In stock — sandbox quantity not capped";
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
        <span className="hero-scenario-name">{result.name}</span>
        <span className={`hero-label hero-label-${meta.tone}`}>{meta.label}</span>
      </div>
      <div className="hero-headline">{result.headline}</div>
      <div className="hero-sub">{result.subheadline}</div>
      {wasHeldFirst && <div className="hero-journey">Held for Aimo-side approval first, then confirmed — not auto-approved.</div>}
      <div className="hero-ref">
        {result.transactionId === null ? (
          "Catalog lookup only — nothing quoted or ordered"
        ) : (
          <>
            {result.transactionIdKind === "order" ? "Order reference" : "Quote reference (no order placed)"}: <code>{result.transactionId}</code>
          </>
        )}
      </div>
    </div>
  );
}

function PolicyPanels({ result }: { result: ScenarioResult }) {
  if (!result.buyerPolicy && !result.aimoPolicy) return null;
  return (
    <div className="policy-grid">
      <div className="policy-card policy-card-buyer">
        <div className="policy-owner">Buyer-owned policy</div>
        <div className="policy-sub">Decides what the buyer is willing to purchase</div>
        {result.buyerPolicy ? <Pill status={result.buyerPolicy.status}>{result.buyerPolicy.status.replace(/_/g, " ")}</Pill> : <Pill status="info">not evaluated</Pill>}
        <div className="policy-reason">{result.buyerPolicy?.reason ?? "No buyer-side check ran for this path."}</div>
      </div>
      <div className="policy-card policy-card-aimo">
        <div className="policy-owner">Supplier-owned policy</div>
        <div className="policy-sub">Decides what Aimo is willing to sell, and on what terms</div>
        {result.aimoPolicy ? <Pill status={result.aimoPolicy.status}>{result.aimoPolicy.status.replace(/_/g, " ")}</Pill> : <Pill status="info">no opinion</Pill>}
        <div className="policy-reason">{result.aimoPolicy?.reason ?? "Aimo's guardrail has no opinion on buyer-side allergen/budget rules."}</div>
      </div>
    </div>
  );
}

function DeliveryDateCard({ result }: { result: ScenarioResult }) {
  const d = result.deliveryDateDecision;
  if (!d) return null;
  return (
    <div className="detail-card">
      <h4>Delivery date evaluation — buyer-owned policy</h4>
      <div className="kv-row">
        <span className="k">Requested</span>
        <span className="v">{d.requestedDate}</span>
      </div>
      <div className="kv-row">
        <span className="k">Supplier confirmed</span>
        <span className="v">{d.confirmedDate ?? "not confirmed"}</span>
      </div>
      <div className="kv-row">
        <span className="k">Policy outcome</span>
        <span className="v">
          <Pill status={d.allowed ? "passed" : "blocked"}>{d.allowed ? "Within tolerance" : "Exceeds tolerance"}</Pill>
        </span>
      </div>
      <p className="mock-note" style={{ marginTop: 8 }}>{d.reason}</p>
    </div>
  );
}

function fmtNum(n: number | null | undefined, unit = ""): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })}${unit}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "no history";
  return `${Math.round(n * 1000) / 10} %`;
}

const CHECK_STATUS: Record<CheckResult["status"], StepStatus> = { pass: "passed", warn: "pending", fail: "rejected" };
const CHECK_LABEL: Record<CheckResult["check"], string> = {
  availability: "Stock",
  allergens: "Allergens",
  recipe: "Recipe chemistry",
  carbon: "Carbon",
  reliability: "Delivery reliability"
};

function SustainabilityCard({ result }: { result: ScenarioResult }) {
  const s = result.sustainability;
  if (!s) return null;
  const f = s.footprint;
  return (
    <div className="detail-card">
      <h4>Carbon footprint and delivery reliability</h4>
      <div className="metric-grid">
        <div className="metric">
          <div className="metric-label">Order footprint (estimate)</div>
          <div className="metric-value">{f.totalKgCo2e !== null ? `≈ ${f.totalKgCo2e.toLocaleString("en-US")} kg CO₂e` : "—"}</div>
          <div className="metric-sub">
            {f.intensityKgCo2ePerKg !== null ? `${fmtNum(f.intensityKgCo2ePerKg)} kg CO₂e per kg` : "no figure disclosed"}
            {f.totalWeightKg !== null && ` · ${f.totalWeightKg.toLocaleString("en-US")} kg of product`}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Historical delivery reliability</div>
          <div className="metric-value">{fmtPct(s.reliability.value)}</div>
          <div className="metric-sub">
            <Pill status={CHECK_STATUS[s.reliability.status]}>
              {s.reliability.status === "pass" ? "meets minimum" : s.reliability.status === "fail" ? "below minimum — flagged" : "unknown"}
            </Pill>
          </div>
        </div>
      </div>
      <p className="mock-note" style={{ marginTop: 8 }}>
        {f.note} {s.reliability.detail} Source: the challenge's carbon footprint and delivery reliability files, disclosed by Aimo on every
        quote line; weight from the product's own packaging data.
      </p>
    </div>
  );
}

function OriginalFactsRow({ facts }: { facts: ProductFacts }) {
  const c = facts.composition;
  return (
    <div className="original-facts">
      <span>
        <strong>Original per 100 g:</strong>{" "}
        {c
          ? `fat ${fmtNum(c.fat_g, " g")} · protein ${fmtNum(c.protein_g, " g")} · carbohydrate ${fmtNum(c.carbohydrate_g, " g")} · sugar ${fmtNum(c.sugar_g, " g")} · salt ${fmtNum(c.salt_g, " g")} · lactose ${fmtNum(c.lactose_g, " g")}`
          : "no declared composition"}
      </span>
      <span>
        <strong>Carbon:</strong> {facts.carbon_footprint_kg_co2e_per_kg !== null ? `${fmtNum(facts.carbon_footprint_kg_co2e_per_kg)} kg CO₂e/kg` : "not disclosed"} ·{" "}
        <strong>Delivery reliability:</strong> {fmtPct(facts.delivery_reliability)}
      </span>
    </div>
  );
}

function AlternativesTable({ result }: { result: ScenarioResult }) {
  if (!result.alternatives || !result.requestedProduct) return null;
  const single = result.alternatives.length === 1;
  const singleRejected = single && result.alternatives[0].buyerDecision === "rejected";
  const lookupOnly = result.transactionId === null;
  return (
    <div className="detail-card">
      <h4>
        {lookupOnly
          ? "Registered substitutes, evaluated by the buyer agent"
          : singleRejected
            ? "Substitution rejected"
            : single
              ? "Actual substitute returned by Aimo"
              : "Requested vs. disclosed alternatives"}
      </h4>
      <div className="kv-row">
        <span className="k">{lookupOnly ? "Original product" : "Requested, unavailable"}</span>
        <span className="v">
          {result.requestedProduct.name} ({result.requestedProduct.id})
        </span>
      </div>
      {result.alternativesNote && <p className="mock-note">{result.alternativesNote}</p>}
      {result.buyerBannedAllergenCodes && (
        <div className="kv-row">
          <span className="k">This kitchen's banned allergen codes</span>
          <span className="v">{result.buyerBannedAllergenCodes.join(", ")}</span>
        </div>
      )}
      {result.originalFacts && <OriginalFactsRow facts={result.originalFacts} />}
      <div className="table-scroll">
        <table className="alt-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Price</th>
              <th>Stock</th>
              <th>Recipe match</th>
              <th>CO₂e / kg</th>
              <th>Reliability</th>
              <th>Buyer decision</th>
            </tr>
          </thead>
          <tbody>
            {result.alternatives.map((alt: AlternativeReview) => (
              <Fragment key={alt.product_id}>
                <tr className={alt.buyerDecision === "rejected" ? "alt-row-rejected" : alt.buyerDecision === "selected" ? "alt-row-selected" : "alt-row-eligible"}>
                  <td>
                    #{alt.rank} {alt.name}
                  </td>
                  <td>{alt.price_eur !== null ? formatEur(alt.price_eur) : "—"}</td>
                  <td>{alt.availability_status.replace(/_/g, " ")}</td>
                  <td>
                    {alt.recipe.verdict === "unverified" ? "unverified" : `${alt.recipe.score ?? "—"}/100`}
                    {alt.recipe.verdict === "breaks_recipe" && <div className="cell-sub cell-bad">breaks recipe</div>}
                  </td>
                  <td>
                    {fmtNum(alt.facts.carbon_footprint_kg_co2e_per_kg)}
                    {alt.carbonDeltaPct !== null && alt.carbonDeltaPct !== 0 && (
                      <div className={`cell-sub ${alt.carbonDeltaPct > 0 ? "cell-bad" : "cell-good"}`}>
                        {alt.carbonDeltaPct > 0 ? "+" : ""}
                        {alt.carbonDeltaPct} %
                      </div>
                    )}
                  </td>
                  <td>{fmtPct(alt.facts.delivery_reliability)}</td>
                  <td>
                    <Pill status={alt.buyerDecision === "rejected" ? "rejected" : alt.buyerDecision === "selected" ? "complete" : "passed"}>{alt.buyerDecision}</Pill>
                  </td>
                </tr>
                <tr className="alt-detail-row">
                  <td colSpan={7}>
                    <div className="alt-detail-inner">
                    <span className="alt-sku">SKU {alt.product_id}</span>
                    {" · allergen codes contained: "}
                    {alt.allergens.filter((a) => a.relation === "CONTAINS").map((a) => a.code).join(", ") || "none disclosed"}
                    <ul className="check-list">
                      {alt.checks.map((c) => (
                        <li key={c.check}>
                          <Pill status={CHECK_STATUS[c.status]}>{CHECK_LABEL[c.check]}</Pill>
                          <span>{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                    </div>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {result.alternativesRanking && (
        <p className="mock-note" style={{ marginTop: 10 }}>
          <strong>Aimo's ranking:</strong> {result.alternativesRanking} <strong>Buyer's pick:</strong> the closest recipe match among
          options that pass every check, then lower carbon.
        </p>
      )}
      {singleRejected && (
        <p className="mock-note" style={{ marginTop: 10 }}>
          <strong>Buyer agent decision:</strong> the only alternative fails this kitchen's policy (see the failed checks above). No order placed.
        </p>
      )}
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
                {line.line_total_eur !== null && ` · ${formatEur(line.line_total_eur)}`}
              </div>
              {!eligible && <div className="basket-line-note">Substitution required — would follow the same disclosure flow as scenario 3.</div>}
            </div>
          );
        })}
      </div>
      {result.eligibleLineValueEur !== undefined && (
        <div className="kv-row" style={{ marginTop: 10, fontWeight: 700 }}>
          <span className="k">Eligible line value</span>
          <span className="v">{formatEur(result.eligibleLineValueEur)}</span>
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
        <span className="v">{order.approval.requested_amount_eur !== null ? formatEur(order.approval.requested_amount_eur) : "—"}</span>
      </div>
      <div className="kv-row">
        <span className="k">Approved amount</span>
        <span className="v">{order.approval.approved_amount_eur !== null ? formatEur(order.approval.approved_amount_eur) : "pending"}</span>
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
  const stockQty = formatStockQuantity(line.envelope.claim.availability.status, line.envelope.claim.availability.quantity);
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
          <span className="v">{formatEur(line.unit_price_eur)} per sales unit</span>
        </div>
      )}
      {line.unit_price_eur !== null && unit !== "units" && (
        <div className="kv-row">
          <span className="k">Displayed as</span>
          <span className="v">
            {formatEur(line.unit_price_eur)} / {unit} <span style={{ opacity: 0.6 }}>(this SKU's sales unit is 1 {unit})</span>
          </span>
        </div>
      )}
      {line.line_total_eur !== null && (
        <div className="kv-row">
          <span className="k">Line total</span>
          <span className="v">{formatEur(line.line_total_eur)}</span>
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
      <DeliveryDateCard result={result} />
      <SustainabilityCard result={result} />
      <AlternativesTable result={result} />
      <BasketOutcome result={result} />
      <GovernanceCheckCard result={result} />
      <ApprovalDetail result={result} />
      <TechnicalEvidence result={result} />
    </div>
  );
}

function ProductExplorer() {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ProductLookupResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProductLookupResult | null>(null);
  const [qty, setQty] = useState(10);
  const [customResult, setCustomResult] = useState<ScenarioResult | { error: string; message?: string } | null>(null);
  const [running, setRunning] = useState(false);

  async function search(e?: React.FormEvent, overrideQuery?: string) {
    e?.preventDefault();
    const q = overrideQuery ?? query;
    if (overrideQuery !== undefined) setQuery(overrideQuery);
    setSearching(true);
    setSearchError(null);
    setSelected(null);
    setCustomResult(null);
    try {
      const res = await fetch("/api/search-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q })
      });
      const data = await res.json();
      if (data.error) {
        setSearchError(data.message ?? data.error);
        setSearchResults([]);
      } else {
        setSearchResults(data.results);
      }
    } finally {
      setSearching(false);
    }
  }

  async function runCustom(mode: "order" | "substitutes") {
    if (!selected) return;
    setRunning(true);
    setCustomResult(null);
    try {
      const res = await fetch(mode === "order" ? "/api/custom-quote" : "/api/substitutes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: selected.envelope.claim.product_id, qty })
      });
      const data = await res.json();
      setCustomResult(data);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="workspace explorer-workspace" id="explorer">
      <h2 style={{ marginTop: 0 }}>Test AIMO BRAIN with any product</h2>
      <p className="explorer-lede">
        Search the live Junction26 product catalogue — 17,546 real SKUs — and watch the AI purchasing workflow make its
        decisions: the exact same quote → buyer policy → order pipeline as the scenarios above, nothing special-cased. Or ask for its
        registered substitutes and see which ones keep the recipe working.
      </p>
      <div className="explorer-chips">
        {EXAMPLE_SEARCHES.map((ex) => (
          <button key={ex.label} type="button" className="explorer-chip" onClick={() => search(undefined, ex.query)}>
            {ex.label}
          </button>
        ))}
      </div>
      <form className="explorer-search" onSubmit={search}>
        <input className="explorer-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. cheese, salmon, yoghurt…" />
        <button className="run-btn" type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search catalog"}
        </button>
      </form>

      {searchError && <p className="mock-note explorer-error">{searchError}</p>}

      {searchResults && (
        <div className="explorer-results">
          {searchResults.length === 0 && <p className="mock-note">No matches in the catalog for that search.</p>}
          {searchResults.map((r) => {
            const id = r.envelope.claim.product_id;
            const isSelected = selected?.envelope.claim.product_id === id;
            const containsCodes = r.allergens.filter((a) => a.relation === "CONTAINS").map((a) => a.code);
            return (
              <button className={`explorer-item ${isSelected ? "explorer-item-selected" : ""}`} key={id} onClick={() => setSelected(r)} type="button">
                <div className="explorer-item-name">{r.name}</div>
                <div className="explorer-item-meta">
                  {r.envelope.claim.price ? formatEur(r.envelope.claim.price.amount) : "price unavailable"}
                  <Pill status={r.envelope.claim.availability.status === "out_of_stock" ? "blocked" : "passed"}>
                    {r.envelope.claim.availability.status.replace(/_/g, " ")}
                  </Pill>
                  {containsCodes.length > 0 && <span>allergens: {containsCodes.join(", ")}</span>}
                  {r.carbon_footprint_kg_co2e_per_kg !== null && <span>{fmtNum(Number(r.carbon_footprint_kg_co2e_per_kg))} kg CO₂e/kg</span>}
                  {r.delivery_reliability !== null && <span>{fmtPct(Number(r.delivery_reliability))} on-time</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="detail-card">
          <h4>Selected: {selected.name}</h4>
          <div className="explorer-qty-row">
            <label className="explorer-qty-label">
              Quantity
              <input
                className="explorer-qty-input"
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
              />
            </label>
            <button className="run-btn" onClick={() => runCustom("order")} disabled={running}>
              {running ? "Running…" : "Run through the agent"}
            </button>
            <button className="run-btn run-btn-secondary" onClick={() => runCustom("substitutes")} disabled={running}>
              Find recipe-safe substitutes
            </button>
          </div>
        </div>
      )}

      {customResult &&
        ("error" in customResult ? (
          <p className="mock-note explorer-error">{customResult.message ?? customResult.error}</p>
        ) : (
          <TransactionWorkspace result={customResult} />
        ))}
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
      <div className="brand-row">
        <div className="brand-left">
          <span className="brand-icon">
            <BrainIcon />
          </span>
          <span className="brand-word">AIMO BRAIN</span>
        </div>
        <span className="badge-sandbox">Junction26 · 2026</span>
      </div>

      <h1>Procurement that thinks. Trade that you can trust.</h1>
      <p className="lede">Autonomous AI purchasing with independent buyer and supplier controls.</p>

      <div className="cta-row">
        <a className="cta-btn cta-btn-primary" href="#scenarios">
          Explore demo
        </a>
        <a className="cta-btn cta-btn-secondary" href="#explorer">
          Try it yourself
        </a>
      </div>

      <div className="role-grid">
        <div className="role-card">
          <span className="role-icon role-icon-buyer">
            <RoleIcon name="buyer" />
          </span>
          <div className="role-title">Buyer AI</div>
          <div className="role-desc">Buyer rules — budget, allergens, delivery dates, recipe chemistry and carbon limits.</div>
          <span className="role-tag">Buyer-controlled</span>
        </div>
        <div className="role-card">
          <span className="role-icon role-icon-aimo">
            <RoleIcon name="aimo" />
          </span>
          <div className="role-title">Aimo AI</div>
          <div className="role-desc">Supplier rules — credit limits and approvals. Discloses carbon footprint and delivery reliability.</div>
          <span className="role-tag">Supplier-controlled</span>
        </div>
        <div className="role-card">
          <span className="role-icon role-icon-audit">
            <RoleIcon name="audit" />
          </span>
          <div className="role-title">Audit</div>
          <div className="role-desc">Every decision — who decided what, why, and when.</div>
          <span className="role-tag">Independent evidence</span>
        </div>
      </div>

      <p className="problem">
        <strong>The problem:</strong> how can an autonomous buyer agent trade with a supplier safely, without either side
        controlling the other's policies? Price and stock below are live from Valio Aimo's real Junction26 challenge
        sandbox — every claim is clearly labeled <code>mock_verified</code>, never presented as a production feed.
      </p>

      <div className="section-title" id="scenarios">
        Choose a scenario
      </div>
      <div className="scenario-grid">
        {SCENARIO_CARDS.map((s) => (
          <button className={`scenario-card scenario-card-${s.tone}`} key={s.id} onClick={() => run(s.id)} disabled={loading[s.id]}>
            <div className="scenario-card-top">
              <span className="scenario-icon">
                <ScenarioIcon name={s.icon} />
              </span>
              <span className="scenario-index">
                {s.index} · {s.badge}
              </span>
            </div>
            <h3>{s.title}</h3>
            <p>{s.description}</p>
            <span className="scenario-outcome">Outcome: {s.outcome}</span>
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

      <ProductExplorer />

      <footer className="note">
        All price, stock and allergen data is from Valio Aimo's Junction26 challenge sandbox — not a production feed. See README.md for
        what's real, what's inferred, and what's invented for this demo.
      </footer>
    </div>
  );
}
