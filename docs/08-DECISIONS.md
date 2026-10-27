# Filletry — Decisions (ADR log)

Decided items are binding. Items tagged **DECISION NEEDED** are assumptions Lucas has
not confirmed; agents build on the stated default and must not silently change it.
Lucas: edit the line, commit, and reference the ADR in the PR that applies it.

| # | Decision | Status |
|---|---|---|
| DECISION-01 | Greenfield Next.js + Supabase standalone; no Odoo code or integration. CSP Odoo suite is reference only. | **Decided** 2026-10-25 |
| DECISION-02 | Payments are a provider interface. **Dejavoo SPIn is built first** (CSP runs on it); Stripe Terminal second; `manual` always available. Per-terminal provider selection. | **Decided** 2026-10-25 |
| DECISION-03 | Multi-tenant single database with RLS by `org_id`; per-org sequences; no schema-per-tenant. | **Decided** 2026-10-25 |
| DECISION-04 | **Offline:** v1 is online-required with an IndexedDB scan queue + idempotent actions. PowerSync is a post-v1 work package behind the same data layer. | **DECISION NEEDED** — default as stated. Memory says PowerSync was in the stack; it is deferred, not dropped. |
| DECISION-05 | Stripe Terminal tenants supply their own Stripe API keys (no Stripe Connect in v1). | **DECISION NEEDED** — default: own keys. |
| DECISION-06 | Subscription tiers: five, $79–$899. Names, limits and feature gates unspecified. | **DECISION NEEDED** — default placeholder tiers `starter 79 / plant 199 / plant-plus 349 / multi-site 599 / enterprise 899`; gates: station count, sites, users, SMS. |
| DECISION-07 | Tax computed at the register with optional per-transaction cap (`tax.cap_amount`). | **DECISION NEEDED** — default: compute, exclusive, cap supported. |
| DECISION-08 | SMS notifications deferred; email via Resend in v1. | **DECISION NEEDED** — default: email only. |
| DECISION-09 | Orchestration: Agent Orchestrator desktop app (`ao.project.json`), GitHub Issues as the unit of work, one PR per work package, CI as the merge gate; `scripts/review-loop.sh` reviews as a second GitHub identity (without admin or bypass rights) and then merges approved non-critical PRs itself: auto-merge while CI is pending, a direct squash merge once the PR is clean; branch protection (required `check` + 1 approval) gates both (AO itself never merges). When it requests changes, or posts findings on an `area:critical` PR, it messages the owning AO session (`ao send`), because AO does not forward GitHub reviews to workers. Workers run with `bypass-permissions` inside isolated worktrees; `main` is branch-protected. | **Decided** 2026-10-26 |
| DECISION-10 | Framework versions: Next.js latest stable App Router (pinned 16.4.3 in WP-01; 15.x was current at kickoff), React 19, TypeScript 5.x strict, Tailwind 4, Node 22+ (raised from 20 in WP-02: supabase-js needs Node's built-in WebSocket), pnpm 9+. Agents pin exact versions in WP-01 and do not upgrade majors mid-build. | **Decided** 2026-10-25 |
| DECISION-11 | Weight unit is lb in v1 (org setting reserved). Currency USD. | **Decided** 2026-10-25 |
| DECISION-12 | Production-mode / split-intake (CSP deferred design) is **not** in v1. Schema reserves `intake.split_from_id`. | **Decided** 2026-10-25 |
| DECISION-13 | Receipts rendered by Filletry from stored payment data; terminal receipts suppressed. | **Decided** (carried from CSP) |
| DECISION-14 | No freezer capacity gating anywhere. Capacity is display-only. | **Decided** (carried from CSP) |
| DECISION-15 | Location master is generated from the racking actually built; generator is idempotent; archived locations cannot be bound. | **Decided** (carried from CSP) |
| DECISION-16 | Domain name / app host: `app.filletry.com` (Lucas owns `filletry.com` and `filletery.com`, which redirect to it). The product is being renamed from Kovario to Filletry because `kovario.com` was not available; marketing site out of scope for this repo. | **Decided** 2026-10-26 |
| DECISION-17 | Testing: no mandatory e2e per PR beyond smoke; rules engine and payments adapters require unit coverage; release + storage invariants have dedicated integration tests against local Supabase. | **Decided** 2026-10-25 |
| DECISION-18 | Long-running payment calls run in Next.js Node route handlers with `maxDuration = 300` (Fluid Compute). Vercel **Hobby** for the proof of concept: its Fluid Compute maximum is 300 s, enough for the ~150 s terminal wait (Supabase Edge Functions cap at 150 s on the free plan, too tight). Move to Pro before commercial use: Hobby is non-commercial only, and Pro allows 800 s. | **Decided** 2026-10-26 (PoC) |
| DECISION-19 | Fast Pass floors **processing** charges only. Ribbing is never floored or capped: it is always `ribbing_per_lb × lb`, on Fast Pass intakes too. | **Decided** 2026-10-26 |
| DECISION-20 | Intake transitions follow `03-STATE-MACHINES.md`: scanning a `holding` tote at rollstock is a bypass `holding → processing` (audited), not a direct `holding → rollstock`. | **Decided** 2026-10-26 |
| DECISION-21 | A manager may add an existing account to their org without that user's consent (`admin_add_member`). | **Decided** 2026-10-26 |
| DECISION-22 | Revoking a role or deactivating a device takes effect at the next token refresh (up to 1 hour); no forced session revocation in v1. | **Decided** 2026-10-26 |
| DECISION-24 | Register paid hook records payment_event (paid_hook) + domain_event (register_order_paid); release_audit is reserved for fish movement. | **Decided** 2026-10-27 (Lucas) |
