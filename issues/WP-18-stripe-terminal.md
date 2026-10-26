---
{
  "title": "WP-18: Stripe Terminal adapter (server-driven)",
  "wave": 3,
  "labels": [
    "area:payments",
    "wave:3",
    "work-package",
    "blocked-by:WP-16"
  ],
  "blocked_by": [
    "WP-16"
  ]
}
---
## Goal
`stripe_terminal` provider per `docs/05-PAYMENTS.md §5`, with Stripe mock tests.

## Read first
`docs/05-PAYMENTS.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- PaymentIntent create → `readers.processPaymentIntent` → poll → outcome mapping;
  cancel_action for abort; refunds for reverse; card meta mapping; connection token
  endpoint; webhook endpoint reconciling `indeterminate` only.
- Terminal config UI: reader id, location, secret ref (restricted key).
- Tests for all §6 cases using `stripe-mock` or recorded fixtures.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-18.md` note explaining how to verify by hand (hardware only).
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
