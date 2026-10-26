---
{
  "title": "WP-02: Tenancy, auth, roles, devices and RLS foundation",
  "wave": 1,
  "labels": [
    "area:db",
    "area:security",
    "wave:1",
    "work-package",
    "blocked-by:WP-01"
  ],
  "blocked_by": [
    "WP-01"
  ]
}
---
## Goal
Multi-tenant foundation: orgs, members with roles and PINs, devices with station
sessions, per-org sequences, RLS on every table, JWT `org_id` claim.

## Read first
`docs/01-ARCHITECTURE.md §3, §5, §7`, `docs/02-DOMAIN-MODEL.md §1, §11`.

## Deliverables
- Migrations: `org`, `org_member` (with `is_default` for multi-org users), `site`,
  `device`, `sequence_counter` (+ prefix table per `01-ARCHITECTURE.md §3`),
  `action_log`, `domain_event`; `app.org_id()` and `app.role()` helpers in schema
  `app`; Supabase Auth hook (custom access token hook) stamping `org_id` and
  `app_role` claims — Postgres roles stay `anon`/`authenticated`;
  RLS policies + a reusable `enable_org_rls('table')` SQL function used by every later
  migration.
- `next_seq(org_id, kind)` (row-locked counter; returns formatted `INT-0001` style via a
  per-kind prefix table).
- Device pairing: manager generates a pairing code (QR) → the device exchanges it for a
  session of a per-device `auth.users` row (`device-<id>@devices.kovario.internal`,
  `app_role = station`) stored on the device; operator PIN check function;
  manager PIN elevation that mints a short-lived token (Edge Function).
- `packages/db`: typed client factories (`serverClient`, `deviceClient`), `withAction(
  client_action_id, fn)` idempotency helper backed by `action_log`.
- pgTAP or vitest-against-local-Supabase tests proving: a member of org A cannot read
  org B rows on every table that exists so far; `next_seq` has no duplicates under
  10 concurrent calls; replaying an action id returns the stored result.
- Admin pages: `/admin/users` (invite, role, PIN set), `/admin/devices` (pair, list,
  last seen), `/admin/sites`.

## Acceptance
- Isolation tests pass. Device pairing demo works end to end in `pnpm dev`.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
