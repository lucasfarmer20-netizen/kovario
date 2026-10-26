# Lessons carried from the Custom Seafoods reference implementation

The CSP Odoo suite ran a full 2026 season. Nearly every late bug was an **invariant
violation**, and the fixes are now written down. Kovario inherits the invariants as
acceptance tests and the gotchas as design rules. Where a lesson is Odoo-specific it is
translated to its Kovario equivalent.

## 1. Translated design rules

| CSP lesson | Kovario rule |
|---|---|
| Occupancy read from `asset_tag_id` gave false "fish gone" (nulled tags on full baskets, untagged exchange baskets). | `vessel.lifecycle_state` is the only occupancy source. Lint rule: no query may infer occupancy from `asset_tag_id is null`. |
| Stored computes with wrong `@api.depends` went stale forever; fixing the depends was not retroactive. | No app-maintained denormalised columns. Derived values are views or trigger-maintained; a migration that changes a trigger also backfills in the same migration. |
| Release/storage money paths had 7+ review rounds until invariants were written first. | Invariants (§3, §4 below) are the tests. Write the tests from the tables before the code. |
| `select … for update` on the session row was needed because label buys are money. | Fixed lock order **session → vessels → intakes**, sorted ids, inside one SQL function. |
| POS paid hooks missed cash orders (already paid on create). | Paid hooks run on insert-as-paid and on transition. |
| QR content vs scan parser mismatch was the single most recurring bug class (tote tags, boxing, location tags). | One `qr.ts` module for encode and parse; round-trip tests per label kind; a label PR must include its parser test. |
| 393 of 601 generated freezer locations had no shelf behind them; the labels scanned perfectly and 72 baskets were "stored" in thin air. | Generate locations only from the racking as built; archive-not-delete; archived locations reject binding; pallet/quarantine codes are non-grid. A scanned code is never evidence the thing exists. |
| Freezer capacity gating stranded baskets mid-relocate. | Never gate on capacity. |
| Asset tags with mixed padding (`42` / `042`) read as unbound. | Canonical 3-digit codes; scanner input normalised before lookup. |
| Rollstock wave-bypass skipped tote verification; accepted by the plant with an audit note. | Keep the bypass; keep the audit note; keep the X-of-X tote gate before reconcile. |
| Fast Pass repriced retroactively by a lodge flip would have under/over-charged. | Fast Pass is intake-only and never repriced; lodge cap is the only retro path. |
| Surprise at the register drove complaints more than the rate. | Rates on the intake screen, receipt and status page. |
| Two sites on one DB needed per-site print routing; a global printer binding forced both sites to one printer; the lodge box drops WiFi. | Printers are per site/device; agent heartbeat shows offline; never a global default printer. |
| Zebra via CUPS driver printed gibberish; FEED+PAUSE enters hex-dump mode. | Raw ZPL over TCP 9100, no driver. Ops note in the print-agent README. |
| Refund orders re-entered the release path. | Refunds are not payments; they never trigger release. |
| Receipt reprint re-rendered from live data and lost card details. | Receipts render from stored `payment` data. |
| Credentials pasted into chat / committed. | Secrets only in Vault/env by **name** (`secret_ref`); scrub functions centralised; CI secret-scan. |

## 2. Release-spec excerpts (verbatim from `counter-allocation-release-spec.md` v2 — §7 path matrix P1–P24 is the acceptance-test list)

### 1. The core tension (unchanged — the founding rule)

A **box** (`cs.box.plan`) is a *per-angler portion* of fish. A **vessel/tote**
(`cs.reconcile.vessel`) is a *pooled physical freezer container*. **There is no
data link between them** — one tote fills many boxes, one box draws from many
totes; the mapping lives only in the crew's hands.

**Founding rule:** box-fulfilment and tote-freeing are two **independent** facts
the crew reports. The code infers **neither from the other.** (Every derivation
attempt failed on partial pickups — rounds 1–3.)

---

### 3. State machines

### Box `fulfillment_state`
`planned → packed (ship) → shipped` ; `planned → picked_up (air/willcall)`.
Release transitions only `planned` (I2). Terminal states never roll back.

### Vessel `lifecycle_state` (**D1 — the new backbone**)
```
occupied ──(full pull)──▶ emptied      (tag freed, location cleared, measure→0)
occupied ──(split R)────▶ occupied      (tag KEPT, location cleared, measure := R)
(bad/dup/cancelled) ─────▶ void         (never actionable, never "fish present")
```
- **`occupied`** = fish remains (exchange baskets may be untagged and are still
  `occupied`). Actionable.
- **`emptied`** = full pull done. Not actionable; counts as "gone."
- **`void`** = disposition record; never actionable, never evidence of fish.
- **Split is an ACTION, not a state** — a remainder stays `occupied` with
  reduced `measure` (a half-full basket still occupies a tray slot).
- Occupancy and "fish gone" are read from `lifecycle_state`, **NEVER** from
  `asset_tag_id`. `asset_tag_id` is tag identity/reuse only.

### Intake `state`: `stored | blast_freezer → done` — via the single close gate (I10).

---

### 5. Design decisions (lighter spine)

- **D0 — idempotency by construction (replaces the transient-flag idea).**
  Complete acts **only on current-state-actionable records**: `planned` boxes and
  `occupied` vessels. A re-submit, browser-back, or the losing side of a
  concurrent race re-reads state, finds boxes already `packed` / vessels already
  `emptied`, and does nothing. No transient completion flag, no event ledger.
  Backed by **I16 preflight** (re-read + validate before any write).
- **D1 — vessel `lifecycle_state` enum**, added via `_inherit` on
  `cs.reconcile.vessel` in `cs_counter_allocation` (no `cs_sport_intake` edit →
  camera-scan untouched). Actionability + fish-gone read this, never tag. A
  repo-wide sweep must replace **every** `asset_tag_id`-as-occupancy read
  (notably today's `_cs_close_completed_intakes.fish_gone`).
- **D3 — append-only audit log** (`cs.release.audit`), one row per (release,
  intake) with kind (fish moved / box finalized), operator, time, payment ref.
  Refs never overwrite; movement and fulfilment are distinct rows. This replaces
  the scalar `manual_payment_ref` accumulation (whose overwrite + compound-ref
  bugs proved scalars can't represent multiple per-angler releases on a shared
  pooled intake). Legacy scalar intake fields may remain as a *last-event
  summary* only.
- **D4 — one party per wizard**, partner fallback
  `party_partner_id or intake_ids[:1].partner_id`.
- **D5 — held and blocked are orthogonal** in the buy path.

---

### 6. THE INVARIANT TABLE (centerpiece — v2)

| # | Invariant | Source |
|---|---|---|
| **I1** | Box-finalisation reads only box-ticks; tote-freeing reads only tote-ticks. Neither inferred from the other. | R1–3 |
| **I2** | Release transitions only `planned` boxes; terminal box states never roll back. | R3 |
| **I3** | A box is finalised iff its box-tick is on; unticked stays `planned`. | R4 |
| **I4** *(amended)* | **The tote tick is the SOLE action selector.** A vessel is acted on iff its tick is on. | ChatGPT I16 |
| **I5** *(amended)* | For a **ticked** line: `Lbs Left = 0` → full pull; `0 < Lbs Left < measure` → split; anything else → hard error. An **unticked** line's nonzero remainder is rejected/cleared before Complete — never an action. | R5, R7; ChatGPT I16 |
| **I6** *(amended)* | A vessel is *actionable* iff `lifecycle_state == 'occupied'` AND ticked. Full pull → `emptied`. Split → stays `occupied`, measure reduced. **Never keys on `asset_tag_id`** (fixes exchange + tag-reuse). | R7; D1 |
| **I7** | Complete with nothing actionable → no writes, stay on the form, warn. | R4 |
| **I8** *(amended v2)* | Box-finalisation and tote-freeing are independent, EXCEPT: finalising a box is a **hard block** when fish has NOT moved for its party — i.e. no tote is ticked THIS run AND the party's session has **no prior `cs.release.audit` movement row**. A split writes a movement row just like a full pull, so a return trip after a split-only prior visit is correctly allowed. (Keying on the audit log, not vessel `emptied`, fixes Gemini's split-only case.) | R4; both reviews |
| **I9** *(amended)* | Audit = append a `cs.release.audit` row per intake whose fish **moved** this event (vessel emptied/split) and per intake whose **box finalised** this event, with operator/time/ref. Never overwrites; movement and fulfilment are separate rows; refs accumulate across a pooled intake's multiple releases. | R5–7; D3 |
| **I10** *(amended — the single close gate)* | One shared `_cs_try_close_after_release`. An intake closes to `done` iff: (a) `state ∈ {stored, blast_freezer}`; (b) it has **≥1** vessel (no vacuous `all([])`); (c) all its vessels are `emptied` or `void`; (d) **every** non-cancelled session pooling it (m2m) has **zero** `planned` boxes. Used by party, passthrough, and base paths alike. | R5, R6; ChatGPT I20 |
| **I11** | One party per wizard; a second distinct session, or a partner mismatch (fallback per D4), raises. | R6 |
| **I12** *(amended)* | Base release-all applies only to a **truly unpooled** storage intake — **no** non-cancelled allocation session pools it. A pooled passthrough intake closes via I10, never the base path. | R3; ChatGPT |
| **I13** *(amended)* | Buy/print gate: buy iff `ship_date ≤ today+1` (or `cs_force_buy_held`). Held = 2+ days out, reported as **info**. A missing ship date **blocks the buy** explicitly. Reprinting an **already-bought** label is **always** allowed (purchase hold ≠ print hold). | R4, R5, R7 |
| **I13b** | Held and blocked are orthogonal: a held shipment's real blockers (no service, bad address, missing date) are reported **alongside** the held notice, never hidden by it. | R7 |
| **I14** | Manager `cs_force_buy_held` buys a held label early, but **preserves all non-date blockers**. | R6 |
| **I15** *(amended)* | A fresh/rescanned wizard projects exactly the currently `planned` boxes + currently `occupied` vessels in scope; preserves ticks only for still-eligible records; drops finalised boxes / non-occupied vessels with a stale-state notice. | R6; ChatGPT I18 |
| **I16** *(NEW — preflight + one lock; amended after the code-vs-spec review)* | Complete first takes a `SELECT … FOR UPDATE` on the **session row** (serialises concurrent completes on the same party; required because the side effects — shipment create, label **buy = money** — are not idempotent under READ COMMITTED), THEN re-reads current state and splits the selection: **(a) genuine INPUT / scope faults** (Lbs-Left on an un-ticked line, negative Lbs-Left, split ≥ current measure, cancelled session, cross-party scope I17) → **abort all writes**, fix-and-retry; **(b) STALE-but-was-valid selections** (a tote a concurrent complete already `emptied`, a box already finalised) → **silently dropped**, and the release applies to the actionable remainder. If the remainder is empty, no-op (I7). A concurrent loser (all selections already done) therefore no-ops rather than erroring (D0/P18) — an abort is reserved for input the crew must fix, never for losing a race. | Gemini I16; ChatGPT I17; P18; review-round-final |
| **I17** *(NEW — authorised scope)* | Cancelled sessions, `void` boxes, and intakes pooled in **another** active allocation party are never releasable through the current party's wizard — even when the customer partner matches. | ChatGPT I21 |

---

### 7. Path / edge matrix (v2 — these are the test cases)

| Path | Scenario | Expected |
|---|---|---|
| P1 | Party, single angler, whole totes, all boxes | All finalise + emptied; intake closes iff I10 (all pooling sessions clear). |
| P2 | Angler A only (B, C later) | A's boxes done; B/C untouched; intakes stay `stored` (I10). |
| P3 | Split tote | Measure reduced, `occupied`, tag kept, location cleared; re-actionable in a **fresh** wizard; re-Complete same wizard = no-op (D0/I16). |
| P4 | Exchange (untagged) basket | Actionable via `lifecycle_state`; never dropped (I6/D1). |
| P5 | Box-only return trip (fish freed earlier) | Allowed (some vessel already `emptied`); audit-logs the box's party intakes (I9). |
| P6 | Mixed box + tote in one Complete | Both apply; audit rows for both moved and finalised intakes (I9), no over-stamp. |
| P7 | Multi-party scan into one wizard | Raises (I11). |
| P8 | Passthrough SET + plain storage intake, same customer | Allowed; storage intake closes by its own I10 gate. |
| P9 | Partner-mismatch mis-scan, `party_partner_id` unset | Raises via fallback (I11/D4). |
| P10 | Ship box 2+ days out | Packs; label held, info-reported; auto-print doesn't swallow the held notice (I13). |
| P11 | Held **and** real blocker | Both reported (I13b). |
| P12 | Manager needs held label now | `Buy Now` buys it, non-date blockers preserved (I14). |
| P13 | Storage-only (no settlement) | Base path (I12). |
| P14 | Re-Complete a completed wizard (browser back) | No-op via current-state actionability (D0/I16). |
| P15 | Additive re-scan mid-tick | Ticks preserved for eligible records; finalised dropped with notice (I15). |
| P16 | Autovacuum killed the transient | Reopen from queue = fresh projection; no partial writes lost (D0). |
| **P17** | **Tote-only release** (totes ticked, no boxes) | Vessels split/empty; boxes stay `planned`; audit-log movement; I10 decides intake. |
| **P18** | **Two fresh wizards, same party, concurrent** | First applies; second re-reads, finds nothing actionable → no-op (D0/I16). No double release. |
| **P19** | **Unticked tote carries a remainder** | No action inferred; value rejected/cleared (I5). |
| **P20** | **Direct intake pooled in ANOTHER active session** | Rejected — outside current party scope, even if partner matches (I17). |
| **P21** | **Intake with zero vessels** | Never auto-closes (I10's ≥1-vessel guard) → stays `stored` (safe default). Genuine no-fish closure is a manual manager action outside the release flow — release never guesses. |
| **P22** | **Selected record changed before Complete** (another op packed a box / emptied a vessel) | Preflight detects it; **no** partial writes; reports the stale record (I16). |
| **P23** | **Ship box missing ship date** | Pack may complete; buy is blocked + reported (I13). |
| **P24** | **Reprint an already-bought future-dated label** | Succeeds — hold applies to *buying*, not printing (I13). |

---

### 11. Amendment — 2026-07-20 (Release-by-Tag tool, two review rounds)

A manager **Release-by-Tag** wizard (`cs.tag.release.wizard`) now exists for
totes the crew forgot to tick in Boxing / Will-Call. Scope: totes only (I1
holds); manager-gated; cross-party protection is **warn-not-block** (tech-lead
decision — the forgotten tote usually IS in an active party); no payment gate
(legacy manual-payment releases are supported). Amendments to the frozen text:

- **I16 lock envelope extended (all release paths).** Lock order is now
  **sessions → vessels → intakes**, sorted ids within each level:
  - The party wizard locks its **vessel rows** after its session rows (the
    session lock alone did not serialise against a tag release of an
    unpooled basket).
  - `_cs_try_close_after_release` itself takes **intake-row locks** (always
    last; nothing is acquired after them) + re-read — two concurrent sibling-
    vessel releases of an unpooled intake could otherwise both skip gate (c)
    and strand the intake open.
  - The base walk-up `_release_basket` override now routes occupied
    vessels through `_cs_release_full_pull` (snapshot + zeroed measure —
    walk-up releases are restorable like every other path), with a
    per-vessel lock + D0 recheck: an already-emptied basket just flips the
    line to Released; a `void` vessel keeps base's stale-tag-freeing
    behavior and stays `void`.
- **I8 discriminator amended.** Movement = `moved` audit rows **outnumbering**
  `restored` rows for the party (Restore is append-only per D3, so an undo
  nets rather than deletes). Attribution is **net-aware, not recomputed**:
  a `restored` row copies its `session_id` from the latest `moved` row of
  its intake whose session still has a positive moved-minus-restored
  balance (pooling at restore time is NOT consulted — it can have changed
  since the release, and an orphan attributed restore would mask real
  future movement). Note the release paths themselves attribute
  differently by design: the party wizard stamps its own party
  (membership), the tag wizard the single still-active pooling party.
  The legacy `manual_payment_date` fallback counts only when the stamp
  **predates the intake's first audit row** (pre-log evidence; a stamp at
  or after it is the last-event summary of already-counted events).
  Accepted residual: a pre-log stamp overwritten by a later netted
  mis-release fails CLOSED (block, recoverable by ticking a tote), never
  open.
- **The extracted primitives** live on the durable models: vessel
  `_cs_release_full_pull` / `_cs_free_tag`; intake
  `_cs_try_close_after_release` (I10), `_cs_audit_moved` (I9, no payment_ref
  on `moved` rows), `_cs_pooling_sessions` / `_cs_pending_parties` (shared
  predicates). Both wizards call the same code paths.


## 3. Storage pickup invariants (verbatim from `storage-pos-pickup-spec.md` v1)

### 2. Invariant table

- **S1 exact set** — A batch releases exactly its `box_ids` (minus boxes
  already released elsewhere, which are logged loudly and skipped). No other
  path releases boxes through a batch.
- **S2 single charge** — A batch collects money at most once. A second
  payment from a DIFFERENT pos.order against a released batch = critical log
  + appended batch note; same-order re-sync = silent no-op. Never a second
  release.
- **S3 cart mirrors server** — A POS cart line for a batch is a stale copy
  the moment it is created. Every "Load Storage Pickup" REPLACES all
  batch-ref lines with the fresh payload (including empty payload). Any path
  that leaves a batch-ref line in the cart without refreshing it (RPC
  failure, removal failure) must warn the cashier NOT to charge, sticky.
- **S4 one money formula** — Rate = Cold Storage product `list_price` via
  `_cs_storage_rate()`. Days = `_cs_box_days()` (user tz, same-day = 1,
  billed from day 1, `max((end-start).days, 1)`). Amount computed ONLY in
  `_cs_snapshot_values()`. Every display of a day count or rate (wizard
  lines, box `days_stored`, receipt) uses the same helpers/formula. The
  legacy `cs_sport.storage_daily_rate` param is dead — never read it.
- **S5 locking protocol** — Any transaction that writes batch/box/intake
  state: (1) `SELECT ... FOR UPDATE` on the INTAKE row, (2) invalidate the
  ORM cache, (3) read, (4) guard, (5) write. In that order, intake lock
  always first. A guard evaluated before the lock is advisory and MUST be
  re-evaluated after. Applies to: wizard confirm, `cs_mark_paid_and_release`,
  Force Release, comp release.
- **S6 no shell-only states** — Every anomalous money state (paid-while-void,
  paid-after-release, release failure) appends a batch note + logs
  critical/error, and has an in-app manager remedy (Force Release / refund at
  the register). Notes ALWAYS append, never overwrite. *(Amended v1.1: a
  release failure in the paid hook must survive its own savepoint rollback —
  stamp `release_failed` + note OUTSIDE the savepoint; the loader refuses to
  serve a `release_failed` batch, closing the recharge-after-failure double
  charge.)*
- **S7 release artifact** — A released batch records amount, payment_ref
  (`<terminal ref>` | `<POS order name>` | `MANUAL` | `COMP`), pos_order
  (POS path), paid_at, released_at. COMP is a deliberate waiver with the
  waived amount in the note — it is NOT an invoice-later path; no AR
  document exists or is implied. (Invoice-later/house accounts: out of
  scope this season.) *(Amended v1.1: cash/non-terminal payments carry the
  POS order name as the ref — payment_ref is never empty on a released
  batch. A payment arriving for a MANUAL-released batch with no linked
  pos_order is ADOPTED as the original payment (note + error log, no
  charged-twice critical) so re-syncs become same-order no-ops.)*
- **S8 blast radius** — One broken batch never blocks loading another
  (per-batch savepoint + error entry in the loader); one batch's release
  failure never blocks the POS payment or sibling batches (per-batch
  savepoint in the hook).
- **S9 partial pickups** — Intake-level paid markers are stamped ONLY when
  the intake is fully released; payment refs accumulate ' / '-joined. A
  batch line carries ONLY the batch ref — never an intake ref.
- **S10 legacy is inert or loud** — Legacy draft-SO cleanup runs fully
  sudo'd (POS cashier has no Sales ACL, reads included). Legacy
  `x_storage_intake_ref` cart lines (pre-deploy carts) are NOT half-processed:
  the hook must not stamp a storage intake paid without a batch release —
  log a warning naming the order instead.
- **S11 refunds are not payments** — A refund pos.order (negative-qty lines)
  never enters the batch release path and never triggers S2's critical.
  Refund reconciliation stays manual at the batch (note).
- **S12 tax basis** — batch.amount is UNTAXED; the paid-amount comparison
  uses `price_subtotal` (untaxed, discount-aware). Assumes price-EXCLUDED
  taxes (the shop's config). If a price-included tax is ever put on Cold
  Storage, the mismatch note fires on every sale — that is the alarm, not a
  bug.

### 3. Known accepted limitations (decided, do not re-report)

- Cross-register double-load of the same pending batch is advisory-only
  (recently-loaded warning + S2 critical on the second payment). A hard
  claim would let an abandoned cart block the other register.
- **Parked-order stale storage line (v1.2, POS pickup):** the register
  Storage Pickup sweep clears stale storage lines from the ACTIVE order
  only. If a customer's storage line sits in a PARKED order and the same
  customer is re-reconciled in another order, the parked line points at a
  now-void batch; paying it hits the paid-hook paid-while-void guard
  (critical log + batch note, NO release) — a rare double-CHARGE surfaced
  for refund, never a double-release. Reaching into non-active orders
  meant guessing at v19's non-active-order line APIs (which may silently
  no-op), so the active-order sweep is the deliberate scope. Operational
  rule: keep a customer's storage pickup in one order.
- **Merged multi-intake line (v1.2):** if v19 POS merges two intakes'
  Cold Storage lines (same product+price), the JS detects the ref
  collision and refuses the whole pickup ("charge each intake as its own
  transaction") rather than mis-tag — safe degradation, never a mischarge.
  Single-intake pickups (the common case) never hit it.
- No automated tests this build (owner's call); staging checklist instead.
- Pay-now-pickup-later unsupported: payment = release.

