---
{
  "title": "WP-07: Sport intake station: lines, pricing, charges, lock, receipts",
  "wave": 2,
  "labels": [
    "area:ui",
    "area:rules",
    "wave:2",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-05",
    "blocked-by:WP-06"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-06"
  ]
}
---
## Goal
The intake station per `docs/06-STATIONS-UX.md` (Intake) and rules
`docs/04-BUSINESS-RULES.md §1–§3`, producing intake + lines + charges + tote tag rows
and queuing print jobs (print transport is WP-08; here, jobs are just rows).

## Read first
`docs/06-STATIONS-UX.md`, `docs/04-BUSINESS-RULES.md`, `docs/02-DOMAIN-MODEL.md §4`,
`docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- `/intake` form: customer search, species lines with matrix-filtered dropdowns,
  fillets %, skin off, lb, notes, tote count, dirty fish, Fast Pass, live price panel.
- `save_intake(payload, client_action_id)` SQL function: assigns `INT-` number, snapshots
  rate card + lodge flag, writes lines with yield snapshot, creates charges via the
  rules engine output, creates `tote_tag` rows, sets `locked`, state → `holding`,
  queues `print_job(tote_tag)` + optional receipt job.
- Post-save header: Reprint, Print Receipt, New Intake, manager Unlock (manager PIN;
  unlock writes `action_log`; re-save re-creates charges only for open ones).
- Reprice: `reprice_customer_open_charges(customer_id)` applying the single rule to
  open, unpaid, non-Fast-Pass processing charges (ribbing excluded); triggered by the
  WP-06 event.
- Intake list + detail view with timeline of timestamps; "hours in cooler" badge.
- Tests: save creates expected charges for a salmon fresh 60/40 line + a ribbed halibut
  line (two fillets/portions charges + portions + ribbing); Fast Pass floor and lodge
  cap cases; unlock/re-save idempotency.

## Acceptance
- Walkthrough in `docs/wp/WP-07.md`; tests green; a saved intake is read-only until
  unlocked.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
