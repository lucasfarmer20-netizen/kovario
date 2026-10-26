---
{
  "title": "WP-13: Freezer locations master, blast and locate stations, pick-list order",
  "wave": 2,
  "labels": [
    "area:ui",
    "area:db",
    "wave:2",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-05",
    "blocked-by:WP-08",
    "blocked-by:WP-12"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-08",
    "WP-12"
  ]
}
---
## Goal
Location master + generator, `/freezer/blast`, `/freezer/locate`, placement history,
walk-path sort, location QR tags, archive guard — `docs/04-BUSINESS-RULES.md §7`,
`docs/02-DOMAIN-MODEL.md §7`, `docs/10-LESSONS-FROM-CSP.md §1` (phantom locations).

## Read first
`docs/02-DOMAIN-MODEL.md`, `docs/04-BUSINESS-RULES.md`, `docs/10-LESSONS-FROM-CSP.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Generator UI/CLI: zone, rows, per-row bays, per-row levels, depths (F/R) → idempotent
  upsert; pallet/quarantine creation; archive/unarchive; tag sheet print job.
- `place_vessel(vessel_raw, location_raw, client_action_id)` rejecting archived/unknown
  locations; appends `location_placement`; first placement moves intake → `stored`.
- Blast queue screen; locate two-step loop screen.
- `location.sort_key` = row → bay → level → F before R; a view
  `vessel_walk_order(session_id)` for the boxing pick list.
- Tests: generator idempotent; archived location rejected; pallet code never grid-shaped;
  sort order sample.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-13.md` note explaining how to verify by hand (hardware only).
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
