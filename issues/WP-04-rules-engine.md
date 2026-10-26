---
{
  "title": "WP-04: Rules engine: processing matrices, yield, pricing, QR codec",
  "wave": 1,
  "labels": [
    "area:rules",
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
`packages/rules`: pure, dependency-free TypeScript implementing `docs/04-BUSINESS-RULES.md`
§1–§3 and the QR codec in `docs/02-DOMAIN-MODEL.md §13`, driven by
`docs/seed/processing-rules.json`.

## Read first
`docs/04-BUSINESS-RULES.md`, `docs/02-DOMAIN-MODEL.md §13`, `docs/seed/processing-rules.json`.

## Deliverables
- `species.ts`, `conditions.ts`, `methods.ts` typed from the seed JSON.
- `allowedConditions(speciesCode)`, `allowedMethods(speciesCode, conditionCode)`.
- `yieldFactor({species, condition, method, skinOff})` with chum→reds and
  exchange→smoking fallbacks and skin-off multipliers.
- `expandLines(intakeLines)` → charge drafts (fresh → fillets + portions; ribbing lines).
- `pricePerLb({method, listPrice, fastPassRate, lodgeCap, isLodgeGuest, fastPass})`
  implementing the single rule; `repriceEligible(charge, intake)`.
- `qr.ts`: `encode(...)`, `parse(raw)` for TOTE/TAG/LOC/BOX/SBOX + legacy bare forms;
  `normalizeTagCode('42') === '042'`.
- `states.ts`: transition tables mirrored from `03-STATE-MACHINES.md`, plus a script
  `gen:states` that writes `supabase/seed/state_transitions.sql` (committed; WP-03
  loads it) so DB and TS cannot drift; CI fails if the generated file is stale.
- 100% branch coverage on pricing and yield; property tests for `qr` round-trip.

## Acceptance
- `pnpm --filter rules test` green with coverage report; no runtime deps.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
