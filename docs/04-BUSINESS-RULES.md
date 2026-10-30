# Filletry — Business Rules

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
lodge cap and from the Fast Pass floor: a Fast Pass intake pays ribbing at the plain
`ribbing_per_lb` rate (DECISION-19).

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
Scan tote → that intake opens (`processing → rollstock`). A `holding` tote scanned here is a
**rollstock bypass**: `holding → processing` (audited), then it opens as above
(03-STATE-MACHINES is authoritative, DECISION-20). Scan the **next** tote →
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

### 6a. Variance hold (v1.1, #87)
A large variance usually means fish went into the wrong order, typically a rollstock neighbour
(a missed tote scan on a small order). `packages/rules/src/variance.ts`; SQL generated by
`variance-sql.ts`.
- **Limit:** `org.settings.reconcile.variance_hold_pct`, whole percent 1–100, default **15**;
  managers edit it in Admin → Settings. Orgs from before v1.1 have no key and use 15.
- **Variance** = (actual − expected) / expected × 100, expected = `total_est_yield_lb`. Actual =
  the intake's `occupied` vessels up to reconcile; once sent, the weight at Send to Blast
  (`intake_blast_send`; releases only lower the occupied weight afterwards). Compared exactly at
  2 decimals. Bands: **over** = |variance| >
  limit; **near** = ≥ 2/3 of the limit; **within** otherwise; **unknown** when nothing was
  expected (never held).
- **Rollstock order** = the order intakes were actually opened at rollstock: each intake's first
  accepted rollstock `scan_log` row (`scanned_at`, then scan id), per site. Waves play no part.
  Neighbours are looked for among intakes opened within 7 days of the flagged one
  (`ROLLSTOCK_NEIGHBOUR_WINDOW_DAYS`).
- **Hold group** = the flagged intake, the **1 before** and the **2 after** it in rollstock
  order, clipped at the ends. Live: an intake opened later joins the group while the hold is
  active.
- **Send to Blast** over the limit is refused and flags the intake (`variance_hold`, active).
  Every group member not yet sent to blast is refused too ("waits for the hold to clear");
  members already in blast are listed, not blocked. Everything outside the group keeps moving.
  Sends serialise per org, so a flag and a neighbour's send never both pass.
- **Clears** (a) automatically once the members whose weight can still change are within the
  limit: every member has reached reconcile, and each one at reconcile is within the limit or
  signed off at its current weight. Members past reconcile (sent within the limit or signed off,
  actual frozen) and cancelled members are not judged. Re-checked on every reconcile weight
  change and every send; #88's bin moves call `app.variance_holds_reevaluate`. Or (b) by
  **manager sign-off**: reason
  `estimate_wrong | mixed_species | spoilage | trim_heavy | other` (other needs a note),
  manager account or manager PIN elevation, one SQL function (`variance_hold_signoff`) in
  `action_log`, shown in Reports → Variance holds. A sign-off covers the flagged intake's send
  only at the weight signed off; a changed weight over the limit flags again. Open points
  (DECISION-25…29) build the defaults stated in `08-DECISIONS.md`.
- **"Now in blast" line**: every intake sent to blast (flagged or not), while any of its
  vessels is not yet on a shelf: "INT-2120 is in the blast · variance +14%", in rollstock
  order, coloured by band. Shown on the blast and reconcile screens; #88's suspect picker ranks
  from the same lines (`public.now_in_blast`).

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
  `payment_event` (`paid_hook`) + `domain_event` (`register_order_paid`), print receipt with
  card last4 / brand / entry mode / auth code from `payment` (receipt rendered from stored
  data, not terminal). The paid hook does **not** write `release_audit`: that log is reserved
  for fish movement (`moved | finalized | restored`, read by I8–I10); a released storage batch
  keeps its own S7 release artifact (DECISION-24).
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
