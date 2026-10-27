# Filletry — Work Packages & Orchestration Plan

Each work package (WP) is one GitHub Issue → one Agent Orchestrator session → one PR.
Issue bodies live in `issues/WP-NN-*.md` and are the agent's prompt; they point at the
docs rather than restating them. `scripts/seed-issues.sh` creates labels, milestones and
issues; `scripts/run-wave.sh N` spawns a wave.

## Waves (dependency order)

| Wave | WPs | Parallel? |
|---|---|---|
| 0 | WP-01 scaffold | single |
| 1 | WP-02 tenancy/RLS · WP-04 rules engine · WP-03 schema · WP-05 station shell | 02 and 04 in parallel; 03 after both; 05 after 03 |
| 2 | WP-06 customers · WP-07 intake · WP-08 print agent + labels · WP-09 storage · WP-10 wave · WP-11 rollstock · WP-12 reconcile · WP-13 freezers | 06, 08 first; 07 after 06; 09–13 after 07/08 (see blocked-by labels) |
| 3 | WP-14 allocation · WP-15 release · WP-16 payments core + register · WP-17 Dejavoo · WP-18 Stripe Terminal · WP-19 shipping · WP-20 status page + email · WP-21 reports · WP-22 onboarding + billing · WP-25 environments + deploy | 14 and 16 first; 15 after 14; 17/18 after 16; 25 needs only 01–03 (human merges: area:critical); others parallel |
| 4 | WP-23 e2e smoke | after everything |
| 5 | WP-24 PowerSync (post-v1, gated on DECISION-04) | — |

`blocked-by:WP-xx` labels are the dependency graph. `run-wave.sh` only spawns issues
whose blockers are closed (PR merged), so you can re-run it as waves drain.

## Agent assignment (defaults in `ao.project.json`)

| Agent | Used for |
|---|---|
| `claude-code` (default) | Schema, SQL functions, invariants, payments, anything "critical" |
| `codex` | `area:ui` / `area:labels` packages that carry no `area:db`, `area:rules`, `area:payments` or `area:critical` label (05, 10, 11, 12, 20, 21, 08) — `scripts/run-wave.sh` applies this rule |
| Antigravity | **Not an AO agent.** Use it interactively for design review of station screens and for the two `area:critical` PRs' second review before merge. |

Per-issue override: `ao spawn --project filletry --kind worker --name WP-NN --issue <n> --harness codex --mode tui`.

## Merge gates (hands-off mode)

1. CI green (typecheck, lint, unit, migrations apply, SQL tests, build; e2e smoke once WP-23 lands).
2. Reviewer pass: `scripts/review-loop.sh` runs on your machine next to `ao` and
   drives Claude Code headless (`claude -p`, on your Max/Pro subscription — no API
   key) over every open PR with `scripts/review-prompt.md`. It approves or requests
   changes as the **reviewer account** (`REVIEWER_PAT`, a second GitHub identity such
   as CustomSeafoods, because GitHub ignores self-approval). AO's `changes-requested`
   reaction feeds the findings back to the authoring agent.
3. After approving a non-critical PR the loop arms `gh pr merge --auto --squash`, so
   GitHub merges when CI is green. `area:critical` (WP-15, WP-16) get comments only
   and wait for Lucas. AO's built-in lifecycle rules send CI failures, review comments
   and merge conflicts back to the worker session automatically (no config needed);
   AO's `autoReview` adds a second, in-app review pass but never merges.

## Running it

```bash
# once (AO is a desktop app now; the old agent-orchestrator.yaml is retired)
gh auth login                       # as the authoring account (lucasfarmer20-netizen)
ao start                            # opens the desktop app + daemon; wait for `ao status` = running
pwsh scripts/ao-setup.ps1           # or scripts/ao-setup.sh — registers the project from ao.project.json
./scripts/seed-issues.sh            # labels + milestones + 24 issues → issues/map.json

# then, per wave
./scripts/run-wave.sh 0             # WP-01
REVIEWER_PAT=ghp_... ./scripts/review-loop.sh   # second terminal: reviews, approves, arms auto-merge
./scripts/run-wave.sh 1             # spawns unblocked wave-1 issues; re-run as blockers merge
```

No API keys and no repo secrets are needed for v1: builders and the reviewer run on
your local Claude Code / Codex logins, and CI uses fakes for payments and shipping.
`REVIEWER_PAT` lives only in your shell (or a `.env.reviewer` you source), never in the
repo. Branch protection on
`main`: require the `CI / check` status and 1 approving review. Enable GitHub secret
scanning + push protection on the repo (that is the secret scan; CI has none).

## Definition of done (every WP)
- Acceptance list in the issue met; tests in the PR; `docs/wp/WP-NN.md` notes how to
  verify by hand where a test can't cover hardware.
- No `DECISION NEEDED` item silently resolved — if the WP depends on one, build the
  default and say so in the PR.
