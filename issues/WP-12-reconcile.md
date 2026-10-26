---
{
  "title": "WP-12: Reconcile station: asset tags, vessels, scale, variance",
  "wave": 2,
  "labels": [
    "area:ui",
    "area:integrations",
    "wave:2",
    "work-package",
    "blocked-by:WP-03",
    "blocked-by:WP-04",
    "blocked-by:WP-05",
    "blocked-by:WP-07",
    "blocked-by:WP-08"
  ],
  "blocked_by": [
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-07",
    "WP-08"
  ]
}
---
## Goal
`/reconcile` per `docs/04-BUSINESS-RULES.md §6`, `docs/06-STATIONS-UX.md` (Reconcile),
plus the scale path in `docs/07-INTEGRATIONS.md §1`.

## Read first
`docs/04-BUSINESS-RULES.md`, `docs/06-STATIONS-UX.md`, `docs/07-INTEGRATIONS.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Asset tag pool: `/admin/asset-tags` (create range, retire/reactivate, print sheet);
  `bind_tag(code, vessel)` with normalisation and exclusivity errors naming the holder.
- Vessel rows added by tag scan — the scan itself binds the tag (`available → in_use`)
  and inserts the vessel as `occupied`; removing the row before send frees the tag;
  exchange-vessel rows (untagged); weight from latest
  stable `scale_reading` for the device's scale (Realtime) with Accept, or manual entry
  flagged; variance view.
- `send_to_blast(intake_id)`: validates every vessel (weight > 0; tag unless exchange),
  intake → `blast_freezer`.
- Print agent scale module (Toledo 8217 parser with unit tests on captured frames).
- Tests: tag padding variants resolve to one tag; `in_use` tag rejected with holder;
  unknown tag rejected; exchange vessel allowed without tag; send-to-blast gate.

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-12.md` note explaining how to verify by hand (hardware only).
- All tests listed above are green in CI; no `DECISION NEEDED` default was changed silently.
- A reviewer can trace each deliverable to files in the PR via the PR template table.

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
