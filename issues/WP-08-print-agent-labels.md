---
{
  "title": "WP-08: Print agent + ZPL/PDF label and receipt templates",
  "wave": 2,
  "labels": [
    "area:integrations",
    "area:labels",
    "wave:2",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04"
  ]
}
---
## Goal
`agent/print-agent` and `packages/labels` per `docs/07-INTEGRATIONS.md §1–§2`.

## Read first
`docs/07-INTEGRATIONS.md`, `docs/02-DOMAIN-MODEL.md §10, §13`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Agent: pairing flow, Realtime subscription, job claim with `for update skip locked`,
  ZPL over TCP 9100, PDF print via OS, retries, heartbeat, file logging, single-binary
  build, service install snippets (systemd + Windows Task Scheduler), README with the
  Zebra ops gotchas (no driver; FEED+PAUSE hex-dump; 4×6 stock calibration).
- Labels: tote tag ZPL (100 pt intake number, QR, banners), storage box label, location
  tag (R top / F bottom), asset tag sheet, box label, pick list PDF; receipts (intake,
  pickup, settlement with boxing QR, storage) as HTML→PDF.
- Admin `/admin/printers`, `/admin/print-agents` with online/offline, test print.
- `print_job` enqueue helper used by WP-07/09/13/15.
- Round-trip tests: for each label kind, render → extract QR text → `qr.parse` equals
  the source ids. ZPL snapshot tests. A `scripts/zpl-preview` using Labelary API
  (optional, dev only).

## Acceptance
- A queued tote-tag job prints on a real ZD421 at 192.168.x.x:9100 (manual check
  documented) and the fake printer test (TCP listener) passes in CI.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
