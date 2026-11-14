# AIMO BRAIN — Valio Aimo Trusted Trade Agents

Implementation of `PROJECT_SPEC.md` for the Junction 2026 Valio Aimo
challenge. Two independent sides talking over HTTP:

- **`apps/aimo-api`** — the actual deliverable: the interface Valio Aimo
  exposes so any authorized external purchasing agent can look up products,
  get a binding quote, place an order, and know when a human has to sign
  off. Deploy target: **Railway**.
- **`apps/buyer-demo`** — a reference buyer-agent + demo UI that calls
  `aimo-api` over HTTP and applies its own, separate guardrails. Deploy
  target: **Vercel/Netlify**.
- **`packages/shared`** — the TypeScript contract (trust envelope, quote,
  order, audit event) both sides import.
- **Database**: **Neon** Postgres, used by `aimo-api` only, over Neon's HTTP
  driver (`@neondatabase/serverless`) rather than a raw TCP pool — one HTTPS
  request per query, no connection pooling to manage, and it works from any
  sandboxed/serverless network that only allows outbound HTTPS.

## Real upstream data, not invented data

While exploring the open question in spec §10, we found the real Valio Aimo
mock backend at `junction26.valioaimo.fi` is live. `aimo-api` proxies it
directly for price and availability (server-side only — the upstream API key
never reaches the buyer-agent side):

- `POST /api/price` and `POST /api/availability` — real, working endpoints.
- The product data file's `substitutions[]` field is real (189 products have
  at least one real substitute), and its GS1/Synkka allergen classification
  codes are real, undisclosed to a human-readable name in this dataset.

`aimo-api` deliberately never bulk-queries price/availability for the whole
17,546-product catalog — the upstream API's own OpenAPI description asks
callers to narrow the candidate set first (undisclosed rate limits apply).
Static catalog facts (name, category, allergens, substitutions, carbon
footprint, delivery reliability) are seeded once into Neon from the three
provided files; price and stock are always fetched live.

## Labeled assumptions (spec §9)

1. **Challenge-supplied, verified real**: `/api/price`, `/api/availability`,
   the product data file's `substitutions[]` field, its allergen
   classification codes, the carbon footprint and delivery reliability CSVs.
2. **Inferred from docs**: the trust-envelope shape (§3 of the spec), the
   availability→status mapping (`Stock` + 0 qty = out_of_stock, `Terminal` =
   always-available-from-supplier per the upstream docs), delivery lead time
   as the gap between `availableDate` and now.
3. **Invented for this demo, clearly not Valio Aimo's real commercial
   policy**: `data/buyers.json`'s `credit_limit_eur` /
   `aimo_side_auto_approve_limit_eur` (2 demo buyers), and the buyer-side
   kitchen's own internal mapping of a GS1 allergen code to "banned for this
   kitchen" (`apps/buyer-demo/lib/policyEngine.ts`). Aimo's dataset discloses
   raw allergen codes without a name dictionary; a real buyer's own system
   would maintain that translation, not us — we invented one example banned
   code (`AW`) to make the guardrail demonstrable.

## What production would also need

- **OAuth2 client-credentials** instead of the static API-key-to-buyer
  lookup table used here.
- **Idempotency keys** on `POST /v1/orders` (a retried request should not
  double-commit a quote).
- **Delivery-location and packaging-unit modeling** — this build treats
  `salesUnit` as opaque and ignores delivery address entirely.
- **Standing-order drift detection** and **async stock-change webhooks**
  instead of synchronous polling.
- A real GS1 allergen code dictionary, sourced from Valio Aimo or GS1 Synkka
  directly rather than guessed — we deliberately did not fabricate one (see
  `apps/aimo-api/src/allergens.ts`).

## Two independent guardrail layers

| Situation | Buyer's policy engine (`apps/buyer-demo/lib/policyEngine.ts`) | Aimo's guardrail (`apps/aimo-api/src/guardrail.ts`) |
|---|---|---|
| Product contains a banned allergen code | Reject / needs buyer approval | No opinion |
| Order exceeds kitchen's own budget | Reject or escalate to buyer | No opinion |
| Buyer exceeds its credit limit with Aimo | No opinion | Hold, needs Aimo approval |
| Order exceeds Aimo's auto-approval ceiling | No opinion | Hold, needs Aimo approval |

Neither file imports the other's config. `approval.owner` on a held order is
always `"buyer"` or `"aimo"`, and `POST /v1/orders/:id/approve` enforces it:
a buyer-side human cannot clear an Aimo-owned hold (403), and vice versa.

## Running locally

```bash
npm install

# 1. Point apps/aimo-api at a Neon (or any) Postgres and the real upstream API
cp apps/aimo-api/.env.example apps/aimo-api/.env
# edit DATABASE_URL, AIMO_UPSTREAM_API_KEY

npm run migrate   # creates tables
npm run seed      # loads the 3 provided data files into Postgres

npm run dev:api   # http://localhost:8080

# 2. Point the buyer-demo at the running aimo-api
cp apps/buyer-demo/.env.example apps/buyer-demo/.env
npm run dev:web   # http://localhost:3000 — click through the 3 scenarios

# or run the same 3 scenarios from the terminal:
npm run demo
```

## Deploying

- **Neon**: create a project, run `npm run migrate && npm run seed` once
  against its connection string.
- **Railway**: deploy `apps/aimo-api` as a Node service (`npm run build && npm start`
  from that workspace). Env vars: `DATABASE_URL`, `AIMO_UPSTREAM_BASE_URL`,
  `AIMO_UPSTREAM_API_KEY`, `AIMO_BUYER_API_KEYS`.
- **Vercel/Netlify**: deploy `apps/buyer-demo` as a Next.js app. Env vars:
  `AIMO_API_BASE_URL` (the Railway URL), `AIMO_API_KEY`, `BUYER_ID`.

## Verified end-to-end

Migrated and seeded a real Neon database (17,546 products from the real
dataset) and ran all 3 scenarios against the running `aimo-api` dev server,
hitting the real `junction26.valioaimo.fi` upstream for every price/
availability check:

- Scenario 1: milk quote €1,860, within credit limit and auto-approve
  ceiling → order confirmed directly.
- Scenario 2: milk quote €8,407.20, exceeds the €5,000 credit limit → held
  with `approval.owner: "aimo"`; a buyer-side approval attempt is correctly
  rejected with 403; the Aimo-side approval clears it to `confirmed`.
- Scenario 3: a real out-of-stock SKU (wheat bread, 468928) returns its one
  real substitute (wheat bun, 468995) disclosing allergen code `AW`; the
  buyer's own policy bans `AW` and rejects it, reporting there's no
  compliant option rather than silently picking it.

Also confirmed the same flow through `apps/buyer-demo`'s Next.js API route
(`/api/run-scenario`), i.e. the path the web UI uses.

## Demo script

See `PROJECT_SPEC.md` §8 for the three scenarios this build targets; the
same three run from both `npm run demo` (CLI) and the web UI
(`apps/buyer-demo`'s home page).
