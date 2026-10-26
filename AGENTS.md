# AGENTS.md — Kovario

You are one of several coding agents building Kovario in parallel, each on one GitHub
issue, in your own git worktree, delivering one PR. Humans are mostly not watching.
This file is the contract. `CLAUDE.md` and `.agent-rules.md` point here.

## What you are building
Kovario: multi-tenant SaaS for sport-caught-fish processors. Read `docs/00-PRD.md` first,
then the docs your issue lists. The docs are the spec. The issue is the task. If they
conflict, the doc wins and you say so in the PR.

## Stack and layout (fixed — do not change)
Next.js App Router + TypeScript strict + Tailwind/shadcn · Supabase Postgres with RLS ·
pnpm workspace: `apps/web`, `packages/{rules,payments,labels,db,shipping}`,
`agent/print-agent`, `supabase/`. See `docs/01-ARCHITECTURE.md`. Pin versions in
`package.json`; never bump a major mid-build.

## Hard rules
1. **Tenancy.** Every table has `org_id` + RLS (`enable_org_rls`). No service-role use
   in `apps/web` except in route handlers explicitly listed in `docs/05-PAYMENTS.md`
   and the print-agent token flow.
2. **Occupancy** of a vessel comes from `vessel.lifecycle_state` only. Never infer from
   `asset_tag_id`.
3. **Idempotency.** Mutations take a `client_action_id` and go through `withAction` /
   `action_log`. Multi-row money or release writes are single SQL functions with the
   lock order session → vessels → intakes (sorted ids); storage-batch paths lock the
   **intake row first** (S5). Never lock across round trips.
4. **QR text** is produced and parsed only by `packages/rules/src/qr.ts`.
5. **Secrets** never in code, fixtures, tests, logs or PR text. Reference by name
   (`secret_ref`, env var). Scrub functions are centralised per adapter.
6. **Wet-glove rule** for floor stations: scan-driven, one focused `<ScanInput>`, no
   modal focus traps, tap targets ≥ 56 px.
7. **No capacity gating** on freezer locations. Archived locations cannot be bound.
8. **Rules engine** (`packages/rules`) is pure TS with no runtime deps; the DB and the
   UI never re-implement a rule.
9. **Decisions** live in `docs/08-DECISIONS.md`. Build the stated default for any
   `DECISION NEEDED`; never silently pick a different one.
10. **Scope.** Do exactly the issue. Stub unmerged dependencies behind the documented
    interface; note it in the PR. Don't refactor neighbours.

## Workflow
- Branch `feat/<issue>-<slug>` from `main`. Conventional commits (`feat:`, `fix:`,
  `test:`, `docs:`, `chore:`), reference `#<issue>`.
- Open the PR with the **same labels as the issue** (`gh pr create --label …` for each
  `area:*`, `wave:*` label) and `Closes #<issue>` in the body; CI and the reviewer
  read those labels.
- Before pushing: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm build`;
  for DB work also `supabase db reset` locally.
- Migrations: `supabase/migrations/<timestamp>_<slug>.sql`, idempotent where practical,
  one concern per file, every new table calls `enable_org_rls`. Regenerate
  `packages/db/src/types.ts` in the same PR.
- Tests live next to code (`*.test.ts`) or in `supabase/tests/` for SQL. Acceptance
  items in the issue map to tests; name them after the invariant (`I10`, `S4`, `P18`).
- PR description: what, how to verify, which docs/invariants it satisfies (table),
  anything stubbed, any decision default relied on. Use `.github/pull_request_template.md`.
- If CI fails on your PR you will get the logs back — fix forward, don't force-push
  over review history.
- If you are truly blocked (missing credential, ambiguous spec with no default), stop,
  write `BLOCKED:` + reason as a PR/issue comment, and leave the branch pushed.

## Commands
```bash
pnpm install
supabase start && supabase db reset        # local DB with migrations + seed
pnpm dev                                    # apps/web on :3000
pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm build
pnpm db:types                               # regenerate packages/db types
```

## Review agents
A local reviewer loop (`scripts/review-loop.sh`, Claude Code headless) plus AO's in-app review check each PR against the issue's acceptance list and the invariant
tables in `docs/10-LESSONS-FROM-CSP.md` using `scripts/review-prompt.md`. For
`area:critical` PRs a human merges.

## Don'ts
No Odoo concepts (SO/MO/stock.move), no ORM-style generic admin, no vendor SDK imports
outside `packages/payments`/`packages/shipping`/edge functions, no `any`, no skipped
tests, no TODOs without an issue number, no console.log in app code (use the logger).
