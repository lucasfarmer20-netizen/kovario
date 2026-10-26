---
{
  "title": "WP-17: Dejavoo SPIn REST v2 adapter + fake SPIn server",
  "wave": 3,
  "labels": [
    "area:payments",
    "wave:3",
    "work-package",
    "blocked-by:WP-16"
  ],
  "blocked_by": [
    "WP-16"
  ]
}
---
## Goal
`dejavoo_spin` provider per `docs/05-PAYMENTS.md §4` with every listed behaviour, plus
the scriptable fake SPIn server for tests.

## Read first
`docs/05-PAYMENTS.md`, `docs/ops/dejavoo-terminal-provisioning.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Adapter: payload builder (numeric Amount, omit RegisterId, PrintReceipt No, timeout),
  sync POST with buffer, 4xx-JSON parse, StatusCode classification table (verbatim),
  HostResponseCode decline override, card-meta merge, reverse/refund, status reconcile,
  scrub function.
- Terminal config UI fields: endpoint host, TPN, register id (optional), timeout,
  secret ref.
- Fake SPIn server + the full case list in `05-PAYMENTS.md §6`.
- Ops doc `docs/ops/dejavoo-terminal-provisioning.md` from §4 notes.

## Acceptance
- All §6 cases green; a manual live test checklist (tiny amount + void) documented.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
