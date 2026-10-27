# Filletry — Deploy runbook

Environments are defined in `docs/01-ARCHITECTURE.md §8`. Hosted environments get their
schema, Edge Functions and auth config **from `main` by automation, never by hand**, so every
environment matches what CI tested.

| Environment | Supabase project | Web (Vercel project `filletry`) | How it is updated |
|---|---|---|---|
| `local` | `supabase start` (per worktree) | `pnpm dev` | `supabase db reset` (migrations + demo seed) |
| `preview` | **staging** (demo org `preview-demo`) | Vercel preview per PR | UI only; database comes from staging |
| `staging` | `kovario-staging` | — | every push to `main` (`.github/workflows/deploy.yml`) |
| `prod` | prod project (not created yet) | `app.filletry.com` (DECISION-16) | `workflow_dispatch` + approval |

Rules:

- **Seed files are never run against a hosted project.** `supabase/seed.sql` is demo-only.
  Reference data the app needs (`app.sequence_prefix`, `app.state_transitions`,
  `app.state_entity`) ships in migrations as idempotent upserts. CI resets the local database
  with `--no-seed` and runs `supabase/tests/06_reference_data.test.sql`; add a table there when
  a migration introduces new platform reference data. Per-org reference data (species, rate
  cards) is created by onboarding, not by migrations or seed.
- Secrets are referenced by **name** only: in workflows, `.env.example`, this runbook. Never
  paste a value into an issue, PR, commit or log.
- The Supabase CLI is pinned to **2.122.0** in `ci.yml`, `deploy.yml` and `package.json`;
  bump all three together.

## 1. One-time setup (human)

### Supabase

1. **Staging** project exists (`kovario-staging`, region `us-west-1`). For **prod**, create a
   second project in the same organisation and region, Postgres 17 (`supabase/config.toml`
   `major_version`). Keep its database password in a password manager.
2. Access tokens (Account → Access Tokens). Use a scoped token per environment:
   - **staging** token, scoped to the staging project. The deploy script never runs
     `supabase link` (every command takes `--project-ref`), so no API-key scopes are needed.
     `db push` connects to Postgres directly and needs **no token scope** when the
     session-pooler host is given (`SUPABASE_*_POOLER_HOST`, below); without it the CLI looks
     the pooler up and needs `database_pooling_config_read` (otherwise it fails with
     *IPv6 is not supported*: runners are IPv4-only, free-plan direct hosts IPv6-only).
     `functions deploy`: Edge Functions read-write. **`config push` also needs** auth / database / data-API /
     storage / realtime config **read**, plus `auth_config_write` and `project_admin_write`
     (`supabase <command> --help` lists each command's scopes).
   - **prod** token, the same scopes on the prod project only.

### GitHub (`Settings → Secrets and variables → Actions`, `Settings → Environments`)

| Name | Kind | Where | Value |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | repository | staging-scoped token |
| `SUPABASE_STAGING_PROJECT_REF` | secret | repository | staging project ref |
| `SUPABASE_STAGING_DB_PASSWORD` | secret | repository | staging database password |
| `STAGING_SITE_URL` | variable | repository | staging auth site URL, e.g. the staging web URL. **Unset ⇒ auth config is not pushed** |
| `STAGING_REDIRECT_URLS` | variable | repository | optional, comma-separated, e.g. `https://filletry-*-<team-slug>.vercel.app/**` for previews |
| `SUPABASE_ACCESS_TOKEN` | secret | environment `production` | prod-scoped token (overrides the repository one in the prod job) |
| `SUPABASE_PROD_PROJECT_REF` | secret | environment `production` | prod project ref |
| `SUPABASE_PROD_DB_PASSWORD` | secret | environment `production` | prod database password |
| `PROD_REDIRECT_URLS` | variable | repository | optional extra prod redirect URLs (`https://app.filletry.com/**` is always added) |
| `SUPABASE_STAGING_POOLER_HOST` | variable | repository | optional; defaults to `aws-0-us-west-1.pooler.supabase.com` (staging's Supavisor session pooler, Dashboard → Connect → Session pooler) |
| `SUPABASE_PROD_POOLER_HOST` | variable | repository | prod's session-pooler host; unset ⇒ the token needs `database_pooling_config_read` |

`db push` uses `postgresql://postgres.<ref>@<pooler host>:5432/postgres` with the password in
`PGPASSWORD`, so the password never appears in a URL, argument or log.

Create the **`production` environment** with: *Required reviewers* (at least one human),
*Prevent self-review* on, and *Deployment branches* limited to `main`. The deploy workflow
refuses to promote while the environment exists without required reviewers, and skips prod
while the environment does not exist. Do not create protection rules on `staging`; the staging
job must run unattended.

The staging secrets are repository secrets because the PR migration dry-run (below) must read
them without creating a deployment. The prod ones are environment secrets so only the approved
prod job can read them.

### Vercel (project `filletry`)

- Root Directory `apps/web`, framework Next.js, Node 22.x. `apps/web/vercel.json` pins the
  framework and the function region `sfo1` (next to Supabase `us-west-1`; keep prod in the same
  region). Hobby plan per DECISION-18 until commercial use.
- Domains: `app.filletry.com` is the production domain; `filletry.com` and `filletery.com`
  redirect to it (DECISION-16). The DNS records are a human step at the registrar.
- Environment variables (names; values from each Supabase project's API settings):

| Variable | Preview | Production |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | staging URL | prod URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | staging anon key | prod anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | staging (only when a route handler in `docs/05-PAYMENTS.md` needs it) | prod, same rule |
| `NEXT_PUBLIC_APP_URL` | leave unset (request origin is used) | `https://app.filletry.com` |

  Until the prod project exists both targets point at staging (proof of concept). When prod
  exists, change only the **Production** values.

## 2. How a deploy flows

1. **PR**: CI job `check` runs lint, unit tests, the no-seed reference-data test, a seeded
   reset with `pnpm test:db`, and the build. Job `migrations-dry-run` runs
   `scripts/deploy-supabase.sh staging --dry-run` (`supabase db push --dry-run` against
   staging): a migration that cannot apply on top of staging's history (timestamp older than
   staging's latest, or a version that exists only remotely) fails before merge. Skipped when
   the staging secrets are absent (forks). It checks history, not SQL: a migration that errors
   on staging *data* fails at deploy time — see §3.
2. **Merge to `main`**: CI runs again; when `check` is green, job `deploy` calls
   `deploy.yml`, which deploys to the GitHub `staging` environment via
   `scripts/deploy-supabase.sh staging`:
   `supabase db push` (migrations only, never seed) →
   `supabase functions deploy --use-api --prune` (every function in `supabase/functions`,
   `verify_jwt` from `config.toml`; functions not in the repo are deleted) →
   `supabase config push` (auth hook, auth settings, API settings from `config.toml`, with the
   hosted `site_url` / redirect URLs added as a `[remotes.<env>]` block in a temp copy so the
   committed local values never reach a hosted project). A missing `STAGING_SITE_URL` skips
   this last step with a warning.
3. Runs on `main` are not cancelled by newer pushes; deploys are serialised per environment.

## 3. Rolling back a bad migration (forward-fix)

Migrations are never edited or deleted once on staging, and nothing is reverted by hand.

1. If the deploy failed mid-way, read the job log: `db push` applies pending migrations in
   order and stops at the failing one. `supabase migration list` (linked to the project) shows
   which versions are recorded as applied.
2. Write a **new** migration that fixes the problem (re-create the dropped column, correct the
   data, relax the constraint), with a timestamp after the last applied one. Test it locally
   with `supabase db reset` and against a copy of the bad state when data is involved.
3. Open a PR; `migrations-dry-run` shows exactly which versions will apply. Merge; staging
   redeploys. Promote to prod as usual (§4).
4. Edge Functions and config roll back by redeploying an earlier commit: merge a revert PR
   (normal path), or, for prod, promote the earlier, already-staged commit.

Emergency only: if a prod migration must be undone before a fix can ship, a human with the
prod password writes the down-SQL **as a migration file in a PR** first, then applies it via
the normal promotion. Never run `supabase migration repair` or ad-hoc SQL on prod without
recording it in a PR.

## 4. Promoting to prod

1. Pick a commit on `main` whose staging deploy succeeded (Actions → Deploy, or the
   `staging` environment's deployment list).
2. Actions → **Deploy** → *Run workflow* on `main`, input `sha` = that commit.
3. `promote-check` refuses a commit without a successful staging deployment, skips while the
   `production` environment does not exist, and refuses an environment without required
   reviewers.
4. A required reviewer approves the `production` deployment. The job then runs the same
   script against prod (checked out at that commit). Without the prod secrets it skips with a
   notice.

## 5. Preview demo org

Vercel previews use staging with a throwaway org `preview-demo`. Create or refresh it (idempotent:
upserts the org, sites `Main`/`Lodge`, the owner and membership; resets the owner's password):

```bash
STAGING_SUPABASE_URL=… STAGING_SUPABASE_SERVICE_ROLE_KEY=… \
FILLETRY_PREVIEW_DEMO_PASSWORD=… pnpm db:preview-demo
```

Set `SUPABASE_PROD_PROJECT_REF` in the same shell to make the script refuse the prod URL. Run it
from a trusted machine only; the service-role key never goes into CI or the repo. The org's
processing reference data comes from onboarding once that work package lands.
