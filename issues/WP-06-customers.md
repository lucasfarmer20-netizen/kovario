---
{
  "title": "WP-06: Customers: phone-first search, lodges, admin",
  "wave": 2,
  "labels": [
    "area:ui",
    "area:db",
    "wave:2",
    "work-package",
    "blocked-by:WP-03"
  ],
  "blocked_by": [
    "WP-03"
  ]
}
---
## Goal
Customer records with phone-first search (≥ 3 digits, live dropdown with name, phone,
last visit, lodge badge), inline create, lodge entity with pricing cap, and the lodge-
guest flip that triggers the reprice path (hook only; reprice logic lands in WP-07).

## Read first
`docs/02-DOMAIN-MODEL.md §2`, `docs/06-STATIONS-UX.md` (Intake), `docs/04-BUSINESS-RULES.md §2`.

## Deliverables
- `phone_digits` generated column + GIN/trigram index; `search_customers(org, q)` SQL
  function (never raises on partial input).
- `<CustomerSearch>` component (debounced, keyboard navigable, scanner-safe).
- `/admin/lodges`, `/admin/customers` (list, edit, merge-duplicates by phone).
- `set_lodge_guest(customer_id, bool)` function writing a `domain_event(kind =
  'customer_lodge_flag_changed')` row (table from WP-02) consumed by WP-07's reprice.

## Acceptance
- Search returns within 150 ms on 50k seeded customers; tests for partial/formatted
  phone input (`(907) 555-…`, `907555`, `+1907…`).

### Working agreement (every work package)
- Read `AGENTS.md`, then the docs listed under **Read first**. The docs are the spec; if
  the issue and a doc disagree, the doc wins and you note the conflict in the PR.
- Branch `feat/<issue-number>-<slug>`; one PR; conventional commits; link `#<issue>`.
- Done = CI green + acceptance criteria below demonstrably met (tests or a short
  `docs/wp/WP-xx.md` note with how to verify). Never mark done with failing tests.
- Do not expand scope. If you need something from an unmerged dependency, stub it
  behind an interface and say so in the PR.
- Never put secrets in code, tests, fixtures or logs.
