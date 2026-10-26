---
{
  "title": "WP-03: Core domain schema migrations",
  "wave": 1,
  "labels": [
    "area:db",
    "wave:1",
    "work-package",
    "blocked-by:WP-02",
    "blocked-by:WP-04"
  ],
  "blocked_by": [
    "WP-02",
    "WP-04"
  ]
}
---
## Goal
Create every domain table in `docs/02-DOMAIN-MODEL.md` §2–§11 with constraints, enums,
indexes, RLS, `updated_at` triggers, and the transition-guard trigger from
`docs/03-STATE-MACHINES.md`.

## Read first
`docs/02-DOMAIN-MODEL.md`, `docs/03-STATE-MACHINES.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- One migration per domain area (`customers`, `reference`, `intake`, `storage`,
  `floor`, `locations`, `allocation`, `payments`, `printing`). Each calls
  `enable_org_rls`.
- Enums exactly as named in the doc. `check` constraints listed in the doc.
- Trigger-maintained denormals: `intake.total_incoming_lb`, `total_est_yield_lb`,
  `ribbing`; `storage_intake.box_count/active_box_count`; `charge.amount`;
  `vessel.location_id` mirror from `location_placement`.
- Views: `storage_box_days` (days_stored), `reconcile_variance`,
  `allocation_session_fulfillment`.
- `state_transition_guard()` trigger reading a `state_transitions(entity, from_state,
  to_state)` table seeded from **`supabase/seed/state_transitions.sql`, which WP-04
  generates from `packages/rules/src/states.ts`** (`pnpm --filter rules gen:states`);
  WP-03 only consumes that file; `force_transition(entity, id,
  to_state, reason)` for managers writing `action_log`.
- `packages/db` types regenerated and committed.
- Migration tests: apply from empty; insert a minimal intake with lines and assert the
  denormals; attempt an illegal transition and assert rejection.

## Acceptance
- `supabase db reset` applies cleanly; tests pass; no table without RLS (a test asserts
  this by querying `pg_policies`).

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
