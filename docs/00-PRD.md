# Filletry — Product Requirements (v1)

Status: **BUILD TARGET for v1.** Kickoff 2026-10-25. Owner: Lucas Farmer.
Change this only by editing `docs/08-DECISIONS.md` first; never by drifting mid-build.

---

## 1. What Filletry is

A standalone, multi-tenant SaaS for **small sport-caught-fish processors**: the plant
takes in a customer's *own* catch, processes it (fillets / portions / smoking / freeze),
tracks every vessel through freezers, splits a party's catch across anglers, boxes it,
collects payment, and hands it back or ships it. The guarantee the whole system exists
to protect: **the customer gets their own fish back.**

Filletry replaces Odoo for this job. It is a greenfield Next.js + Supabase application.
It contains no Odoo code and does not integrate with Odoo. The Custom Seafoods (CSP)
Odoo suite is the **reference implementation** — it has run a full season on the floor
and its invariants, state machines and hard-won lessons are the spec source
(`docs/10-LESSONS-FROM-CSP.md`).

Tenant zero is Custom Seafoods, Soldotna AK. Filletry must be able to run CSP's
2027 season end-to-end.

## 2. Who uses it

| Role | Where | Needs |
|---|---|---|
| Intake operator | Front counter, keyboard + label printer | Fast customer lookup by phone, species lines, price quote, print tote tags + receipt |
| Floor lead | Cooler / cutting floor, tablet + Bluetooth scanner | Build a wave, verify totes by scan, start processing |
| Rollstock operator | Vacuum station, scanner only, **wet gloves** | Zero-touch scan loop |
| Reconcile operator | Scale station, scanner + scale | Bind asset tags, capture weights, yield variance |
| Freezer crew | Blast / holding freezers, scanner | Scan vessel → scan location |
| Counter / boxing | Boxing area, tablet | Split party across anglers, box plans, release, print pick list |
| Cashier | Register, card terminal | Load a customer's charges, take card, auto-release |
| Manager | Anywhere | Pricing, overrides, refunds/voids, audits, reports |
| Customer | Phone | Public order-status page by phone number |
| Filletry admin (Lucas/Brooke) | Admin | Tenants, plans, billing |

## 3. Design principles (non-negotiable)

1. **Wet-glove rule.** Every tap or scan on a floor station must be justifiable with wet,
   gloved hands. Prefer scan-driven auto-advance over buttons. One always-focused scan
   input per station screen.
2. **Occupancy is a fact the crew reports, never an inference.** Vessel occupancy is read
   from `vessel.lifecycle_state`, never from "has an asset tag". Box fulfilment and vessel
   freeing are independent ticks (CSP release spec I1).
3. **Idempotent by construction.** Every state-changing action re-reads current state
   inside a transaction and acts only on currently-actionable records. Re-submits,
   browser-back and concurrent races no-op rather than double-act.
4. **Money paths are append-only and loud.** Payment/release events are logged rows, never
   overwritten scalars. Anomalies (paid-while-void, paid-after-release) append a note,
   log at error, and have an in-app manager remedy.
5. **Surprise drives complaints more than price.** Rates are shown at intake, on the
   receipt and on the status page before pickup.
6. **A scanned code is not evidence the thing exists.** Validate scanned locations,
   tags and totes against the master; phantom labels scan perfectly.
7. **Multi-tenant from day one.** Every row carries `org_id`; RLS enforces it; no
   cross-tenant query is possible from the app role.

## 4. v1 scope (what ships)

### Core pipeline (all stations)
Intake → tote tags → cooler hold → wave batch (scan) → rollstock (scan, zero-touch) →
reconcile (asset tags + scale) → blast freezer (scan) → holding freezer (scan + locate)
→ counter allocation (party → anglers → boxes) → boxing / will-call (release,
recycle tags) → register payment → pickup or ship.

### Cold storage path
Pre-packaged boxes → storage intake → stored → pickup batches (days-stored billing)
→ register payment → release.

### Payments
- **Provider interface** with per-tenant selection. v1 ships **three adapters**:
  `manual` (off-system settlement), **Dejavoo SPIn** (card-present; CSP's processor),
  **Stripe Terminal** (card-present for other tenants).
- Register screen: load a customer's outstanding charges (intake settlements, storage
  batches, retail notes), take payment, auto-release what was paid for.
- Manager-gated void/refund/reversal.

### Supporting
- Customers with phone-first search; lodge-guest flag + lodge pricing cap; Fast Pass.
- Pricing: season rates per processing method, lodge cap, Fast Pass floor — one rule.
- Label printing (ZPL) through a **print agent** on the plant LAN; receipts as PDF.
- Shipping via **Shippo** (verify, rate, buy label, track) for ship boxes.
- Public customer status page by phone.
- Reports: daily volume, pipeline, throughput, revenue, reconcile variance.
- Scan log on every scan, every station.
- Tenant onboarding + **Stripe Billing** subscription (5 tiers, $79–$899).

### Out of scope for v1 (explicitly)
- Commercial (non-sport) processing.
- Production-mode toggle / split-intake algorithm (CSP deferred design).
- Freezer audit tool, UPS-vs-Shippo reconciliation (CSP defect-repair tooling).
- Ecommerce / Shopify / card-not-present hosted payment page.
- Offline-first sync (PowerSync) — see DECISION-04; v1 is online with a resilient
  scan queue.
- Native mobile apps (PWA only).

## 5. Success criteria for v1

- A fresh tenant can be created, configured (species, rates, locations, tags, printer,
  processor) and run a full intake→payment→release in under an hour, seeded by script.
- CSP's 2026 reference flows (`docs/09-WORK-PACKAGES.md` → acceptance tests) pass on
  a demo tenant, including the release-invariant path matrix (P1–P24) and storage
  money-path invariants (S1–S12).
- Every station screen is operable with scanner only, except intake and counter
  allocation (keyboard/tablet by design).
- CI green on every merged PR: typecheck, lint, unit, migration apply, e2e smoke.

## 6. Non-goals / things not to build

- Don't port Odoo's data model (SO/MO/stock.move). Filletry has its own `charge`,
  `vessel`, `location` concepts. See `02-DOMAIN-MODEL.md`.
- Don't build an Odoo-style generic ORM/admin. Build the stations.
- Don't re-litigate the payment processor question for CSP: it is Dejavoo. Other
  tenants pick Stripe Terminal.
