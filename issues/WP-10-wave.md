---
{
  "title": "WP-10: Wave batch station",
  "wave": 2,
  "labels": [
    "area:ui",
    "wave:2",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-05",
    "blocked-by:WP-07"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-07"
  ]
}
---
## Goal
`/wave` per `docs/04-BUSINESS-RULES.md §4` and `docs/06-STATIONS-UX.md` (Wave).

## Read first
`docs/04-BUSINESS-RULES.md`, `docs/06-STATIONS-UX.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Holding queue with FIFO fill helper toward target ± tolerance (suggestion only).
- Wave create → verifying → scan each tote (`wave_scan`, dedupe, per-scan feedback,
  errors: not in wave / already complete) → Complete moves intakes to `processing`,
  stamps `pulled_at`, wave `done`.
- `scan_wave_tote(wave_id, raw, client_action_id)` SQL function; `scan_log` rows.
- Tests: completeness gate; duplicate scan rejected; scan from another wave rejected.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-10.md` note explaining how to verify by hand (hardware only).
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
