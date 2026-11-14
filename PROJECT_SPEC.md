# AIMO BRAIN — Project Spec (v2)
### Valio Aimo "Trusted Trade Agents" — Junction 2026

Feed this file to Claude Code as the implementation brief. It assumes the
repo already has the prototype built so far (`data/*.json`, `lib/policyEngine.js`,
`lib/agents.js`, `lib/orchestrator.js`, `demo.js`) and extends it to match the
actual challenge. v2 incorporates a team review of v1 — see §0 for what
changed and why.

---

## 0. What changed from v1

A review of v1 caught one real architectural bug and several gaps worth
closing cheaply. Adopted:

- **Substitution ranking leak (fixed).** v1 had Aimo's quote ranking exclude
  options based on a buyer's private allergen policy — meaning Aimo would
  need to know a specific kitchen's house rules to rank correctly. Wrong
  direction. **Aimo ranks alternatives on its own commercial attributes only
  (price, stock, delivery) and discloses allergen facts on every option; the
  buyer-side `policyEngine.js` — already built — does the filtering.** Aimo
  sells what it can sell; the buyer decides what it's allowed to buy.
- **Trust envelope, restructured.** Three flat fields (`data_confidence:
  "live"`) asserted trust without modeling it. Replaced with a
  claim/provenance/validity/verification structure (§3). No cryptography —
  just explicit structure, and verification status honestly labeled
  `"mock_verified"`, never `"verified"` or `"live"`.
- **Approval ownership, made explicit.** Every held order now states
  `approval.owner: "buyer" | "aimo"` so the two guardrail layers can never be
  confused with each other, and a buyer's agent can't approve an Aimo-side
  commercial hold.
- **Quote vs. lookup, separated.** A product lookup is informational. A quote
  is a locked, expiring, immutable commitment with its own ID. `POST
  /v1/orders` now binds to a `quote_id`, not a free-form product list.
- **Three demo scenarios, not "two beats."** Reorganized around end-to-end /
  autonomy / exception-handling, matching the three heaviest judging weights
  directly (§7).
- **Labeled assumptions.** §9 now separates challenge-supplied facts from
  rules we invented for the demo — say this out loud to judges rather than
  letting them assume our commercial rules are Valio's real ones.

Deliberately **not** adopted, to protect the remaining build time:
- Full OAuth2 client-credentials flow — a scoped API-key-to-buyer lookup
  table is enough; state OAuth2 as the documented production path instead of
  building it.
- Separate physical services for gateway/quote-engine/order-engine — keep
  one process with clearly separated modules; judges score the contract and
  the demo, not our deployment topology.
- Idempotency keys, delivery-location modeling, packaging units, standing-
  order drift detection — real, but not worth code time tonight. One README
  paragraph covers "what production would also need."

---

## 1. What the challenge actually asks for

Read literally, the brief is **not** "build an AI agent for a kitchen." It's:

> How can Valio Aimo (the wholesaler) expose an interface that lets an
> **external purchasing agent** — one the wholesaler doesn't control — look up
> products, get a price & availability quote, place an order, and know when a
> human has to sign off?

Valio Aimo is the one being asked to be "safely and openly readable by
autonomous agents." We build **both sides** for the demo (Valio Aimo's
interface + a reference buyer-agent that calls it), but the interface we
define for Valio Aimo's side is the actual deliverable. `lib/policyEngine.js`
lives on the **buyer-agent side** — real and good, but only half the
picture. The other half — a documented API contract Valio Aimo exposes, with
its own independent guardrail layer — is what's new in this spec.

**The pitch line to use with judges:**
> We are not building another AI purchasing assistant. We are building the
> trusted interface that lets any authorized AI purchasing agent do business
> with Valio Aimo safely, transparently and autonomously. The buyer controls
> what its agent is allowed to buy. Aimo controls what it's willing to sell.
> Our interface makes both sides work through verifiable data, independent
> policy enforcement, and human approval when it's actually needed.

### Judging weights (build in this priority order)

| Criterion | Weight | What it actually checks |
|---|---|---|
| Working end-to-end demo | 30% | Full request → lookup → order/approval flow runs live, not isolated pieces |
| Solving the problem & user need | 20% | How precisely the agent matches what was asked, with least manual correction |
| Autonomy and controls | 20% | Quality of guardrails — what's decided alone vs. escalated, and how it's logged |
| Robustness to exceptions | 15% | Partial availability, substitutions, delivery constraints — beyond happy path |
| Openness & credible path to production | 15% | Open/documented standards, visible assumptions, justified technical choices, real next steps |

---

## 2. Two-sided architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│   BUYER-SIDE AGENT           │  HTTP  │   VALIO AIMO INTERFACE (ours)      │
│   (reference implementation) │ ─────► │   the actual deliverable           │
│                               │ ◄───── │                                    │
│  - reads a kitchen's request  │        │  /v1/products          (lookup)    │
│  - calls the Aimo interface   │        │  /v1/quote             (offer)     │
│  - applies ITS OWN guardrails │        │  /v1/quote/:id         (retrieve)  │
│    (policyEngine.js — kitchen │        │  /v1/orders            (commit)    │
│    allergen policy, budget,   │        │  /v1/orders/:id        (status)    │
│    rejects unsafe options)    │        │  /v1/orders/:id/approve (human)    │
└─────────────────────────────┘        │  /v1/audit/:order_id   (trace)     │
                                        └──────────────────────────────────┘
                                                        │
                                                        ▼
                                          Valio Aimo mock backend
                                          (resource portal — real data if available)
                                          https://junction26.valioaimo.fi/
                                          password: aimo_ai_challenge
                                          API key: junct_tDnQn4VI_nfhELGCOEkY4vbuxm324MmYmILuokYG03Y
                                          (keep this key in an env var — never
                                           commit it, never show it on screen
                                           during the demo recording)
```

**Two independent policy engines. Do not merge them, do not let one read
the other's config.**

| Situation | Buyer's policy engine | Aimo's policy engine |
|---|---|---|
| Product contains a banned allergen | Reject / needs buyer approval | No opinion |
| Order exceeds kitchen's own budget | Reject or escalate to buyer | No opinion |
| Buyer exceeds its credit limit with Aimo | No opinion | Hold, needs Aimo approval |
| Order exceeds Aimo's auto-approval ceiling | No opinion | Hold, needs Aimo approval |
| Substitute outside buyer's stated preferences | Reject / needs buyer approval | No opinion |

This table *is* the "Autonomy and controls" answer — put it on a slide
verbatim.

---

## 3. Trust envelope

Every price/stock/origin claim Aimo returns carries this shape — this is the
literal answer to the brief's "minimum data/verification standard... without
a manual check":

```json
{
  "claim": {
    "product_id": "p-cream-36",
    "price": { "amount": 3.20, "currency": "EUR", "unit": "L" },
    "availability": { "status": "out_of_stock", "quantity": 0 }
  },
  "provenance": {
    "issuer": "Valio Aimo",
    "source_system": "aimo_mock_backend_v1",
    "observed_at": "2026-11-14T08:00:00Z"
  },
  "validity": {
    "expires_at": "2026-11-14T08:10:00Z"
  },
  "verification": {
    "status": "mock_verified",
    "reference_id": "stock-check-123"
  }
}
```

Rules:
- `verification.status` is **always** `"mock_verified"` in this build — never
  `"verified"` or `"live"`. We're honest that this is synthetic data, not a
  real wholesaler feed. Say this explicitly in the demo; it's a credibility
  point, not a weakness.
- Every `/v1/products` and `/v1/quote` response line carries its own
  envelope — not one envelope for the whole response. Stock on one SKU can
  be stale while another is fresh; the envelope has to be per-claim.
- `validity.expires_at` is what makes a quote bindable. A quote past its
  expiry is re-quoted, not silently honored.

---

## 4. Core API contract (Valio Aimo side)

Document as OpenAPI (`openapi.yaml` in repo root) — "open, documented
standards rather than a proprietary format" is scored explicitly (15%).

### `GET /v1/products?query=&category=&dietary=&max_price=`
Structured lookup, informational only (not a commercial commitment). Each
result wraps the trust envelope from §3 and adds catalog facts:

```json
{
  "claim": { "...": "as in §3" },
  "provenance": { "...": "as in §3" },
  "validity": { "...": "as in §3" },
  "verification": { "...": "as in §3" },
  "name": "Heavy cream 36%",
  "allergens": ["milk"],
  "sustainability_labels": ["carbon_neutral_milk_2035_pathway"],
  "delivery_lead_time_days": 1
}
```

### `POST /v1/quote`
Request → a locked, immutable, expiring offer. Alternatives are ranked by
**Aimo's own commercial attributes only** — price, stock, delivery lead time
— never by a buyer's private dietary/allergen policy. Allergen facts are
disclosed on every option so the buyer agent can filter them itself.

```json
// request
{ "buyer_id": "k-hotel-espoo", "lines": [{ "product_id": "p-cream-36", "qty": 10 }] }

// response
{
  "quote_id": "q-8821",
  "issued_at": "2026-11-14T08:00:00Z",
  "expires_at": "2026-11-14T08:10:00Z",
  "lines": [{
    "requested_product_id": "p-cream-36",
    "status": "unavailable",
    "alternatives": [
      { "rank": 1, "product_id": "p-cream-soy",     "price_eur": 3.30, "allergens": ["soy"] },
      { "rank": 2, "product_id": "p-cream-oat",      "price_eur": 3.60, "allergens": ["oat"] },
      { "rank": 3, "product_id": "p-creme-fraiche",  "price_eur": 4.10, "allergens": ["milk"] },
      { "rank": 4, "product_id": "p-cream-almond",   "price_eur": 3.90, "allergens": ["tree_nut"] }
    ]
  }],
  "total_eur": 33.00
}
```

Note rank 4: almond is cheaper than crème fraîche but ranks after it on price
alone here only because this example sorts strictly by price — Aimo returns
the full ranked list regardless of any buyer's allergy. **The buyer agent is
the one that removes almond before ever presenting an option to its own
policy engine for the hotel kitchen.** This is the fix from §0 — verify
`lib/agents.js`'s `find_alternatives` returns the *full* ranked list and that
no allergen filtering happens before the HTTP boundary.

### `GET /v1/quote/:id`
Retrieve a previously issued quote and its current status
(`active`/`expired`/`consumed`). Lets a buyer-agent check validity before
committing without re-requesting pricing.

### `POST /v1/orders`
Commits a quote. Body: `{ "quote_id": "q-8821", "buyer_id": "k-hotel-espoo" }`.
Rejects if the quote is expired or already consumed. Runs **Aimo's own**
guardrail check — separate function, separate config, from the buyer-side
one:

```json
{
  "order_id": "o-5521",
  "status": "held_for_approval",
  "approval": {
    "required": true,
    "owner": "aimo",
    "reason": "Order total €8,400 exceeds buyer's standing credit limit without manual review.",
    "requested_amount_eur": 8400,
    "approved_amount_eur": null
  },
  "lines_confirmed": [],
  "lines_held": ["..."]
}
```

`approval.owner` is always `"buyer"` or `"aimo"` — never omitted, never both.
A buyer's agent calling `/v1/orders/:id/approve` on an `owner: "aimo"` hold
should be rejected (403) — that's the governance boundary the review flagged,
and it's cheap to enforce with one `if`.

### `GET /v1/orders/:id`
Current order status and line-level detail.

### `POST /v1/orders/:id/approve`
Human (on the side named in `approval.owner`) clears a held order/line.

### `GET /v1/audit/:order_id`
Append-only, human-readable trace. Each entry: timestamp, actor
(`buyer_agent` / `aimo_api` / `human:buyer` / `human:aimo`), action, the
policy engine's `reasons[]`, and a `policy_version` string — so a decision
can be traced to the exact rule set that produced it, not just the outcome.
Reuse the `reasons[]` already produced by `check_compliance`; just persist
instead of only printing.

---

## 5. What to keep from the current prototype

- `lib/policyEngine.js` → buyer-agent's guardrail layer. **Keep as-is** —
  this is the piece the review called "one of your strongest ideas." Do not
  let it see Aimo-side config.
- `lib/agents.js` → becomes the buyer-agent's tool-use loop, calling the new
  HTTP API instead of reading `data/products.json` directly. **Fix:**
  `find_alternatives` must stop being the place substitution gets filtered —
  move allergen filtering to happen strictly buyer-side, after the HTTP
  response comes back, inside the existing `check_compliance` step. Aimo's
  side should never receive or consult a buyer's `allergen_policy`.
- `lib/orchestrator.js` → stays as the buyer-agent's run loop; swap its data
  source from local JSON to HTTP calls against `/v1/*`.
- `demo.js` → becomes the integration script hitting
  `http://localhost:PORT/v1/...`; update per §7's three scenarios.

New work is almost entirely: the Aimo-side API server, a second independent
Aimo-side policy function, the trust envelope, and persisted audit entries.

---

## 6. New data to add

`data/products.json` — add per record:
```json
"sustainability_labels": [],
"delivery_lead_time_days": 1
```
(Trust-envelope fields like `observed_at`/`expires_at`/`verification.status`
are generated per-request, not stored statically.)

`data/buyers.json` (extends `kitchens.json` with Aimo-side-only fields —
**label these as simulated, see §9**):
```json
{
  "id": "k-hotel-espoo",
  "api_key": "env:BUYER_HOTEL_ESPOO_KEY",
  "contract_tier": "contract",
  "credit_limit_eur": 5000,
  "aimo_side_auto_approve_limit_eur": 2000
}
```

`data/audit_log.json` or a SQLite `audit_events` table — append-only:
`{ order_id, timestamp, actor, action, reasons[], policy_version }`.

---

## 7. Build plan (prioritized to the judging weights, not feature count)

**Must build (covers 30% + 20% + 20% = 70% of score):**
1. Express/Fastify server exposing `/v1/products`, `/v1/quote`,
   `/v1/quote/:id`, `/v1/orders`, `/v1/orders/:id`,
   `/v1/orders/:id/approve` — wrapping existing `lib/` logic.
2. Trust envelope (§3) on every product/quote response line.
3. Aimo-side guardrail function — genuinely separate code/config from
   `policyEngine.js` — plus `approval.owner` enforcement on the approve
   endpoint (buyer can't clear an Aimo hold and vice versa).
4. Move allergen filtering to strictly buyer-side (the §0/§4 fix).
5. Audit log persisted, exposed via `GET /v1/audit/:order_id`, with
   `policy_version` and `reasons[]` on every entry.
6. Lightweight buyer-scoped API-key auth (key → buyer_id → scopes lookup
   table). State OAuth2 client-credentials as the documented production
   path, don't build it.
7. Update `demo.js` to run the full HTTP round trip for all three scenarios
   in §8, printing the audit trail at the end of each.

**Should build (covers the 15% robustness, if time remains):**
8. A second, independent client — a ~30-line Python script hitting the same
   API with no access to our internals — proving real interoperability.
9. One more partial-availability scenario beyond the two already modeled.

**If time remains (15% openness, cheap wins):**
10. `openapi.yaml` describing every endpoint in §4.
11. README paragraph: "what we mocked vs. what production needs" — OAuth2,
    idempotency keys on `/v1/orders`, delivery-location/packaging modeling,
    async stock-change webhooks. Ten minutes, high payoff.
12. A minimal visible permissions table/dashboard (even a static HTML table
    driven by `buyers.json` + the last few audit entries) so a judge can see
    the autonomy model without reading source.

**Explicitly skip (stretch-only, not scored core):**
- Delivery/sustainability comparison beyond the label fields already added.
- Standing-order drift detection.
- Category-level carbon-footprint ranges.
- Full OAuth2, idempotency keys, multi-service deployment topology.

---

## 8. Demo script — three scenarios, not a feature tour

**Scenario 1 — Autonomous purchasing (happy path).**
Use the brief's own example request almost verbatim: "I need 1,000 litres of
lactose-free milk by Monday — find an option that meets my requirements
based on price and availability." Show: lookup → quote (trust envelope
visible on screen) → buyer policy passes → Aimo policy passes → order
confirmed → audit trail printed. This proves the full commercial lifecycle,
not just a chat reply.

**Scenario 2 — Two-sided approval (the one that matters most for "autonomy
and controls").** Hotel orders ~€8,400. Buyer's policy engine clears the
product selection. Aimo's policy engine holds it — credit/commercial reason,
`approval.owner: "aimo"`. Show the hold, show a human approving it
specifically on the Aimo side, show the order moving to confirmed. This is
the single scenario that proves the two guardrail layers are real and
independent, not one engine wearing two hats.

**Scenario 3 — Stock-out and substitution (robustness).** Requested cream is
unavailable. Aimo returns the full ranked alternative list *including*
almond cream, with allergen facts attached, no filtering. The buyer agent
(hotel, tree-nut-banned kitchen) rejects almond on its own policy, picks the
next viable ranked option, and the response explains why in plain language.
This proves substitution isn't a blind cheapest-pick and proves the
ownership boundary from §0 live, not just on a slide.

Close by pointing at one live trust-envelope response on screen and reading
`provenance.observed_at`, `validity.expires_at`, `verification.status` aloud
— that's the concrete answer to "why should an external agent trust this
claim."

---

## 9. Labeled assumptions (say this part out loud to judges)

Separate three categories explicitly, in the README and in the pitch:

1. **Challenge-supplied** — whatever the resource portal's mock backend
   actually returns once we've checked it (see §10).
2. **Inferred from docs** — anything we derived from the challenge brief's
   wording but didn't see as a literal field in their API (e.g. the exact
   shape of a stock-confidence flag).
3. **Invented for the demo** — `credit_limit_eur`, `aimo_side_auto_approve_limit_eur`,
   specific buyer records in `data/buyers.json`, the almond/tree-nut scenario
   itself. These are ours, built to demonstrate the *mechanism*, not claims
   about Valio Aimo's real commercial policy.

Judges with commercial/technical backgrounds will ask; having the answer
ready ("that's category 3, invented to demonstrate the guardrail, here's
where a real integration would plug in Aimo's actual credit system instead")
is itself a point in "openness and credible path to production."

---

## 10. Open questions to resolve against the real resource portal

Check `https://junction26.valioaimo.fi/` (password `aimo_ai_challenge`)
before building further on invented data:
- Do they expose a real mock API we should call instead of our synthetic
  `data/products.json`? If so, swap it — this is the single highest-leverage
  thing left for the "openness" score, since judges can check our numbers
  against their own backend.
- Exact auth header format for the provided API key.
- Whether delivery lead times, sustainability labels, or a stock-confidence
  field already exist in their dataset — mirror their schema rather than
  inventing our own if so.
- Whether they define buyer/credit-limit semantics anywhere — if yes, that
  moves `data/buyers.json`'s fields from "invented" to "inferred" in §9.

---

## 11. Team split (4 people, by layer)

1. **Aimo-side API** — server, trust envelope, Aimo-side guardrail function,
   `approval.owner` enforcement, `openapi.yaml`.
2. **Buyer-agent integration** — rewire `lib/agents.js`/`orchestrator.js` to
   call the HTTP API; execute the §4/§5 allergen-filtering fix;
   `policyEngine.js` itself stays untouched.
3. **Audit trail + demo wiring** — persistence layer, `/v1/audit/:id`,
   updated `demo.js` for all three scenarios, rehearsal.
4. **Data + openness artifacts** — check the real resource portal, update
   `data/products.json`/`buyers.json` accordingly, write the §9 labeled-
   assumptions section and README production-path paragraph, build the
   second independent client if time allows.
