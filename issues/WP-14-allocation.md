---
{
  "title": "WP-14: Counter allocation: sessions, anglers, settlements, box plans",
  "wave": 3,
  "labels": [
    "area:ui",
    "area:rules",
    "wave:3",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-07",
    "blocked-by:WP-12"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-07",
    "WP-12"
  ]
}
---
## Goal
`/allocate` per `docs/04-BUSINESS-RULES.md §8` and `docs/06-STATIONS-UX.md`
(Counter allocation). Pricing of settlements; no release here (WP-15).

## Read first
`docs/04-BUSINESS-RULES.md`, `docs/06-STATIONS-UX.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Session create from one or more intakes (m2m); anglers; split method weight/even;
  per-angler species lb; box plans with size catalogue (`/admin/box-sizes`), method,
  weight, heavy check; `price_session()` computing processing share from the pooled
  intakes' processing charges proportional/even, box fees, freight placeholder;
  settlement receipts with boxing QR (print job).
- Fulfillment rollup view; session list with filters.
- Tests: weight vs even split sums exactly to pooled charges (penny-rounding rule
  documented); intake pooled in two sessions is allowed; box plan has no vessel FK.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-14.md` note explaining how to verify by hand (hardware only).
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
