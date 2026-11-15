# Implementation status

Audit of the repository against PROJECT.md (the AIMO BRAIN product direction brief), section 2,
plus what the first Phase 0 / Phase 1 slice added. Audited 2026-11-15.

Classification: **working** (real, exercised end to end), **partial**, **demo-only** (works, but
on hardcoded or invented inputs), **missing**.

## Summary

The Junction26 prototype is a genuine two-sided HTTP system, not a mock-up: a supplier-side API
with its own guardrail, and a separate buyer agent with its own policy engine, talking over a
documented contract against the live challenge sandbox. What it is not is multi-tenant. There is
one supplier, two seeded buyers, both policy sets are constants in source code, and there was no
human user, organization, role or test anywhere in the repository.

This slice adds users, organizations, memberships, server-side RBAC, member invitations,
versioned tenant-owned policy records and a tenant-scoped audit log, all behind a feature flag
and all additive. **The new policy records are stored but not yet enforced**: the demo flow still
evaluates its built-in policies.

## Section 2 features

| # | Feature | Status | Evidence | Notes |
|---|---|---|---|---|
| 1 | Product discovery, 17,546 SKUs | working | `apps/aimo-api/src/routes/products.ts`, `src/catalog.ts`, `scripts/seed.ts` | Static facts seeded into Postgres from the three challenge files. Price and stock fetched live from `junction26.valioaimo.fi`, capped at 20 candidates per search. Keyword search is `LIKE` on the English name only. |
| 2 | Nemotron assistant | working, optional | `apps/buyer-demo/lib/llm.ts`, `llmCatalog.ts`, `llmExplain.ts` | Search interpretation, seasonal themes, dish-to-basket, narration. Falls back to keyword search when no key is set or the model times out. Output is never used as a decision input. |
| 3 | Buyer-owned policy evaluation | demo-only | `apps/buyer-demo/lib/policyEngine.ts` | Real deterministic checks (allergens, budget, delivery date, reliability, carbon, recipe composition). The policy is the constant `HOTEL_ESPOO_POLICY`; nobody can edit it. Now covered by 19 unit tests. |
| 4 | Supplier-owned policy evaluation | demo-only | `apps/aimo-api/src/guardrail.ts`, `buyers` table | Credit limit and auto-approval ceiling only. Thresholds are invented demo rows written by the seed script. |
| 5 | Quote, buyer policy, supplier policy, order | working (sandbox) | `src/routes/quotes.ts`, `src/routes/orders.ts`, `lib/scenarios.ts` | Quotes expire after 10 minutes and are single-use. An "order" is a row in this service's own database. Nothing is submitted to any supplier system; the upstream sandbox has no order endpoint. |
| 6 | Human review and approval | partial | `POST /v1/orders/:id/approve` | Ownership is enforced (wrong side gets 403). The approving side is **self-declared in the request body**, see Risks. No inbox, assignment, deadline or notification. |
| 7 | Registered substitutes | working | `src/alternatives.ts`, `evaluateSubstitutes` | Supplier ranks by its own attributes and discloses facts; buyer accepts, sends to review, or rejects. Unknown reliability is review, never auto-selected. |
| 8 | Audit trail | partial | `src/audit.ts`, `audit_events` | Per-order events with reasons and a policy version label. The label is a constant string, not a reference to a stored version. No actor identity beyond a role name. |
| 9 | Find Products / Plan an Order UI | working | `apps/buyer-demo/app/page.tsx` | Single 2,270-line client page. Pack-size and dilution warnings exist (`dilutionMultiplier`, `match_status` in `llmCatalog.ts`). |
| 10 | Scenario demonstrations | working | `lib/scenarios.ts`, `npm run demo` | Five scenarios, runnable from the UI and the CLI. They need the live sandbox and a seeded database. |

## What this slice added

| Capability | Status | Where |
|---|---|---|
| Sandbox / production boundary | working | `apps/aimo-api/src/config.ts`. `AIMO_ENV=production` refuses to start. Every response carries `x-aimo-environment: sandbox`. |
| Versioned migrations | working | `apps/aimo-api/migrations/`, `src/migrations.ts`, `schema_migrations` table |
| Automated tests and CI | working | 54 API tests, 19 policy-engine tests, `.github/workflows/ci.yml` |
| Correlation ids | working | `x-correlation-id` accepted or generated, returned, and stored on audit rows |
| User accounts and sessions | working, sandbox-grade | `src/platform/passwords.ts`, `sessions.ts`, `routes/platformAuth.ts` |
| Organizations (buyer or supplier) | working | `routes/organizations.ts` |
| Memberships and seven roles | working | `packages/shared` permission matrix, `src/platform/authz.ts` |
| Member invitations (join an organization) | working, no email delivery | `routes/organizations.ts` |
| Tenant-owned versioned policy | working as a record, **not enforced** | `routes/policies.ts`, `policy_versions` |
| Tenant-scoped audit log | working | `org_audit_events`, written in the same statement as each change |
| Buyer and supplier onboarding screens | working, basic | `apps/buyer-demo/app/workspace/` |
| Trading relationships | schema only | `trading_relationships` table, no routes |

## Single-tenant assumptions still in the demo path

- The supplier is a constant. `ApprovalOwner` is `"buyer" | "aimo"`, the trust envelope issuer is
  the literal `"Valio Aimo"`, and there is no supplier id on products, quotes or orders.
- A buyer is an `X-API-Key` mapped to a `buyer_id` in the `AIMO_BUYER_API_KEYS` environment
  variable. Demo buyers are not organizations and have no users.
- The web app holds one buyer's API key in server environment variables, so every visitor to the
  public demo acts as the same buyer.
- Both policy engines read constants. The new `policy_versions` rows are not consulted.

## Risks and gaps found

1. **Self-declared approver (authorization gap).** `POST /v1/orders/:id/approve` takes
   `actor: "human:buyer" | "human:aimo"` from the body. Any holder of a buyer API key can claim to
   be the supplier's approver and clear a supplier hold. The demo relies on this to show both
   sides from one UI, so it is left in place and pinned by a test. It must be replaced by
   authenticated, role-checked approvals before any real use. This is the first thing the
   approvals work in Phase 2 has to fix.
2. **Public demo can write.** The deployed web app lets anonymous visitors create quotes and
   orders in the sandbox database as the demo buyer. Harmless today because orders go nowhere;
   it must not carry over to a real connector.
3. **Quote consumption is not atomic.** The order route reads the quote, inserts the order, then
   marks the quote consumed in separate requests. Two concurrent submissions can both succeed.
   There are no idempotency keys.
4. **Quantity wording in scenario 1.** The scenario quotes 1,000 sales units of product 464073
   and describes that as "1,000 L". Nothing in the code verifies that one sales unit is one
   litre (`salesUnit` is treated as opaque). The copy is unchanged in this slice; it should be
   corrected or backed by pack data.
5. **Seed is destructive.** `npm run seed` truncates `products` and `buyers` with `CASCADE`,
   which also deletes all quotes and orders. It does not touch the new platform tables.
6. **Dependency advisories.** `npm audit` reports 5 advisories (4 high, 1 critical), including
   several against Fastify 4. The fix is a major-version upgrade and has not been attempted.
7. **Delivery reliability has no sample size.** The dataset gives one ratio per SKU. The UI
   already says so; keep it that way.

## Limits of the new platform code

Stated plainly so nobody mistakes this for production-ready:

- **Authentication is a stopgap.** Email and password with scrypt hashes and opaque sessions. No
  email verification, password reset, MFA, or session listing. Signup reveals whether an email is
  registered. The failed-login throttle is in memory, per instance. See ARCHITECTURE.md for why
  it was built this way and how it is meant to be replaced.
- **Invitations are not emailed.** The inviter receives a one-time token to pass on.
- **Append-only is application-level.** Database rules turn `UPDATE` and `DELETE` on
  `policy_versions` and `org_audit_events` into no-ops. A database owner can remove the rules.
  Nothing is signed or hash-chained.
- **No row-level security.** Tenant isolation is enforced in the API layer by one gate
  (`authorizeOrg`) and tested through the API. The database itself would return any row.
- **No transactions.** The Neon HTTP driver runs one statement per request. Atomic changes are
  written as single statements with data-modifying CTEs. Migrations must be idempotent.
- **Profiles are JSON.** Locations and approval contacts live in `organizations.profile`. They
  move to their own tables when quotes need to reference a delivery location.
- **Not run against Neon.** Migration `002` was applied and tested on an in-process Postgres
  (PGlite) only. It has not been run against the hosted database.
- **OpenAPI not updated.** `apps/aimo-api/openapi.yaml` still describes only the demo routes.

## Verification performed

- `npm run typecheck` and `npm test` pass (73 tests).
- Isolation tests were checked for teeth: removing the membership filter fails 11 tests,
  removing the permission check fails 3.
- The workspace was driven end to end through the Next.js session proxy against a local API on
  an in-memory database: signup, create buyer and supplier organizations, save a policy, invite
  and accept, cross-tenant reads and writes refused, cross-origin write refused, logout.
- With the flag off, `/workspace` returns 404 and the demo page renders unchanged.
- The five live scenarios (`npm run demo`) were **not** re-run: they need the hosted database
  and the Junction26 sandbox key. The demo route files are unchanged apart from lazy loading of
  the API-key table in `src/auth.ts`.
