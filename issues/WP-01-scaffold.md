---
{
  "title": "WP-01: Repo scaffold: monorepo, Next.js app, Supabase, CI green",
  "wave": 0,
  "labels": [
    "area:infra",
    "wave:0",
    "work-package"
  ],
  "blocked_by": []
}
---
## Goal
Stand up the monorepo exactly as `docs/01-ARCHITECTURE.md §1` lays it out, with a
Next.js app that boots, a local Supabase that starts, and CI that runs typecheck, lint,
unit tests, migration apply and build on every PR.

## Read first
`docs/01-ARCHITECTURE.md`, `docs/08-DECISIONS.md` (DECISION-10), `AGENTS.md`.

## Deliverables
- `pnpm` workspace: `apps/web`, `packages/{rules,payments,labels,db,shipping}`,
  `agent/print-agent`, `supabase/`. **Package names are the folder basenames** (`web`,
  `rules`, `payments`, `labels`, `db`, `shipping`, `print-agent`) so `pnpm --filter web`
  works. Each package has `tsconfig` extending a root strict config, `vitest` wired
  with `passWithNoTests: true`, a `test` script = `vitest run`, an `index.ts`.
- Root `package.json` scripts, exactly these names (CI calls them): `dev`, `build`,
  `typecheck` (`pnpm -r typecheck`), `lint` (eslint + prettier check), `test`
  (`pnpm -r --if-present test`), `test:db` (runs `supabase test db` when
  `supabase/tests/*.sql` exist and vitest `*.db.test.ts` suites; exits 0 when none),
  `db:types` (`supabase gen types typescript --local > packages/db/src/types.ts`),
  `e2e` (`pnpm --filter web e2e`, which is `playwright test`; Playwright itself is
  added by WP-23 — until then the root script must still exist and exit 0).
- `apps/web`: Next.js App Router (pin latest stable), React 19, Tailwind, shadcn/ui
  initialised, a `/healthz` route, PWA manifest + service worker shell (no offline
  logic yet).
- `supabase/`: `config.toml`, a first migration creating schema `app` (our helpers live
  there, never in `auth`), empty `supabase/tests/`, `seed.sql` placeholder, `supabase
  start` documented in README. `pnpm db:types` writes `packages/db/src/types.ts`.
- `.github/workflows/ci.yml` (already drafted in repo) made green as written. Pin the
  Supabase CLI version in `supabase/setup-cli` to the one you generated types with.
- `.env.example` with every variable name the docs mention; no values.
- `README.md` quickstart that works from a clean clone in < 10 minutes.

## Acceptance
- CI green on the PR. `pnpm dev` serves `/healthz` → `{ok:true}`.
- `pnpm -r test` runs (zero tests is fine) and `pnpm -r typecheck` passes.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
