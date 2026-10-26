---
{
  "title": "WP-23: End-to-end smoke suite over the demo tenant",
  "wave": 4,
  "labels": [
    "area:test",
    "wave:4",
    "work-package",
    "blocked-by:WP-07",
    "blocked-by:WP-09",
    "blocked-by:WP-10",
    "blocked-by:WP-11",
    "blocked-by:WP-12",
    "blocked-by:WP-13",
    "blocked-by:WP-15",
    "blocked-by:WP-16",
    "blocked-by:WP-20",
    "blocked-by:WP-22"
  ],
  "blocked_by": [
    "WP-07",
    "WP-09",
    "WP-10",
    "WP-11",
    "WP-12",
    "WP-13",
    "WP-15",
    "WP-16",
    "WP-20",
    "WP-22"
  ]
}
---
## Goal
Playwright suite driving one intake from intake → tote scan at wave → rollstock →
reconcile → blast → locate → allocation → boxing release → register (manual
provider) → status page shows "Picked up"; plus one storage intake → batch → payment →
release. Runs in CI against local Supabase with the demo seed.

## Read first
`docs/02-DOMAIN-MODEL.md`, `docs/06-STATIONS-UX.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- `apps/web/e2e/*.spec.ts`; CI job; scanner emulation helper (types QR text + Enter).

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-23.md` note explaining how to verify by hand (hardware only).
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
