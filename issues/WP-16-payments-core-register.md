---
{
  "title": "WP-16: Payments core: provider interface, manual adapter, register, paid hooks, receipts",
  "wave": 3,
  "labels": [
    "area:payments",
    "area:critical",
    "wave:3",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-09",
    "blocked-by:WP-14"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-09",
    "WP-14"
  ]
}
---
## Goal
`packages/payments` interface + `manual` adapter, the `/register` screen, payment
records/events, and `apply_paid_register_order()` with the locking protocol —
`docs/05-PAYMENTS.md §1–§3`, `docs/04-BUSINESS-RULES.md §11–§12`.

## Read first
`docs/04-BUSINESS-RULES.md`, `docs/05-PAYMENTS.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Interface + `manual` provider + fake provider for tests; `/api/payments/*` route
  handlers resolving terminal config and Vault secret server-side.
- Register: customer search, Load outstanding (server-computed; replaces cart lines),
  retail lines (minimal catalogue `/admin/retail-products`), tax per org setting with
  cap, Charge flow UI states (present card / cancel / declined / indeterminate /
  error), receipt print from stored payment data.
- `apply_paid_register_order(order_id, payment_id)`: settle charges, settlements →
  paid, `release_pickup_batch` per batch (S8 savepoints, S6 release_failed), audit +
  payment_event rows; runs on insert-as-paid and transition.
- Manager void/refund with reason → provider `reverse`/`refund`; refunds never release.
- Tests: paid hook idempotency; partial approval; refund order does not release;
  indeterminate blocks retry until status resolves; cash path (insert-as-paid).

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-16.md` note explaining how to verify by hand (hardware only).
- All tests listed above are green in CI; no `DECISION NEEDED` default was changed silently.
- A reviewer can trace each deliverable to files in the PR via the PR template table.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
