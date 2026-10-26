---
{
  "title": "WP-25: Environments and deploy: staging/prod Supabase, migrations on merge, Vercel",
  "wave": 3,
  "labels": [
    "area:infra",
    "area:critical",
    "wave:3",
    "work-package",
    "blocked-by:WP-01",
    "blocked-by:WP-02",
    "blocked-by:WP-03"
  ],
  "blocked_by": ["WP-01", "WP-02", "WP-03"]
}
---
## Goal
Make the environments in `docs/01-ARCHITECTURE.md §8` real: `preview`, `staging` and
`prod` get the schema, functions and config from `main` by automation, never by hand,
so every environment matches what CI tested.

## Read first
`docs/01-ARCHITECTURE.md` (§1, §8), `docs/08-DECISIONS.md` (DECISION-16, DECISION-18),
`AGENTS.md`, `.github/workflows/ci.yml`, `supabase/config.toml`.

## Deliverables
- **Reference data lives in migrations.** Audit `supabase/seed*` and move any row the app
  needs to run (e.g. state transitions, enum-like lookup rows) into idempotent migrations
  (`insert … on conflict do update`). Hosted deploys never run seed files; `seed.sql`
  stays demo-only. Add a test that fails if a required reference table is empty after
  `supabase db reset` with seeding disabled.
- **Deploy workflow** `.github/workflows/deploy.yml`:
  - on push to `main`: `supabase db push` to **staging**, `supabase functions deploy`,
    `supabase config push` (auth hook and auth settings from `config.toml`);
  - **prod** via `workflow_dispatch` only, behind a GitHub `production` environment with
    required reviewers; same steps, pinned to a commit already deployed to staging;
  - Supabase CLI pinned to the version CI uses; secrets referenced by name only
    (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_STAGING_PROJECT_REF`, `SUPABASE_STAGING_DB_PASSWORD`,
    `SUPABASE_PROD_PROJECT_REF`, `SUPABASE_PROD_DB_PASSWORD`), listed in `.env.example`
    and the runbook.
- **Migration safety in CI:** a PR job that runs `supabase db push --dry-run` against
  staging (skipped when the secrets are absent, e.g. forks) so a migration that can't
  apply on top of the real staging history fails before merge.
- **Vercel:** `vercel.json`/project settings documented so previews point at staging
  and prod at prod; env var names for each environment; `app.kovario.com` per
  DECISION-16 (the DNS change itself is a human step).
- **Preview demo org:** an idempotent script that creates/refreshes the throwaway demo
  org on staging for preview deployments.
- **Runbook** `docs/11-DEPLOY.md`: one-time human setup (create the two Supabase
  projects, Vercel project, GitHub environments and secrets), how a deploy flows, how
  to roll back a bad migration (forward-fix), and how to promote to prod.

## Acceptance
- With the secrets set, merging to `main` deploys to staging with no manual step, and
  the staging database has every migration and the required reference data.
- Prod deploy cannot run without an approval on the `production` environment.
- No secret values in the repo, workflow logs or PR text.
- If the Supabase/Vercel projects or secrets don't exist yet, build and dry-run
  everything that doesn't need them, then comment `BLOCKED:` with the exact one-time
  setup steps from the runbook rather than guessing values.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
