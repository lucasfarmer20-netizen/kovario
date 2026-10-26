---
{
  "title": "WP-15: Boxing / will-call release with invariants I1\u2013I17, Release-by-Tag",
  "wave": 3,
  "labels": [
    "area:ui",
    "area:db",
    "area:critical",
    "wave:3",
    "work-package",
    "blocked-by:WP-13",
    "blocked-by:WP-14"
  ],
  "blocked_by": [
    "WP-13",
    "WP-14"
  ]
}
---
## Goal
The release half: boxing wizard, `release_party()` SQL function, close gate I10, audit
log, restore, Release-by-Tag — exactly per `docs/10-LESSONS-FROM-CSP.md §2` and the
P1–P24 matrix as tests.

## Read first
`docs/10-LESSONS-FROM-CSP.md` (all), `docs/03-STATE-MACHINES.md` (vessel, box, intake),
`docs/06-STATIONS-UX.md` (Boxing).

## Deliverables
- `release_party(session_id, box_ticks[], vessel_ticks[{vessel_id, lbs_left}],
  payment_ref, client_action_id)`: lock session → vessels → intakes (sorted), re-read,
  preflight (I16 a/b), apply box finalisation (I2/I3), vessel full-pull/split (I5/I6),
  I8 block, audit rows (I9), tag freeing, location clearing, `try_close_after_release`
  (I10), no-op on empty (I7).
- `release_by_tag(tag_code, lbs_left, reason)` manager tool (warn-not-block).
- `restore_vessel(vessel_id)` append-only restore.
- Boxing screen with ticks, Lbs Left, notes panel, pick list in walk order, Complete.
- Integration tests: one test per P1–P24 against local Supabase, including the
  concurrency case (two transactions).
- A repo-sweep test (`occupancy-sweep.test.ts`) that greps SQL and TS for
  `asset_tag_id is [not ]null` / `asset_tag_id ==` used as an occupancy predicate and
  fails on any hit outside an allowlist (tag identity/reuse code).

## Acceptance
- P1–P24 green. A reviewer agent must check the code against I1–I17 line by line and
  write the mapping in the PR description.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
