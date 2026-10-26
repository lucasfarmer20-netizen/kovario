---
{
  "title": "WP-24: (post-v1) Offline-first stations with PowerSync",
  "wave": 5,
  "labels": [
    "area:infra",
    "post-v1",
    "wave:5",
    "work-package",
    "blocked-by:WP-23"
  ],
  "blocked_by": [
    "WP-23"
  ]
}
---
## Goal
Deferred per DECISION-04. Evaluate PowerSync against the existing data-access layer:
sync rules for station tables, conflict policy for scan actions (server wins; queued
actions replay), and a spike report. Do not merge product code until Lucas confirms
DECISION-04.

## Read first
`docs/02-DOMAIN-MODEL.md`, `docs/06-STATIONS-UX.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-24.md` note explaining how to verify by hand (hardware only).
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
