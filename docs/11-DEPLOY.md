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
  with `--no-seed` and runs `supabase/tests/08_reference_data.test.sql`; add a table there when
  a migration introduces new platform reference data. Per-org reference data (species, rate
  cards) is created by onboarding (`public.create_org` / `seed_org_reference` with
  `packages/rules` `referenceSeed()`), not by migrations or seed.
- Secrets are referenced by **name** only: in workflows, `.env.example`, this runbook. Never
  paste a value into an issue, PR, commit or log.
- The Supabase CLI is pinned to **2.122.0** in `ci.yml`, `deploy.yml` and `package.json`;
  bump all three together.

## 1. One-time setup (human)

### Supabase

1. **Staging** project exists (`kovario-staging`, region `us-west-1`). For **prod**, create a
   second project in the same organisation and region, Postgres 17 (`supabase/config.toml`
   `major_version`). Keep its database password in a password manager.
2. Access tokens (Account → Access Tokens). Use a scoped token per environment, created as
   **Project** access to that one project only. These are the permissions the staging deploy
   was verified with on 2026-10-27 (labels as in the dashboard form; everything else None):

   | Group | Permission | Level | Used by |
   |---|---|---|---|
   | Project | Project Settings | Read-write | `config push` |
   | Database | Migrations | Read-write | migration history; `db push` itself needs no token scope when the pooler host is set (kept because it was in the verified set) |
   | Database | Database config | Read-write | `config push` (DB settings) |
   | Database | Database pooling config | Read | `db push` pooler lookup when `SUPABASE_*_POOLER_HOST` is unset |
   | Application services | Edge Functions | Read-write | `functions deploy` |
   | Application services | Auth Config | Read-write | `config push` (access-token hook, auth URLs) |
   | Application services | Data API Config | Read-write | `config push` |
   | Application services | Storage Config | Read-write | `config push` (not "Storage", which is buckets/objects) |
   | Application services | Realtime Config | Read-write | `config push` |
   | Infrastructure and delivery | Add-ons | Read | `config push` checks add-ons first (`infra_add_ons_read`) |

   The deploy script never runs `supabase link` (every command takes `--project-ref`), so no
   API-key scopes are needed. A missing scope fails the step with
   `Missing required permission(s): <scope>`; a 402 means a paid-plan feature is enabled in
   `supabase/config.toml` (vector buckets are off for this reason); *IPv6 is not supported* from
   `db push` means the session-pooler host is unset (`SUPABASE_*_POOLER_HOST`, below) and the
   token lacks Database pooling config Read. GitHub runners are IPv4-only and free-plan direct
   database hosts are IPv6-only, so `db push` must go through the pooler.
   - **prod** token, the same scopes on the prod project only.

### GitHub (`Settings → Secrets and variables → Actions`, `Settings → Environments`)

| Name | Kind | Where | Value |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | repository | staging-scoped token |
| `SUPABASE_STAGING_PROJECT_REF` | secret | repository | staging project ref |
| `SUPABASE_STAGING_DB_PASSWORD` | secret | repository | staging database password |
| `STAGING_SITE_URL` | variable | repository | staging auth site URL, e.g. the staging web URL. **Unset ⇒ auth config is not pushed.** Set it only once the token has the `config push` scopes (below): otherwise every staging deploy applies migrations and functions, then fails at `config push`, and the commit can't be promoted. During the PoC it is `https://app.filletry.com`, because Vercel Production points at staging too |
| `STAGING_REDIRECT_URLS` | variable | repository | optional, comma-separated, e.g. `https://filletry-*-<team-slug>.vercel.app/**` for previews |
| `SUPABASE_ACCESS_TOKEN` | secret | environment `production` | prod-scoped token (overrides the repository one in the prod job) |
| `SUPABASE_PROD_PROJECT_REF` | secret | environment `production` | prod project ref |
| `SUPABASE_PROD_DB_PASSWORD` | secret | environment `production` | prod database password |
| `PROD_REDIRECT_URLS` | variable | repository | optional extra prod redirect URLs (`https://app.filletry.com/**` is always added) |
| `SUPABASE_STAGING_POOLER_HOST` | variable | repository | optional; defaults to `aws-0-us-west-1.pooler.supabase.com` (staging's Supavisor session pooler, Dashboard → Connect → Session pooler) |
| `SUPABASE_PROD_POOLER_HOST` | variable | repository | prod's session-pooler host; unset ⇒ the token needs `database_pooling_config_read` |

`db push` uses `postgresql://postgres.<ref>@<pooler host>:5432/postgres` with the password in
`PGPASSWORD`, so the password never appears in a URL, argument or log.

**Edge Function secrets** are per Supabase project and are not deployed from the repo. Set them
once per environment with `supabase secrets set --project-ref <ref> NAME=…` (or Dashboard →
Edge Functions → Secrets): `STRIPE_SECRET_KEY` (billing-checkout, billing-portal) and
`STRIPE_WEBHOOK_SECRET` (billing-webhook) — Stripe test-mode keys on staging, live keys on
prod. `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are injected by
Supabase.

Create the **`production` environment** with: *Required reviewers* (at least one human),
*Prevent self-review* on, *Allow administrators to bypass configured protection rules*
**unticked** (otherwise a repository admin can deploy prod without an approval), and
*Deployment branches and tags* = **Selected branches and tags** with a single branch rule
`main`. `promote-check` refuses to promote while any of these three is missing (reviewers,
bypass off, `main`-only), and skips prod while the environment does not exist. Do not create protection rules on `staging`; the staging
job must run unattended.

The staging secrets are repository secrets because the PR migration dry-run (below) must read
them without creating a deployment. The prod ones are environment secrets so only the approved
prod job can read them.

**Trust assumption — accept it knowingly.** `migrations-dry-run` runs on `pull_request`, i.e.
the PR's *own* workflow and script, with `SUPABASE_STAGING_DB_PASSWORD` and the token. Anyone
who can push a branch to this repository — including the autonomous agent branches — can
therefore run arbitrary SQL against **staging** (which holds the CSP trial tenant) before
review. Forks get no secrets. Prod is unaffected: its secrets exist only in the `production`
environment. If that is not acceptable, give the dry-run a read-only database role (it only
reads `supabase_migrations.schema_migrations`) in a separate secret, or drop the PR dry-run and
rely on the deploy itself.

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
| `SUPABASE_SERVICE_ROLE_KEY` | **leave unset**: previews run unreviewed PR code against staging (CSP trial tenant); add it only when a `docs/05-PAYMENTS.md` handler must run in preview, and say so in that PR | prod, only for the handlers listed in `docs/05-PAYMENTS.md` and `docs/07-INTEGRATIONS.md` §4 |
| `NEXT_PUBLIC_APP_URL` | leave unset (request origin is used) | `https://app.filletry.com` |

  Until the prod project exists both targets point at staging (proof of concept). When prod
  exists, change only the **Production** values, and **in the same step** set the GitHub
  variable `STAGING_SITE_URL` to the staging web URL (not `app.filletry.com`). Otherwise staging's
  confirmation and reset links keep landing on the prod app.

## 2. How a deploy flows

1. **PR**: CI job `check` runs lint, unit tests, the no-seed reference-data test, a seeded
   reset with `pnpm test:db`, and the build. Job `migrations-dry-run` runs
   `scripts/deploy-supabase.sh staging --dry-run` (`supabase db push --dry-run` against
   staging): a migration that cannot apply on top of staging's history (timestamp older than
   staging's latest, or a version that exists only remotely) fails before merge. Skipped when
   the staging secrets are absent (forks). It checks history, not SQL: a migration that errors
   on staging *data* fails at deploy time — see §3.

   **Parallel branches:** when `migrations-dry-run` reports a local migration older than staging's
   latest (someone else's migration merged first), rename yours to a current timestamp
   (`supabase/migrations/<now>_<slug>.sql`) after merging `main`, re-run `supabase db reset`, and
   push. Never pass `--include-all` to work around it: that applies migrations out of order on
   staging and prod.
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

   **Hosted auth policy** (the same `[remotes.<env>]` block; `config.toml` stays tuned for local
   dev). Set in `scripts/deploy-supabase.sh`; change it there, in a PR:

   | Setting | Local (`config.toml`) | Hosted (staging, prod) | Why |
   |---|---|---|---|
   | `auth.enable_signup`, `auth.email.enable_signup` | true | true | tenants self-serve through `/signup` (WP-22) |
   | `auth.email.enable_confirmations` | false | **true** | an address must be proven before it owns an org (see the known gap below) |
   | `auth.minimum_password_length` | 6 | **8** | matches the `/signup` form |
   | `auth.password_requirements` | none | **`letters_digits`** | `/signup` maps `weak_password`; device passwords are 64 hex chars |
   | `auth.email.secure_password_change` | false | **true** | password change needs a recent login |
   | `auth.email.double_confirm_changes` | true | true | |
   | `auth.email.max_frequency` | 1s | **60s** | resend throttle |

   Devices (`email_confirm: true`) and invited members are unaffected by confirmations.
   Confirmation mail goes through Supabase's built-in SMTP, which only delivers to the
   project's team members and is rate-limited: fine for staging; **prod needs custom SMTP**
   (Resend, `docs/07-INTEGRATIONS.md`) configured in the dashboard before real tenants sign up.

   **Known gap (#57):** the confirmation link redirects to `/onboarding?code=…` (PKCE), but no
   route in `apps/web` exchanges the code for a session yet, so a newly confirmed user lands on
   `/login` and has to sign in once before onboarding. A `/auth/callback` route fixes it.

   **Email rate limit:** `config push` sends `auth.rate_limit.email_sent` only when
   `[auth.email.smtp]` is enabled in `config.toml` (CLI 2.122.0 `pkg/config/auth.go`); it is not,
   so the hosted value stays whatever the dashboard says. When custom SMTP is set up on prod,
   raise *Authentication → Rate Limits → emails per hour* there: confirmations, member invites
   and password resets share it. The other `[auth.rate_limit]` values in `config.toml` are pushed
   and match Supabase's defaults.
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

1. Pick a commit on `main` with a **green Deploy run** (Actions → Deploy, or the `staging`
   environment's deployment list). Not every `main` commit has one: GitHub replaces a still
   *pending* CI run with a newer push, so when merges land in quick succession only the latest
   commit is deployed to staging, and only deployed commits can be promoted.
2. Actions → **Deploy** → *Run workflow* on `main`, input `sha` = that commit.
3. `promote-check` refuses a commit without a successful staging deployment and skips while the
   `production` environment does not exist. It also refuses an environment that is not set up
   as in §1: no required reviewers, administrators allowed to bypass, or deployment branches
   not limited to `main`. Those environment rules are the real gate, because
   `workflow_dispatch` runs the dispatching branch's copy of `deploy.yml`.
4. A required reviewer approves the `production` deployment. The job then runs the same
   script against prod (checked out at that commit). Without the prod secrets it skips with a
   notice.

## 5. Preview demo org

Vercel previews use staging with a throwaway org `preview-demo`. Create or refresh it (idempotent:
upserts the org and sites `Main`/`Lodge`; adds the processing reference data and default rate
card through `seed_org_reference`, exactly as onboarding does, keeping existing rows; then the
owner and membership, resetting the owner's password):

```bash
STAGING_SUPABASE_URL=… SUPABASE_STAGING_PROJECT_REF=… STAGING_SUPABASE_SERVICE_ROLE_KEY=… \
FILLETRY_PREVIEW_DEMO_PASSWORD=… pnpm db:preview-demo
```

The script refuses any URL that is not `https://<SUPABASE_STAGING_PROJECT_REF>.supabase.co`
(or a loopback URL for a local rehearsal), so it cannot write to prod by mistake. Run it
from a trusted machine only; the service-role key never goes into CI or the repo. For the local
`demo-plant` org (intakes in every state for the e2e smoke) use `pnpm db:seed-demo` instead.
