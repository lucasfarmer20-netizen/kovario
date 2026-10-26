---
{
  "title": "WP-05: Station shell, scan input primitive, feedback, scan queue, operator PIN",
  "wave": 1,
  "labels": [
    "area:ui",
    "wave:1",
    "work-package",
    "blocked-by:WP-02",
    "blocked-by:WP-03"
  ],
  "blocked_by": [
    "WP-02",
    "WP-03"
  ]
}
---
## Goal
The shared floor-station chrome every scan station builds on
(`docs/06-STATIONS-UX.md` "Shared primitives").

## Read first
`docs/06-STATIONS-UX.md`, `docs/01-ARCHITECTURE.md §4, §5`, `docs/02-DOMAIN-MODEL.md`
(`scan_log`, `action_log`).

## Deliverables
- `<StationShell>`, `<ScanInput>` (keyboard-wedge capture, Enter submit, always
  re-focused, non-modal overlays), `<ScanFeedback>` (green/red flash, Web Audio beeps),
  `<QueueList>` with age badges and Realtime refresh hook, `<OperatorPinOverlay>`,
  `<ManagerPinOverlay>`.
- Scan queue: `useScanAction()` posts `{client_action_id, raw, station}` to a server
  action; on failure enqueues in IndexedDB (idb-keyval), retries with backoff, shows
  "N pending"; replays are idempotent via `withAction`.
- `scan_log` written for every scan (server side), including rejects with reason.
- Station theme tokens (large type, contrast) + Storybook or a `/dev/stations` gallery
  page showing each primitive.
- Unit tests for `ScanInput` parsing/debounce and the queue's retry/replay logic.

## Acceptance
- A demo station page accepts a pasted `KV:TOTE:INT-0001:1`, flashes green, writes a
  `scan_log` row; an unknown string flashes red and writes a rejected row; with the
  network throttled off, scans queue and replay on reconnect.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
