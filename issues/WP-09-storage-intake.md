---
{
  "title": "WP-09: Cold storage intake, boxes, labels, pickup batches",
  "wave": 2,
  "labels": [
    "area:ui",
    "area:db",
    "wave:2",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-05",
    "blocked-by:WP-06",
    "blocked-by:WP-08"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-06",
    "WP-08"
  ]
}
---
## Goal
Storage path per `docs/04-BUSINESS-RULES.md §10` and `docs/06-STATIONS-UX.md`
(Storage intake), including `storage_pickup_batch` creation with the S1–S12 invariants
(payment application itself is WP-16).

## Read first
`docs/10-LESSONS-FROM-CSP.md §3` (S1–S12), `docs/02-DOMAIN-MODEL.md §5`,
`docs/03-STATE-MACHINES.md`.

## Deliverables
- `/storage` form; `confirm_storage_intake()`; box labels + receipt print jobs.
- `storage_box_days(box)` single function; view + receipt + wizard all use it.
- Pickup wizard: select boxes → `create_pickup_batch()` snapshotting rate/days/amount,
  creating one `charge(kind=storage)` per batch, superseding any pending batch for the
  same boxes (`void`), locking the intake row first.
- `release_pickup_batch(batch_id, payment_ref, mode)` implementing S1, S5, S6, S7, S9 with
  per-batch savepoints; manager Force Release and COMP (reason required).
- Storage queue page with partial/released rollups.
- Integration tests against local Supabase for S1–S12 (table-driven).

## Acceptance
- S-invariant tests green; receipt shows identical day counts to the box view.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
