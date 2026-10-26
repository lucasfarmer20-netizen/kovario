# Kovario

Multi-tenant SaaS for sport-caught-fish processors: intake → processing stations →
freezers → allocation → boxing → payment → pickup/ship. Standalone Next.js + Supabase.
The Custom Seafoods Odoo suite is the reference implementation, not a dependency.

**Start here:** `docs/00-PRD.md` → `docs/01-ARCHITECTURE.md` → `docs/09-WORK-PACKAGES.md`.
Agents: `AGENTS.md`.

## Quickstart (local dev)

Prerequisites: Node 22+, pnpm 9+, Docker (running), and the Supabase CLI **2.122.0**
(the version CI pins; `npx supabase@2.122.0 …` works if you don't want a global install).

```bash
git clone https://github.com/lucasfarmer20-netizen/kovario.git && cd kovario
pnpm install
cp .env.example .env              # names only; fill local values from `supabase status`
supabase start                    # local Postgres/Auth/Realtime in Docker (first run pulls images)
supabase db reset                 # applies supabase/migrations/* + supabase/seed.sql
pnpm dev                          # http://localhost:3000 — /healthz returns {"ok":true}
```

`supabase status` prints the local API URL and anon / service-role keys for `.env`.
`supabase stop` shuts the stack down.

| Script | What it does |
|---|---|
| `pnpm dev` | Next.js dev server (`apps/web`) |
| `pnpm build` | Builds every package that has a `build` script |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | ESLint + Prettier check |
| `pnpm test` | Unit tests (vitest) in every package; `*.db.test.ts` excluded |
| `pnpm test:db` | `supabase test db` (SQL tests in `supabase/tests/`) + vitest `*.db.test.ts` suites; needs `supabase start` |
| `pnpm db:types` | Regenerates `packages/db/src/types.ts` from the local DB |
| `pnpm e2e` | Playwright smoke in `apps/web` (no-op until WP-23 adds it) |

## Kickoff checklist (Lucas)

1. Create the GitHub repo (private), push this bundle to `main`.
2. Clone to a local folder; `ao.project.json` holds the AO project config (applied by `scripts/ao-setup.ps1`).
3. Add a second GitHub account (e.g. CustomSeafoods) as a collaborator with Write;
   from that account mint a classic PAT with `repo` scope — that is `REVIEWER_PAT`
   (keep it in your shell, never in the repo). Branch protection on `main`: require
   `check` + 1 approval; turn on Allow auto-merge.
4. Skim `docs/08-DECISIONS.md`; edit any `DECISION NEEDED` default you disagree with.
5. `gh auth login`, install the Agent Orchestrator desktop app, then in the repo:
   ```powershell
   ao start                      # wait for `ao status` to show the daemon running
   pwsh scripts/ao-setup.ps1     # registers the project from ao.project.json
   ./scripts/seed-issues.sh      # creates labels + issues #1–#24
   ./scripts/run-wave.sh 0
   $env:REVIEWER_PAT="ghp_..."; ./scripts/review-loop.sh   # second terminal (Git Bash/WSL)
   ```
   shows sessions; `area:critical` PRs (WP-15 release, WP-16 payments) wait for you.

## Layout
```
apps/web            Next.js app: stations, admin, register, public status page
packages/rules      pure TS rules engine (matrices, yield, pricing, QR codec, states)
packages/payments   provider interface + manual / dejavoo_spin / stripe_terminal
packages/labels     ZPL + PDF templates
packages/db         generated Supabase types + typed helpers
packages/shipping   Shippo client
agent/print-agent   LAN service: printers (ZPL over TCP 9100) + scale
supabase/           migrations, seed, edge functions, SQL tests
docs/               the spec (this bundle)
issues/             work-package issue bodies (seeded to GitHub by scripts/seed-issues.sh)
```
