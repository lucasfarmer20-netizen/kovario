# Kovario

Multi-tenant SaaS for sport-caught-fish processors: intake → processing stations →
freezers → allocation → boxing → payment → pickup/ship. Standalone Next.js + Supabase.
The Custom Seafoods Odoo suite is the reference implementation, not a dependency.

**Start here:** `docs/00-PRD.md` → `docs/01-ARCHITECTURE.md` → `docs/09-WORK-PACKAGES.md`.
Agents: `AGENTS.md`.

## Kickoff checklist (Lucas)

1. Create the GitHub repo (private), push this bundle to `main`.
2. Set `projects.kovario.repo` and `path` in `agent-orchestrator.yaml`.
3. Repo secrets: `ANTHROPIC_API_KEY`, `REVIEWER_PAT` (bot account with write access).
   Branch protection on `main`: require `CI / check` + 1 approval.
4. Skim `docs/08-DECISIONS.md`; edit any `DECISION NEEDED` default you disagree with.
5. `gh auth login`, `npm i -g @aoagents/ao`, then:
   ```bash
   export AO_CONFIG_PATH=$PWD/agent-orchestrator.yaml
   ./scripts/seed-issues.sh
   ao start
   ./scripts/run-wave.sh 0
   ```
6. When WP-01 merges, `./scripts/run-wave.sh 1`, and so on. The dashboard (`:3000`)
   shows sessions; `area:critical` PRs (WP-15 release, WP-16 payments) wait for you.

## Layout (created by WP-01)
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
