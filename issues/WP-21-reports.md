---
{
  "title": "WP-21: Reports and dashboards",
  "wave": 3,
  "labels": [
    "area:ui",
    "wave:3",
    "work-package",
    "blocked-by:WP-07",
    "blocked-by:WP-12",
    "blocked-by:WP-16"
  ],
  "blocked_by": [
    "WP-07",
    "WP-12",
    "WP-16"
  ]
}
---
## Goal
`/reports`: daily volume (lb in by species), pipeline (counts/lb per state), throughput
(station timestamps → hours between stages), revenue (settled charges by kind/day),
reconcile variance by species. SQL views + simple charts.

## Read first
`docs/02-DOMAIN-MODEL.md`, `docs/06-STATIONS-UX.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Views in a migration; pages with date range + site filters; CSV export.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-21.md` note explaining how to verify by hand (hardware only).
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
