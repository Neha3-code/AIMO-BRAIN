"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { formatEur, type AlternativeReview, type Outcome, type ScenarioResult, type StepStatus } from "../lib/scenarios";
import { HOTEL_ESPOO_POLICY, RELIABILITY_DISCLOSURE_CAVEAT, type CheckResult } from "../lib/policyEngine";
import type { AuditEvent, ProductFacts, ProductLookupResult, QuoteLine, TrustEnvelope } from "@aimo/shared";

const SCENARIO_CARDS = [
  {
    id: "1",
    index: "01",
    badge: "AUTO",
    tabLabel: "Auto",
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
    tabLabel: "Approval",
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
    tabLabel: "Substitution",
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
    tabLabel: "Partial",
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
    tabLabel: "Recipe",
    tone: "good" as const,
    icon: "flask" as const,
    title: "Recipe-chemistry substitution",
    description: "Pick a backup that keeps the recipe, carbon and delivery reliability intact.",
    outcome: "Policy-compliant substitute found"
  }
];

// Chip terms chosen from real word-frequency counts across the product data file's English names
// (e.g. "cheese" appears in 446 products, "chicken" in 432, "coffee" in 285, "vegan" in 191) — not
// guessed, so every chip is guaranteed to return real matches.
const EXAMPLE_SEARCHES: { label: string; query: string }[] = [
  { label: "Search for lactose-free milk", query: "milk" },
  { label: "Find salmon", query: "salmon" },
  { label: "Search for yoghurt", query: "yoghurt" },
  { label: "Find wheat bread", query: "wheat bread" },
  { label: "Find cheese", query: "cheese" },
  { label: "Search for chicken", query: "chicken" },
  { label: "Find coffee", query: "coffee" },
  { label: "Search for vegan", query: "vegan" }
];

/** A curated, separate path from free-text search — guaranteed to demonstrate real
 *  selected / needs-review / rejected outcomes instead of whatever a plain keyword search
 *  happens to surface. Each entry is a real catalog product (verified against live data). */
const RECOMMENDED_PRODUCTS: { id: string; query: string; label: string; note: string }[] = [
  { id: "464237", query: "coffee milk 1 l lactose free", label: "Valio coffee milk (lactose-free)", note: "One substitute selected, one needs manual review, one rejected on carbon" },
  { id: "468928", query: "wheat bread 75x35g", label: "Schulstad wheat bread", note: "Its only registered substitute violates this kitchen's allergen policy" },
  { id: "471068", query: "heinz beans in tomato sauce", label: "Heinz Beans in tomato sauce", note: "Two real substitutes, ranked and evaluated" },
  { id: "460105", query: "kinder bueno", label: "Kinder Bueno", note: "The product itself contains a banned allergen — see what happens if you try to order it directly" }
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

function SearchIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="11" cy="11" r="7.5" />
      <path d="m20.5 20.5-4.2-4.2" />
    </svg>
  );
}

function ChefHatIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 14.5a4 4 0 1 1 1.2-7.8 4 4 0 0 1 7.6 0A4 4 0 1 1 17 14.5V20H7v-5.5Z" />
      <path d="M7 17h10M10.5 11v3M13.5 11v3" />
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
        quote line; weight from the product's own packaging data. {RELIABILITY_DISCLOSURE_CAVEAT}
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

function CarbonRejectionCallout({ alt }: { alt: AlternativeReview }) {
  if (alt.carbonOriginal === null || alt.carbonSubstitute === null || alt.carbonDeltaPct === null) return null;
  return (
    <div className="carbon-callout">
      <div className="carbon-callout-title">Why {alt.name} was rejected on carbon</div>
      <div className="carbon-callout-grid">
        <div>
          <div className="metric-label">Original carbon intensity</div>
          <div className="metric-value">{fmtNum(alt.carbonOriginal)} kg CO₂e/kg</div>
        </div>
        <div>
          <div className="metric-label">Alternative carbon intensity</div>
          <div className="metric-value">{fmtNum(alt.carbonSubstitute)} kg CO₂e/kg</div>
        </div>
        <div>
          <div className="metric-label">Increase</div>
          <div className="metric-value cell-bad">+{alt.carbonDeltaPct} %</div>
        </div>
        <div>
          <div className="metric-label">Maximum permitted increase</div>
          <div className="metric-value">+{alt.carbonLimitPct} %</div>
        </div>
      </div>
      <p className="mock-note" style={{ marginTop: 8 }}>
        Rejected by buyer policy — this kitchen's own configured threshold, not Aimo's.
        {alt.recipe.verdict === "breaks_recipe" && " This alternative also breaks the recipe's composition tolerance, an independent reason on its own."}
      </p>
    </div>
  );
}

function RecipeMethodologyNote() {
  return (
    <details className="raw">
      <summary>How recipe compatibility is calculated</summary>
      <ul className="methodology-list">
        <li>Compares the original and substitute's declared nutritional composition (fat, protein, carbohydrate, sugar, salt — per 100 g).</li>
        <li>Measures the difference on each of those five components.</li>
        <li>Checks each difference against this kitchen's configured tolerance (an absolute gram figure or a % of the original, whichever is larger).</li>
        <li>Separately checks whether a lactose-free original would stop being lactose-free.</li>
        <li>Rejects the substitute if any component exceeds tolerance, or if it breaks a lactose-free requirement.</li>
      </ul>
      <p className="mock-note">
        This is a nutritional-composition compatibility check against the product's own declared data — not a guarantee that the
        substitute will taste, cook or behave identically in a real recipe.
      </p>
    </details>
  );
}

function NoRegisteredSubstitutes({ result }: { result: ScenarioResult }) {
  if (!result.noRegisteredSubstitutes || !result.requestedProduct) return null;
  return (
    <div className="detail-card">
      <h4>{result.requestedProductOutOfStock ? "Out of stock — no registered substitutes" : "No registered substitutes found"}</h4>
      <div className="kv-row">
        <span className="k">Original product</span>
        <span className="v">
          {result.requestedProduct.name} ({result.requestedProduct.id})
        </span>
      </div>
      {result.requestedProductOutOfStock && (
        <div className="kv-row">
          <span className="k">Stock</span>
          <span className="v">
            <Pill status="blocked">out of stock</Pill>
          </span>
        </div>
      )}
      <p className="mock-note" style={{ marginTop: 8 }}>
        {result.requestedProductOutOfStock ? "This product is out of stock, so it can't be ordered right now. " : ""}
        Aimo's catalogue has no registered substitutes for this product (only about 1% of the 17,546 SKUs have any), so the
        buyer agent had nothing it may substitute automatically. No substitute was selected and no order was placed.
        {result.categorySuggestions && result.categorySuggestions.length > 0 && " Same-category suggestions for a human to review are shown below."}
      </p>
      <Pill status="info">no substitute available</Pill>
    </div>
  );
}

/** One row (plus check details) per evaluated option — shared by registered substitutes and
 *  same-category suggestions so both are judged and shown identically. */
function AlternativeReviewTable({ alternatives }: { alternatives: AlternativeReview[] }) {
  return (
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
        {alternatives.map((alt: AlternativeReview) => (
          <Fragment key={alt.product_id}>
            <tr
              className={
                alt.buyerDecision === "rejected"
                  ? "alt-row-rejected"
                  : alt.buyerDecision === "selected"
                    ? "alt-row-selected"
                    : alt.buyerDecision === "needs_review"
                      ? "alt-row-review"
                      : "alt-row-eligible"
              }
            >
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
                <Pill
                  status={
                    alt.buyerDecision === "rejected" ? "rejected" : alt.buyerDecision === "selected" ? "complete" : alt.buyerDecision === "needs_review" ? "pending" : "passed"
                  }
                >
                  {alt.buyerDecision === "needs_review" ? "manual review" : alt.buyerDecision.replace(/_/g, " ")}
                </Pill>
              </td>
            </tr>
            {alt.buyerDecision === "rejected" && alt.carbonOriginal !== null && alt.carbonSubstitute !== null && alt.carbonDeltaPct !== null && alt.carbonDeltaPct > alt.carbonLimitPct && (
              <tr className="alt-detail-row">
                <td colSpan={7}>
                  <CarbonRejectionCallout alt={alt} />
                </td>
              </tr>
            )}
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
  );
}

function CategorySuggestions({ result }: { result: ScenarioResult }) {
  if (!result.categorySuggestions || !result.requestedProduct) return null;
  const count = result.categorySuggestions.length;
  const passing = result.categorySuggestions.filter((a) => a.buyerDecision !== "rejected").length;
  return (
    <div className={count > 0 ? "detail-card detail-card-highlight" : "detail-card"}>
      {count > 0 && (
        <div className="highlight-badge">
          {count} in-stock suggestion{count === 1 ? "" : "s"} · {passing} pass{passing === 1 ? "es" : ""} this kitchen&apos;s checks
        </div>
      )}
      <h4>Same-category suggestions — not registered substitutes</h4>
      {result.categorySuggestionsNote && <p className="mock-note">{result.categorySuggestionsNote}</p>}
      {result.categorySuggestions.length === 0 ? (
        <p className="mock-note">No other product in this category is orderable right now.</p>
      ) : (
        <>
          {result.originalFacts && <OriginalFactsRow facts={result.originalFacts} />}
          <AlternativeReviewTable alternatives={result.categorySuggestions} />
          <p className="mock-note" style={{ marginTop: 10 }}>
            <strong>Order:</strong> products that pass every check first, then the closest recipe match, then lower carbon. Even an
            &ldquo;eligible&rdquo; suggestion needs a human to confirm it — the buyer agent only auto-substitutes products the catalog registers
            as substitutes.
          </p>
        </>
      )}
    </div>
  );
}

function AlternativesTable({ result }: { result: ScenarioResult }) {
  if (!result.alternatives || result.alternatives.length === 0 || !result.requestedProduct) return null;
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
      <AlternativeReviewTable alternatives={result.alternatives} />
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
      <p className="mock-note" style={{ marginTop: 10 }}>{RELIABILITY_DISCLOSURE_CAVEAT}</p>
      <RecipeMethodologyNote />
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
      <NoRegisteredSubstitutes result={result} />
      <CategorySuggestions result={result} />
      <AlternativesTable result={result} />
      <BasketOutcome result={result} />
      <GovernanceCheckCard result={result} />
      <ApprovalDetail result={result} />
      <TechnicalEvidence result={result} />
    </div>
  );
}

function bannedAllergenHits(allergens: { code: string; relation: string }[]): string[] {
  return allergens.filter((a) => a.relation === "CONTAINS" && HOTEL_ESPOO_POLICY.bannedAllergenCodes.includes(a.code)).map((a) => a.code);
}

function ProductCard({
  r,
  isSelected,
  onSelect,
  onFindSubstitutes,
  substitutesLoading,
  knownNoSubstitutes
}: {
  r: ProductLookupResult;
  isSelected: boolean;
  onSelect: () => void;
  onFindSubstitutes: () => void;
  substitutesLoading: boolean;
  /** Learned from an earlier lookup in this session — covers an aimo-api that doesn't report the count yet. */
  knownNoSubstitutes: boolean;
}) {
  const containsCodes = r.allergens.filter((a) => a.relation === "CONTAINS").map((a) => a.code);
  const bannedHits = bannedAllergenHits(r.allergens);
  const carbon = r.carbon_footprint_kg_co2e_per_kg !== null ? Number(r.carbon_footprint_kg_co2e_per_kg) : null;
  const reliability = r.delivery_reliability !== null ? Number(r.delivery_reliability) : null;
  const outOfStock = r.envelope.claim.availability.status === "out_of_stock";
  // Undefined when talking to an older aimo-api that doesn't report the count yet — keep the button enabled then.
  const subCount = r.registered_substitute_count;
  const noSubs = subCount === 0 || knownNoSubstitutes;
  return (
    <div className={`explorer-item ${isSelected ? "explorer-item-selected" : ""}`}>
      <div className="explorer-item-name">{r.name}</div>
      <div className="explorer-item-price-row">
        <span className="explorer-item-price">{r.envelope.claim.price ? formatEur(r.envelope.claim.price.amount) : "price unavailable"}</span>
        <Pill status={outOfStock ? "blocked" : "passed"}>{r.envelope.claim.availability.status.replace(/_/g, " ")}</Pill>
      </div>
      <div className="explorer-item-grid">
        <div className="explorer-metric">
          <div className="explorer-metric-value">{carbon !== null ? fmtNum(carbon) : "—"}</div>
          <div className="explorer-metric-label">kg CO₂e/kg</div>
        </div>
        <div className="explorer-metric">
          <div className="explorer-metric-value">{reliability !== null ? fmtPct(reliability) : "no history"}</div>
          <div className="explorer-metric-label">On-time delivery</div>
        </div>
        <div className="explorer-metric">
          <div className="explorer-metric-value">{containsCodes.length > 0 ? containsCodes.join(", ") : "none"}</div>
          <div className="explorer-metric-label">Allergen codes</div>
        </div>
      </div>
      {bannedHits.length > 0 && (
        <div className="explorer-warning">⚠ Contains banned allergen code(s) {bannedHits.join(", ")} — shown for inspection only; this kitchen's policy will block ordering it directly.</div>
      )}
      {(subCount !== undefined || noSubs) && (
        <div className="explorer-subs-note">
          {noSubs
            ? outOfStock
              ? "Out of stock and no registered substitutes — same-category products can be suggested instead."
              : "No registered substitutes in the catalog — same-category products can be suggested instead."
            : `${subCount} registered substitute${subCount === 1 ? "" : "s"} in the catalog.`}
        </div>
      )}
      <div className="explorer-item-actions">
        <button type="button" className={outOfStock ? "run-btn run-btn-secondary run-btn-sm" : "run-btn run-btn-sm"} onClick={onSelect}>
          Select product
        </button>
        <button
          type="button"
          className={noSubs ? "run-btn run-btn-muted run-btn-sm" : outOfStock ? "run-btn run-btn-sm" : "run-btn run-btn-secondary run-btn-sm"}
          onClick={onFindSubstitutes}
          disabled={substitutesLoading}
          title={noSubs ? "No registered substitutes — shows same-category products checked against this kitchen's policy" : undefined}
        >
          {substitutesLoading ? "Finding…" : noSubs ? "Suggest similar products" : "Find compliant substitutes"}
        </button>
      </div>
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
  const [substitutesLoadingId, setSubstitutesLoadingId] = useState<string | null>(null);
  const [noSubstituteIds, setNoSubstituteIds] = useState<Set<string>>(() => new Set());
  function rememberNoSubstitutes(data: unknown) {
    const d = data as Partial<ScenarioResult>;
    if (d?.noRegisteredSubstitutes && d.requestedProduct) {
      const id = d.requestedProduct.id;
      setNoSubstituteIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }
  }

  // Every action's outcome lands further down the page, so scroll to it once React has rendered it.
  const resultsRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [scrollTarget, setScrollTarget] = useState<{ to: "results" | "selected" | "outcome"; n: number } | null>(null);
  const scrollTo = (to: "results" | "selected" | "outcome") => setScrollTarget((prev) => ({ to, n: (prev?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!scrollTarget) return;
    const el = { results: resultsRef, selected: selectedRef, outcome: outcomeRef }[scrollTarget.to].current;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollTarget]);

  const pendingLabel = running
    ? "Evaluating purchase with the AI buyer agent…"
    : substitutesLoadingId
      ? "Finding and evaluating registered substitutes…"
      : null;

  function selectProduct(r: ProductLookupResult) {
    setSelected(r);
    setCustomResult(null);
    scrollTo("selected");
  }

  async function runSearch(q: string): Promise<ProductLookupResult[]> {
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
        return [];
      }
      setSearchResults(data.results);
      return data.results;
    } finally {
      setSearching(false);
    }
  }

  async function search(e?: React.FormEvent, overrideQuery?: string) {
    e?.preventDefault();
    const q = overrideQuery ?? query;
    if (overrideQuery !== undefined) setQuery(overrideQuery);
    await runSearch(q);
    scrollTo("results");
  }

  async function selectRecommended(item: (typeof RECOMMENDED_PRODUCTS)[number]) {
    setQuery(item.query);
    const results = await runSearch(item.query);
    const match = results.find((r) => r.envelope.claim.product_id === item.id) ?? results[0] ?? null;
    setSelected(match);
    if (match) scrollTo("selected");
  }

  async function evaluatePurchase() {
    if (!selected) return;
    setRunning(true);
    setCustomResult(null);
    scrollTo("outcome");
    try {
      const res = await fetch("/api/custom-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: selected.envelope.claim.product_id, qty })
      });
      const data = await res.json();
      setCustomResult(data);
      rememberNoSubstitutes(data);
      scrollTo("outcome");
    } catch (err) {
      setCustomResult({ error: "request_failed", message: (err as Error).message });
      scrollTo("outcome");
    } finally {
      setRunning(false);
    }
  }

  async function findSubstitutesFor(r: ProductLookupResult) {
    setSelected(r);
    setSubstitutesLoadingId(r.envelope.claim.product_id);
    setCustomResult(null);
    scrollTo("outcome");
    try {
      const res = await fetch("/api/substitutes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: r.envelope.claim.product_id })
      });
      const data = await res.json();
      setCustomResult(data);
      rememberNoSubstitutes(data);
      scrollTo("outcome");
    } catch (err) {
      setCustomResult({ error: "request_failed", message: (err as Error).message });
      scrollTo("outcome");
    } finally {
      setSubstitutesLoadingId(null);
    }
  }

  const selectedBannedHits = selected ? bannedAllergenHits(selected.allergens) : [];
  const selectedOutOfStock = selected?.envelope.claim.availability.status === "out_of_stock";

  return (
    <div className="workspace explorer-workspace" id="explorer">
      <h2 style={{ marginTop: 0 }}>Test AIMO BRAIN with any product</h2>
      <p className="explorer-lede">
        Search the live Junction26 product catalogue — 17,546 real SKUs — and watch the AI purchasing workflow make its
        decisions: the exact same quote → buyer policy → order pipeline as the scenarios above, nothing special-cased.
      </p>

      <div className="section-title" style={{ margin: "0 0 10px" }}>
        Recommended products to try
      </div>
      <p className="explorer-lede" style={{ marginBottom: 12 }}>
        A free-text search over 17,546 real SKUs will surface real noise — that's honest, not a bug, but it's the wrong
        starting point for a live demo. These four are curated to show a real selected / manual-review / rejected mix.
      </p>
      <div className="recommended-grid">
        {RECOMMENDED_PRODUCTS.map((item) => (
          <button key={item.id} type="button" className="recommended-card" onClick={() => selectRecommended(item)}>
            <div className="recommended-card-name">{item.label}</div>
            <div className="recommended-card-note">{item.note}</div>
          </button>
        ))}
      </div>

      <div className="section-title" style={{ margin: "24px 0 10px" }}>
        Or search the full catalogue yourself
      </div>
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
        <div className="explorer-results scroll-anchor" ref={resultsRef}>
          {searchResults.length === 0 && <p className="mock-note">No matches in the catalog for that search.</p>}
          {searchResults.map((r) => (
            <ProductCard
              r={r}
              key={r.envelope.claim.product_id}
              isSelected={selected?.envelope.claim.product_id === r.envelope.claim.product_id}
              onSelect={() => selectProduct(r)}
              onFindSubstitutes={() => findSubstitutesFor(r)}
              substitutesLoading={substitutesLoadingId === r.envelope.claim.product_id}
              knownNoSubstitutes={noSubstituteIds.has(r.envelope.claim.product_id)}
            />
          ))}
        </div>
      )}

      {selected && (
        <div className="detail-card scroll-anchor" ref={selectedRef}>
          <h4>Selected: {selected.name}</h4>
          {selectedOutOfStock && (
            <div className="explorer-warning" style={{ marginBottom: 10 }}>
              ⚠ This product is out of stock, so it can't be ordered directly.{" "}
              {selected.registered_substitute_count === 0
                ? "The catalog registers no substitutes for it either — evaluating it will suggest same-category products for you to review."
                : "Evaluating it will check its registered substitutes instead."}
            </div>
          )}
          {selectedBannedHits.length > 0 && (
            <div className="explorer-warning" style={{ marginBottom: 10 }}>
              ⚠ This product contains banned allergen code(s) {selectedBannedHits.join(", ")}. It's selected here for inspection
              only — the buyer policy will reject a direct order of it, and only a compliant substitute can be purchased.
            </div>
          )}
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
            <button className="run-btn" onClick={evaluatePurchase} disabled={running}>
              {running ? "Running…" : "Evaluate purchase with AI"}
            </button>
          </div>
          <p className="mock-note" style={{ marginTop: 8 }}>Checks buyer policy → requests quote → evaluates supplier policy → order decision.</p>
        </div>
      )}

      <div className="scroll-anchor" ref={outcomeRef}>
        {pendingLabel && (
          <div className="detail-card explorer-pending" role="status" aria-live="polite">
            <span className="explorer-spinner" aria-hidden="true" />
            {pendingLabel}
          </div>
        )}
        {customResult &&
          ("error" in customResult ? (
            <p className="mock-note explorer-error">{customResult.message ?? customResult.error}</p>
          ) : (
            <TransactionWorkspace result={customResult} />
          ))}
      </div>
    </div>
  );
}

export default function Page() {
  const [results, setResults] = useState<Record<string, ScenarioResult | { error: string; message?: string } | undefined>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState(SCENARIO_CARDS[0].id);

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
    <div className="site">
      <div className="utility-bar">
        <div className="container utility-inner">
          <nav className="utility-tabs" aria-label="Sections">
            <a className="utility-tab utility-tab-active" href="#top">
              <BrainIcon /> AIMO BRAIN
            </a>
            <a className="utility-tab" href="#scenarios">
              <ScenarioIcon name="cart" /> Scenarios
            </a>
            <a className="utility-tab" href="#explorer">
              <ScenarioIcon name="box" /> Try it yourself
            </a>
            <a className="utility-tab" href="#roles">
              <RoleIcon name="audit" /> Audit
            </a>
          </nav>
          <span className="utility-lang">Junction26 · EN</span>
        </div>
      </div>

      <header className="site-header">
        <div className="container header-inner">
          <a href="#top" className="header-logo" aria-label="Valio Aimo — AIMO BRAIN">
            <img src="/valio-aimo-logo.svg" alt="Valio Aimo" />
          </a>
          <nav className="main-nav" aria-label="Main">
            <a href="#how">How it works</a>
            <a href="#roles">Who decides</a>
            <a href="#scenarios">Scenarios</a>
            <a href="#explorer">Catalog</a>
            <a href="#help">Resources</a>
          </nav>
          <div className="header-actions">
            <a href="#explorer" className="header-search" aria-label="Search the catalog">
              <SearchIcon />
            </a>
            <a href="#scenarios" className="btn btn-lime">
              Explore demo
            </a>
          </div>
        </div>
      </header>

      <section className="hero-banner" id="top">
        <div className="container hero-banner-inner">
          <h1>AIMO BRAIN x Valio Aimo</h1>
          <p className="lede">
            Procurement that thinks. Trade that you can trust. Autonomous AI purchasing agents that trade with Valio Aimo — with
            independent buyer and supplier controls, and an audit trail for every decision.
          </p>
          <div className="cta-row">
            <a className="btn btn-lime" href="#scenarios">
              Explore demo
            </a>
            <a className="btn btn-white" href="#explorer">
              Try it yourself
            </a>
          </div>
        </div>
      </section>

      <section className="aimo-letters" id="how">
        <div className="container">
          <div className="letters-grid">
            <div className="letter-col">
              <span className="letter">A</span>
              <span className="letter-text">Autonomous purchasing that actually decides</span>
            </div>
            <div className="letter-col">
              <span className="letter">I</span>
              <span className="letter-text">Independent buyer and supplier policies</span>
            </div>
            <div className="letter-col">
              <span className="letter">M</span>
              <span className="letter-text">Mock-verified, live sandbox data</span>
            </div>
            <div className="letter-col">
              <span className="letter">O</span>
              <span className="letter-text">Open audit trail of every decision</span>
            </div>
          </div>
          <div className="letters-cta">
            <a className="btn btn-white" href="#roles">
              Learn more
            </a>
          </div>
        </div>
      </section>

      <section className="section section-lavender" id="roles">
        <div className="container">
          <h2 className="section-heading">Three parties, one transaction</h2>
          <div className="role-grid">
            <div className="role-card">
              <h3 className="role-title">Buyer AI</h3>
              <p className="role-desc">
                Applies the kitchen&apos;s own rules — budget, allergens, delivery dates, recipe chemistry and carbon limits. Aimo never
                sees or overrides them.
              </p>
              <span className="role-tag">Buyer-controlled</span>
            </div>
            <div className="role-card">
              <h3 className="role-title">Aimo AI</h3>
              <p className="role-desc">
                Applies supplier rules — credit limits and human approvals — and discloses carbon footprint and delivery reliability on
                every quote line.
              </p>
              <span className="role-tag">Supplier-controlled</span>
            </div>
            <div className="role-card">
              <h3 className="role-title">Audit</h3>
              <p className="role-desc">
                Records every decision — who decided what, why, and when — as independent evidence both sides can rely on.
              </p>
              <span className="role-tag">Independent evidence</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-light" id="scenarios">
        <div className="container">
          <h2 className="section-heading">Choose a scenario</h2>
          <p className="section-lede">
            <strong>The problem:</strong> how can an autonomous buyer agent trade with a supplier safely, without either side controlling
            the other&apos;s policies? Price and stock are live from Valio Aimo&apos;s Junction26 challenge sandbox — every claim is labeled{" "}
            <code>mock_verified</code>, never presented as a production feed.
          </p>
          <div className="scenario-tabs" role="tablist">
            {SCENARIO_CARDS.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={activeTab === s.id}
                className={`scenario-tab scenario-tab-${s.tone} ${activeTab === s.id ? "scenario-tab-active" : ""}`}
                onClick={() => setActiveTab(s.id)}
              >
                <span className="scenario-tab-icon">
                  <ScenarioIcon name={s.icon} />
                </span>
                <span className="scenario-tab-index">{s.index}</span> {s.tabLabel}
              </button>
            ))}
          </div>

          {SCENARIO_CARDS.filter((s) => s.id === activeTab).map((s) => {
            const result = results[s.id];
            return (
              <div className="scenario-panel-wrap" key={s.id}>
                <div className={`scenario-panel scenario-panel-${s.tone}`}>
                  <span className="scenario-icon">
                    <ScenarioIcon name={s.icon} />
                  </span>
                  <div className="scenario-panel-body">
                    <span className="scenario-index">
                      {s.index} · {s.badge}
                    </span>
                    <h3>{s.title}</h3>
                    <p>{s.description}</p>
                    <span className="scenario-outcome">Outcome: {s.outcome}</span>
                  </div>
                  <button className="run-btn" onClick={() => run(s.id)} disabled={loading[s.id]}>
                    {loading[s.id] ? "Running…" : "Run scenario"}
                  </button>
                </div>

                {result &&
                  ("error" in result ? (
                    <div className="workspace">
                      <Pill status="blocked">Error</Pill>
                      <div className="timeline-detail" style={{ marginTop: 8 }}>
                        {(result as any).message ?? (result as any).error}
                      </div>
                    </div>
                  ) : (
                    <TransactionWorkspace result={result} />
                  ))}
              </div>
            );
          })}

        </div>
      </section>

      <section className="section section-white">
        <div className="container">
          <ProductExplorer />
        </div>
      </section>

      <section className="section section-light" id="help">
        <div className="container">
          <h2 className="section-heading section-heading-left">
            <span className="heading-icon">
              <ChefHatIcon />
            </span>
            How can we help?
          </h2>
          <div className="help-grid">
            <div className="help-col">
              <h3>Live API</h3>
              <p>The interface Valio Aimo exposes to any authorized external purchasing agent — products, quotes, orders, approvals.</p>
              <a className="btn btn-petrol" href="https://aimo-api.onrender.com/health" target="_blank" rel="noreferrer">
                API status
              </a>
            </div>
            <div className="help-col">
              <h3>Run a scenario</h3>
              <p>Five end-to-end flows, from fully autonomous ordering to a two-sided human approval and recipe-safe substitution.</p>
              <a className="btn btn-petrol" href="#scenarios">
                Scenarios
              </a>
            </div>
            <div className="help-col">
              <h3>Try any product</h3>
              <p>Search all 17,546 real catalog SKUs and push any of them through the exact same buyer-agent pipeline.</p>
              <a className="btn btn-petrol" href="#explorer">
                Catalog
              </a>
            </div>
            <div className="help-col">
              <h3>What&apos;s real</h3>
              <p>See the README for what is live from the sandbox, what is inferred from docs, and what is invented for this demo.</p>
              <a className="btn btn-petrol" href="#footer">
                Data notes
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="status-strip">
        <div className="container status-strip-inner">
          <span>
            Sandbox today: <strong>aimo-api</strong> live and <strong>Junction26 catalog</strong> 17,546 SKUs
          </span>
          <a href="#scenarios">Run all scenarios</a>
        </div>
      </div>

      <footer className="site-footer" id="footer">
        <div className="container footer-inner">
          <img src="/valio-aimo-logo-white.svg" alt="Valio Aimo" className="footer-logo" />
          <p className="note">
            AIMO BRAIN — a Junction 2026 hackathon project for the Valio Aimo challenge. All price, stock and allergen data is from Valio
            Aimo&apos;s Junction26 challenge sandbox — not a production feed. See README.md for what&apos;s real, what&apos;s inferred, and
            what&apos;s invented for this demo.
          </p>
        </div>
      </footer>
    </div>
  );
}
