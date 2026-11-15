# Roadmap

Where the work stands against the phases in PROJECT.md, and the next tasks in the order they
should be done. Each task is sized to be one reviewable change.

## Position

| Phase | State |
|---|---|
| 0. Audit and foundations | Done, with the operational items below still open |
| 1. Multi-tenant onboarding | Items 1 to 3 done. Items 4, 5, 7 and 8 partly done. Item 6 (connections) not started. |
| 2. Supplier data and safe purchasing | Not started |
| 3. Daily buyer experience | Prototype exists in the demo, not on tenant data |
| 4. Agent-to-agent platform | Not started |

## Before enabling the flag on the hosted deployment

These need a decision or access that a code change cannot supply.

1. **Run migration 002 against Neon.** It is additive and idempotent, but it has only been run
   on an in-process Postgres. Run it on a Neon branch first, then on the main database.
2. **Choose the auth provider.** Either adopt a managed provider now (recommended: Neon Auth, as
   it sits on the same database) or accept the built-in stopgap for an internal preview only.
   Do not invite real pilot users onto the stopgap.
3. **Decide where the workspace is exposed.** The public demo and the workspace share one web
   deployment. Consider a separate deployment or hostname for the workspace.

## Next tasks: invitations and trading relationships

Smallest first. Tasks 1 to 4 complete Phase 1's exit criteria.

1. **Trading relationship API.** `POST /v1/trading-relationships` where a supplier invites a
   buyer organization (by an invitation token, as for members), plus accept, reject and revoke.
   Each transition is allowed only to the side that owns it. The table already exists.
   Tests: a buyer cannot accept on the supplier's behalf; a third organization sees nothing.
2. **Supplier-owned per-buyer terms.** Account reference, credit limit and auto-approval ceiling
   on the relationship, versioned like policy. Only the supplier reads or writes them. The buyer
   sees that a relationship exists, not its commercial terms.
3. **Partners screen and dashboards.** Buyer sees connected suppliers; supplier sees connected
   buyers and pending requests.
4. **Email delivery for invitations.** Needs a provider choice. Until then tokens are passed by
   hand.
5. **Normalize locations.** Move delivery and fulfilment locations out of the profile JSON into
   tables, once a quote has to reference one.

## Then: put tenant policy in charge of a decision

This is the step that turns stored policy into the product's promise.

6. **Shared policy evaluation module.** Move the pure checks from
   `apps/buyer-demo/lib/policyEngine.ts` into a package that takes rules as input, returning the
   `pass | manual_review | reject | error` vocabulary with reason codes. The demo keeps passing
   its constant; the 19 existing tests guard the move.
7. **Policy decision records.** A `policy_decisions` table that stores side, organization,
   policy version id, inputs reference, result and reason codes. This replaces the constant
   `policy_version` strings in `audit_events`.
8. **Authenticated approvals.** Replace the self-declared `actor` on
   `POST /v1/orders/:id/approve` with a session and a role check (`buyer_approver` or
   `supplier_approver` in the owning organization). Closes the authorization gap recorded in
   IMPLEMENTATION_STATUS.md. The demo's two-sided approval then needs demo users on each side.

## Phase 2 entry

9. Supplier connector interface, with the Junction26 sandbox as the first adapter and a CSV
   connector second.
10. Supplier id on products, quotes and orders; remove the `"aimo"` constant from the contract.
11. Atomic, idempotent order submission (idempotency key, single-statement quote consumption).
    Likely the point to move from the Neon HTTP driver to one with transactions.
12. Trade state machine as explicit, tested transitions.

## Open operational items from Phase 0

- Upgrade Fastify to a supported major and clear the `npm audit` advisories.
- Error reporting service (logs are structured, nothing aggregates them yet).
- Row-level security as a second layer under the API gate.
- Rate limiting at the edge; the login throttle is in memory.
- Backups and restore test, data retention and GDPR assessment before any real onboarding.
- Describe the platform routes in `openapi.yaml`.
- Correct the "1,000 L" wording in scenario 1, or back it with verified pack data.

## Not planned yet

Payments, negotiation, a public marketplace, and SAP or Coupa integrations are out of scope
until the pilot shows demand, as PROJECT.md states.
