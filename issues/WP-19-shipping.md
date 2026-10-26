---
{
  "title": "WP-19: Shippo shipping: verify, rates, labels, tracking, shipping queue",
  "wave": 3,
  "labels": [
    "area:integrations",
    "wave:3",
    "work-package",
    "blocked-by:WP-14",
    "blocked-by:WP-08"
  ],
  "blocked_by": [
    "WP-14",
    "WP-08"
  ]
}
---
## Goal
`packages/shipping` + `/shipping` per `docs/07-INTEGRATIONS.md §4` and the I13/I13b/I14
hold rules in `docs/10-LESSONS-FROM-CSP.md`.

## Read first
`docs/07-INTEGRATIONS.md`, `docs/10-LESSONS-FROM-CSP.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Address validate, rate shop with allowlist + Rate Check bypass, thin-result retry,
  buy label per parcel (fetch every label), label print job, tracking webhook.
- Shipment hold logic: held vs blocked reported together; manager Buy Now; reprint
  always allowed.
- Walk-in shipments and freight quote stubs; shipping queue screen with filters.
- Tests with recorded Shippo fixtures.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-19.md` note explaining how to verify by hand (hardware only).
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
