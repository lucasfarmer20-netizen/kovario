---
{
  "title": "WP-22: Tenant onboarding, org settings, Stripe Billing subscriptions",
  "wave": 3,
  "labels": [
    "area:billing",
    "wave:3",
    "work-package",
    "blocked-by:WP-02",
    "blocked-by:WP-03",
    "blocked-by:WP-04"
  ],
  "blocked_by": [
    "WP-02",
    "WP-03",
    "WP-04"
  ]
}
---
## Goal
Self-serve org creation, settings UI (`docs/02-DOMAIN-MODEL.md §12`), reference-data
seeding from `docs/seed/processing-rules.json`, rate cards, and Stripe Billing per
`docs/07-INTEGRATIONS.md §5` / DECISION-06.

## Read first
`docs/02-DOMAIN-MODEL.md`, `docs/07-INTEGRATIONS.md`, `docs/10-LESSONS-FROM-CSP.md §1`.

## Deliverables
- Signup → create org → seed species/conditions/methods/matrices/yield → default rate
  card → first site/device → plan selection (Checkout) → Customer Portal; webhook
  updates `org.plan`; feature gate helper `requirePlan(feature)`.
- `/admin/settings`, `/admin/rate-cards`, `/admin/species`, `/admin/subscription`.
- `scripts/seed-demo-org.ts` creating `demo-plant` with customers, tags, locations,
  intakes across every state (used by e2e).

## Acceptance
- Every bullet under **Deliverables** is backed by a named test, or by a `docs/wp/WP-22.md` note explaining how to verify by hand (hardware only).
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
