# Kovario — Business Rules

All of these live in `packages/rules` as pure, unit-tested TypeScript. The database
enforces the structural ones (constraints/triggers); the app never re-implements a
rule in a second place.

Seed data for species, conditions, methods, matrices and the 250-row yield table is in
`docs/seed/processing-rules.json` (extracted verbatim from the CSP reference).

---

## 1. Processing rules

### Condition matrix
Which incoming conditions are selectable (`condition_matrix` in the seed). Keys are
species groups (`salmon`, `whitefish`, `other`, `byproduct`) or overriding species codes
(`other_shark`, `other_shrimp`); lookup species code first, then group. Conditions:
`vs` = vacuum sealed (customer-packed, temperature unknown; processed As-is),
`vsf` = vacuum sealed frozen, `vsr` = vacuum sealed refrigerated.
`head_off` is a manager add-on method outside the matrix (seeded inactive).

### Processing matrix
Which methods are selectable per (species group or species code, condition). Rules of
thumb the matrix encodes:
- Salmon: most conditions → Fresh, Smoking (some add As-is); `as_is|vs|vsf` → As-is only;
  `vsr` → Freeze only.
- Whitefish: most → Portions; already-`portions|as_is|vs|vsf` → As-is; `vsr` → Freeze.
- Shark: Portions and/or As-is by condition. Shrimp: whole → Portions, tails_only → As-is.
- Byproduct: whole/vs/vsf → As-is; vsr → Freeze.
- **VSR (vacuum-sealed refrigerated) must be frozen** before release: Freeze only.
- **VSF (vacuum-sealed frozen)** → As-is only.

### "Fresh" (salmon only, virtual method)
Operator enters **Fillets %**; Portions % = 100 − Fillets %. Produces **two** charges:
fillets at `lb × fillets_pct/100`, portions at the remainder. Fillets % = 0 → all portions.

### Yield
`est_yield_lb = lb × yield_factor(species, condition, method)`, with fallbacks:
chum → reds; smoked-exchange methods → smoking. **Skin off** (whitefish + shark only)
multiplies the factor by the species' `skin_off_multiplier` (rockfish 0.867, lingcod
0.923, others 0.85). Variance at reconcile = `(actual − expected)/expected × 100`.

### Ribbing
Any line with condition `filleted_ribs` sets `intake.ribbing = true` and adds **one**
ribbing charge per such line (not one per intake) at `ribbing_per_lb × lb`. Ribbing is **excluded** from the
lodge cap.

### Smoked exchange
`smoked_exchange_*` methods are an exchange product: the customer's fish is swapped for
finished smoked product. Exchange baskets are **never asset-tagged** (`vessel.is_exchange`)
and are still `occupied` until released.

## 2. Pricing — ONE rule

```
price_per_lb(method, intake) =
  fast_pass            ? max(list_price(method), fast_pass_rate)        // floor; overrides cap
  : is_lodge_guest     ? min(list_price(method), lodge.pricing_cap)     // cap, methods with lodge_cappable only
  :                      list_price(method)
```
- `list_price` comes from the active `rate_card` at intake time (snapshotted on the
  intake).
- **Fast Pass** is intake-only and **never repriced** (a rate change or lodge flip must
  not re-floor an existing order).
- **Lodge cap** is the only tier with a retro reprice path: flipping a customer's
  `is_lodge_guest` reprices that customer's **open, unpaid, non-Fast-Pass** processing
  charges. Ribbing is never capped.
- Rate display: show the per-lb rate on the intake screen, the intake receipt, and the
  status page (surprise, not price, drives complaints).

## 3. Cooler hold
`hold_until = intake_at + hold_hours` (default 48). Guideline only; wave shows all
`holding` intakes with an hours-in-cooler badge, sorted oldest first.

## 4. Wave batch
Cascading FIFO fill toward `wave_target_lb ± tolerance` (suggestion, not a gate).
Verification requires scanning **every tote** (`tote_count`) of every intake in the wave.
Audio + colour feedback per scan; errors: not in this wave; all totes already scanned.
Complete moves every intake to `processing` and stamps `pulled_at`.

## 5. Rollstock (zero-touch loop)
Scan tote → that intake opens (`processing|holding → rollstock`). Scan the **next** tote →
previous auto-advances to `reconcile`, next opens. The only button is a de-emphasised
"Finish queue" for the last order. Catcher scans nothing; asset tags bind at reconcile.
Tote completeness gate: an intake with `n` totes needs all `n` scanned across
wave+rollstock before it may enter `reconcile` (manager override logged). Bypass is
**refused** for an intake locked into a `verifying` wave (remove it from the wave first).

## 6. Reconcile
For each vessel: scan asset tag (normalise padding; reject `in_use`/`retired`; reject
unknown code — **a scanned code is not evidence a tag exists**). The scan **binds the
tag immediately** (`available → in_use`, `vessel` row inserted as `occupied`) so two open
reconciles can never hold the same tag; removing the row before send frees it. Accept
scale weight
(latest stable reading, or manual entry flagged `manual=true`). Send to blast requires
every vessel to have weight > 0 and a tag (exchange vessels exempt from tag). On send:
intake → `blast_freezer` (tags are already `in_use`, vessels already `occupied`).

## 7. Freezers
- Blast: scan vessel → `blast_in_at`. Informational queue; no gate on duration.
- Locate: scan vessel, scan location. Rules: location must exist and be `is_active`
  (archived → reject); **no capacity gating, ever**; no fill guidance (crew chooses
  F/R). Writes `location_placement`, mirrors to `vessel.location_id`, first placement
  moves intake → `stored`.
- Location master: generated from the **racking actually built**, per org. Generator is
  idempotent and never emits a pallet-shaped code. Pallet/quarantine locations are
  `IF-PALLET-nn` so they can't be mistaken for shelves.

## 8. Counter allocation
- A session pools one or more intakes (m2m) and splits the party's catch across anglers
  by `weight` (proportional to take-home lb) or `even`.
- Each angler gets a settlement: processing share + box fees + freight (+ retail note).
- Box plans per settlement: method air / ship / willcall, size from catalogue, weight,
  70-lb heavy check.
- **Founding rule:** boxes and vessels have no data link; the crew reports both.

## 9. Release (boxing / will-call) — invariants carried verbatim
I1–I17 and paths P1–P24 from the CSP release spec are the acceptance tests
(`docs/10-LESSONS-FROM-CSP.md` §2 reproduces them; §3 holds S1–S12). Summary:
- Box tick finalises boxes; tote tick frees/splits vessels; neither inferred from the
  other (I1). Only `planned` boxes and `occupied` vessels are actionable (D0).
- Ticked vessel: Lbs Left = 0 → full pull; 0 < R < weight → split; else error (I5).
- Finalising a box is blocked when no fish has moved for the party — no tote ticked now
  and no prior `moved` audit row net of `restored` (I8).
- One party per wizard; cross-party scope rejected (I11, I17).
- Preflight: lock session → vessels → intakes (sorted ids), re-read, drop stale-but-
  valid selections silently, abort on input faults, no-op if nothing remains (I16, I7).
- Audit rows per moved intake and per finalised intake (I9). Restore is append-only.
- Close gate I10 after every release.
- Manager **Release-by-Tag**: totes only, warn-not-block on cross-party, no payment gate.

## 10. Storage billing & pickup batches — invariants S1–S12 carried verbatim
- Days = `max(1, days(end − start))` in org tz; same-day = 1; computed in **one**
  function used by wizard, box view, receipt and batch snapshot (S4).
- A batch releases exactly its box set, collects money at most once, mirrors the
  register cart from the server each load, locks the intake row first, logs anomalies
  loudly with a manager remedy, records a release artifact (amount, ref, paid_at,
  released_at), stamps intake-level paid only when fully released, treats refunds as
  not-payments, and compares untaxed amounts (S1–S12).
- Pay-now-pickup-later is unsupported in v1: payment = release.

## 11. Register & payment
- The register loads **server-computed** outstanding items for a customer: open
  settlements, pending storage batches, open charges. Cart lines carry the server ids;
  reloading replaces all lines.
- On `approved`: settle charges, mark settlements paid, release batches, write
  `payment_event` + `release_audit`, print receipt with card last4 / brand / entry
  mode / auth code from `payment` (receipt rendered from stored data, not terminal).
- Partial approval counts as approved for the captured amount; cashier collects the
  remainder on a second payment line.
- Refund orders never enter the release path.
- Void vs refund is the provider's call: send a **reverse** intent; store what the
  provider actually did. Never build void-window tracking. Both manager-gated.

## 12. Tax
Org setting `tax.mode exclusive|inclusive|none`, `rate`, optional `cap_amount` (max tax
per transaction, e.g. 6% on first $500 → $30). v1 computes tax on the register order
and shows it on receipts (DECISION-07).

## 13. Customer status page
Public `/s/<org>`; lookup by phone (last 4 + name initial or full phone), rate-limited.
Shows each open intake's stage in plain language ("In cooler", "Processing", "Freezing",
"Ready for pickup"), estimated pickup, amount due, and the org's pickup hours. No
weights or prices beyond amount due.
