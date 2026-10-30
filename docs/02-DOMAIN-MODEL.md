# Filletry — Domain Model

All tables: `id uuid pk default gen_random_uuid()`, `org_id uuid not null`, `created_at`,
`updated_at` (trigger), RLS by `org_id`. Column types are Postgres. Enums are Postgres
enums named `<table>_<col>`. Money is `numeric(12,2)`; weights `numeric(10,2)` in **lb**
(org setting `weight_unit` reserved for later, store lb in v1). Timestamps `timestamptz`.

Naming maps from the CSP reference are given as `← cs.model` for orientation only.

---

## 1. Tenancy

### org
`slug text unique`, `name`, `timezone text` (IANA), `plan text`, `stripe_customer_id`,
`settings jsonb` (see §9), `is_active bool`.

### org_member
`user_id uuid → auth.users`, `role enum(owner, manager, staff, cashier)`, `pin_hash text`
(4–6 digit PIN for station identification; same range everywhere), `display_name`. Unique `(org_id, user_id)`.

### device
Registered station hardware. `name`, `station enum(intake, storage, wave, rollstock,
reconcile, blast, locate, allocate, boxing, register, shipping)`, `token_hash`,
`site_id → site`, `last_seen_at`, `printer_label_id → printer`, `printer_receipt_id → printer`,
`terminal_id → payment_terminal`, `scale_id → scale`.

### site
Physical site within an org (CSP: Main, Lodge). `name`, `is_default`. Print routing is
per site/device (`← cs.station`).

### sequence_counter
`(org_id, kind text, value int)`; `next_seq()` locks the row.

---

## 2. Customers

### customer  (← res.partner)
`name`, `phone text` (E.164, indexed; `phone_digits` generated column of digits only for
search), `email`, `address jsonb`, `is_lodge_guest bool`, `lodge_id → lodge`, `notes`,
`last_visit_at`. Phone search: prefix/contains on `phone_digits` after ≥ 3 digits.

### lodge
`name`, `pricing_cap numeric` (per-lb cap applied to lodge guests), `contact jsonb`.

---

## 3. Reference data (per org, seeded from `docs/seed/processing-rules.json`)

### species
`code text` (e.g. `salmon_reds`), `name`, `group enum(salmon, whitefish, other, byproduct)`,
`shorthand text` (SOCK, HAL…), `skin_off_allowed bool`, `skin_off_multiplier numeric`
(default 0.85), `sort`, `is_active`.

### incoming_condition
`code`, `name`, `sort`, `is_active`. Seed: whole, hg, headed, gutted, filleted,
filleted_ribs, as_is, tails_only, portions, vs, vsf, vsr.

### processing_method
`code`, `name`, `shorthand`, `kind enum(service, virtual)` (`fresh` is virtual → splits to
fillets+portions), `is_exchange bool` (smoked-exchange products), `lodge_cappable bool`
(default true; the lodge cap applies only to cappable methods), `sort`, `is_active`
(`head_off` seeds inactive: it has no matrix or yield rows and is a manager add-on).
Seed: fresh, portions, fillets, smoking, smoked_exchange_traditional,
smoked_exchange_cajun, freeze, head_off, as_is.

### condition_matrix
`(matrix_key, condition_code)` allowed pairs. `matrix_key` is a species **group**
(salmon, whitefish, other, byproduct) **or** a species code that overrides its group
(`other_shark`, `other_shrimp`). Lookup: species code first, then its group. The seed
file uses exactly these keys; `salmonids` in `seed.species` maps to group `salmon`.

### processing_matrix
`(matrix_key, condition_code, method_code)` allowed triples, same key rule as
`condition_matrix`. (`← PROCESSING_MATRIX`)

### yield_factor
`(species_code, condition_code, method_code) → factor numeric(5,3)`; 250 seeded rows.
Chum falls back to reds; exchange methods fall back to smoking (rules engine handles
fallbacks, not duplicated rows).

### rate_card
Season pricing. `name`, `starts_on date`, `ends_on date`, `is_default`. One active per
date; `rate_card_line(rate_card_id, key text, amount numeric)` where `key` is a method
code (price per lb) or one of `ribbing_per_lb`, `fast_pass_per_lb`, `storage_per_box_day`.
**The rate card is the only source of money rates**; org settings hold no rates.

---

## 4. Intake (sport)

### intake  (← cs.sport.intake)
`number text` (INT-0001, unique per org), `customer_id`, `site_id`, `state enum(draft,
holding, processing, rollstock, reconcile, blast_freezer, stored, done, cancelled)`,
`intake_at`, `hold_until` (= intake_at + org.hold_hours), `estimated_pickup_at`,
`tote_count int`, `dirty_fish bool`, `dirty_notes`, `cut_notes`, `processing_notes`,
`cooler_location text`, `fast_pass bool`, `is_lodge_guest bool` (snapshot at intake),
`rate_card_id` (snapshot), `total_incoming_lb` (trigger-maintained), `total_est_yield_lb`,
`ribbing bool`, `locked bool` (true after save&print; edits need manager unlock),
timestamps: `pulled_at`, `rollstock_at`, `rollstock_done_at`, `reconcile_at`,
`blast_at`, `stored_at`, `done_at`, `cancelled_at`; `split_from_id` (reserved),
`wave_id → wave`.

### intake_line  (← cs.sport.intake.line)
`intake_id`, `sort`, `species_code`, `condition_code`, `method_code`, `lb`, `fillets_pct`
(salmon+fresh only; portions = 100 − fillets), `skin_off bool`, `ribbing bool` (derived:
condition = filleted_ribs), `yield_factor` (snapshot from rules engine at save),
`est_yield_lb` (= lb × factor), `notes`. Constraints: `lb >= 0`, `fillets_pct between 0
and 100`.

### charge  (replaces Odoo SO lines — a priced thing the customer owes)
`number` (CHG-…), `customer_id`, `kind enum(processing, ribbing, storage, box_fee,
freight, retail, adjustment)`, `source_type enum(intake, storage_batch, settlement,
manual)`, `source_id uuid`, `description`, `qty numeric`, `unit text` (lb/day/each),
`unit_price numeric`, `amount numeric` (= qty × unit_price, trigger), `tax_code text`,
`state enum(open, settled, voided, comped)`, `settled_payment_id`, `comp_reason`.
Intake save creates one `charge` per line method (fresh → two: fillets + portions) plus
**one ribbing charge per line** whose condition is `filleted_ribs`. Charges re-price only via the pricing
rule (`04-BUSINESS-RULES.md`), never by hand.

### tote_tag
One row per printed tote: `intake_id`, `tote_no int`, `of_count int`, `qr text`
(= `FL:TOTE:<intake_number>:<tote_no>`), `printed_at`, `print_job_id`. Scanning any
tote of an intake identifies the intake; tote completeness gates reconcile.

---

## 5. Cold storage

### storage_intake  (← cs.storage.intake)
`number` (STG-0001), `customer_id`, `site_id`, `state enum(draft, stored, partial,
released, cancelled)`, `intake_at`, `location_id → location`, `notes`, `box_count`,
`active_box_count`.

### storage_box
`storage_intake_id`, `box_no`, `label text` ("Box 1"), `weight_lb`, `description`,
`state enum(stored, released)`, `released_at`, `released_by`, `days_stored int`
(computed view: `max(1, days(coalesce(released_at, now()) − intake_at))` in org tz),
`batch_id → storage_pickup_batch`.

### storage_pickup_batch  (← cs.storage.pickup.batch; invariants S1–S12)
`number` (SPB-…), `storage_intake_id`, `state enum(pending, released, void)`,
`box_ids uuid[]` (exact set), `rate_per_box_day` (snapshot), `amount` (snapshot,
untaxed), `charge_id`, `payment_id`, `payment_ref text`, `paid_at`, `released_at`,
`release_failed bool`, `notes text` (append-only via function).

---

## 6. Processing floor

### wave  (← cs.wave.batch)
`number` (WAVE-0001), `state enum(draft, verifying, done, cancelled)`, `target_lb`
(default 4000), `tolerance_lb` (250), `started_at`, `completed_at`.
`wave_intake(wave_id, intake_id)`; `wave_scan(wave_id, intake_id, tote_no, scanned_at,
operator_id)`. Complete requires every tote of every intake scanned.

### scan_log
`station`, `device_id`, `operator_id`, `raw text`, `parsed jsonb`, `result enum(ok,
rejected)`, `reason text`, `intake_id`, `vessel_id`, `location_id`, `scanned_at`,
`entry_method enum(scan, manual)` (a code typed into "Type code" is `manual`).
Written for **every** scan.

### asset_tag  (← cs.asset.tag)
Permanent reusable tag on a physical basket. `code text` (canonical, zero-padded to the
org's `scanner.tag_digits` — **4** for new orgs, 3 for orgs created before v1.1; unique per
org; scanner input normalised: `42`/`042`/`0042` → `0042` at 4 digits), `qr text`
(= `FL:TAG:<org_slug>:<code>`), `state enum(available, in_use, retired)`,
`current_vessel_id`, `retired_reason`. `tag_digits` is raise-only (3 → 4 → 5 → 6): raising
re-pads every `code` and `qr` in `admin_update_org`; lookups normalise the numeric part, so a
label printed before the raise (`…:042`) still resolves to `0042`.

### vessel  (← cs.reconcile.vessel)
A physical basket of processed product. `intake_id`, `asset_tag_id` (nullable, unique
while bound), `is_exchange bool` (smoked-exchange baskets are never tagged), `weight_lb`
(`measure`), `species_summary text`, `lifecycle_state enum(occupied, emptied, void)`
(default `occupied` on insert at reconcile) **— occupancy is read ONLY from this**, `location_id → location` (current placement,
cleared on pull), `blast_in_at`, `blast_out_at`, `stored_at`, `emptied_at`,
`emptied_by`, `release_snapshot jsonb` (weight/location at release for restore).

### reconcile_line
Expected-vs-actual per intake line: `intake_id`, `intake_line_id`, `expected_lb`,
`actual_lb` (sum of vessels attributed), `variance_pct` (view).

### variance_hold  (v1.1, #87)
A refused Send to Blast over the variance limit (`04-BUSINESS-RULES.md §6a`). `intake_id`
(flagged), `state enum(active, cleared)` (one active per intake), flag-time `limit_pct`,
`expected_lb`, `actual_lb`, `variance_pct`, `flagged_at`, `flagged_by`; on clearing
`clear_kind enum(auto, signoff)`, `cleared_at`, `cleared_by` (manager), `reason
enum(estimate_wrong, mixed_species, spoilage, trim_heavy, other)`, `note`,
`cleared_actual_lb`, `cleared_variance_pct`. The group is not stored: views derive it live.
`intake_blast_send`: one row per intake, its `actual_lb` / `expected_lb` at Send to Blast
(`sent_at`, `sent_by`; a re-send overwrites it).
Views: `intake_variance` (expected / actual / variance / band; actual live up to reconcile,
frozen at send after it, `actual_frozen`), `rollstock_open` (each
intake's first accepted rollstock scan), `variance_hold_member` (each hold's group in rollstock
order, position −1…2, `blocked`), `now_in_blast`, `report_variance_holds`.

### scale_reading
`scale_id`, `weight_lb`, `stable bool`, `read_at`. The reconcile screen shows the latest
stable reading for its device's scale and lets the operator accept it into a vessel.

---

## 7. Freezer locations

### location  (← cs.freezer.location)
`zone text` (IF/OF…), `kind enum(rack, pallet)`, `row text`, `bay int`, `level int`,
`depth enum(F, R)` (null for pallet), `code text` (`IF-A-01-1-F` or `IF-PALLET-01`,
unique per org), `qr text` (= `FL:LOC:<org_slug>:<code>`), `is_active bool`
(archived locations **cannot** be bound — `_check_location_is_live`), `capacity int`
(display only — **never gate on capacity**), `sort_key` (row → bay → level → F before R:
drives the boxing pick-list walk path).

### location_placement  (← cs.freezer.locate.line)
Append-only history: `vessel_id`, `location_id`, `placed_at`, `operator_id`, `station`.
Only the Locate station writes placements; `vessel.location_id` mirrors the latest.

---

## 8. Allocation, boxing, release

### allocation_session  (← cs.allocation.session)
A party's split. `number` (ALC-…), `party_customer_id` (optional), `state enum(draft,
priced, done, cancelled)`, `split_method enum(weight, even)`, `fulfillment_status
enum(none, pending, partial, released)` (rollup view), `notes`.
`allocation_intake(session_id, intake_id)` — **m2m**; an intake can be pooled into
several sessions.

### settlement  (← cs.angler.settlement)
Per-angler bill within a session. `session_id`, `angler_name`, `customer_id` (optional),
`processing_share`, `box_fee_total`, `freight_total`, `retail_note`, `amount_total`,
`weight_total_lb`, `state enum(draft, paid)` (**payment axis only**), `paid_payment_id`,
`boxing_token text` (QR on receipt → opens boxing for this angler).
`settlement_species(settlement_id, species_code, method_code, lb)`.

### box_size
Catalogue: `name`, `max_lb`, `fee`, `dims jsonb`, `is_active`.

### box_plan  (← cs.box.plan)
`settlement_id`, `session_id`, `method enum(air, ship, willcall)`, `box_size_id`,
`weight_lb`, `heavy_allowed bool`, `fulfillment_state enum(planned, packed, shipped,
picked_up)`, `shipment_id`, `retail_to_box bool`, `label_printed_at`.
Terminal states never roll back. **No FK between box_plan and vessel** (founding rule).

### release_audit  (← cs.release.audit, D3)
Append-only. `intake_id`, `session_id`, `event_kind enum(moved, finalized, restored)`,
`released_by`, `released_at`, `payment_ref`, `vessel_id`, `box_plan_id`, `detail jsonb`.

### shipment  (← cs.shipment)
`number`, `box_plan_ids uuid[]`, `customer_id`, `ship_to jsonb`, `ship_date date`,
`state enum(draft, held, label_bought, shipped, cancelled)`, `carrier`, `service`,
`rate_amount`, `shippo_shipment_id`, `shippo_transaction_id`, `tracking_number`,
`label_url`, `is_walkin bool`, `blockers jsonb` (reported alongside held — I13b).

---

## 9. Payments

### payment_terminal
`name`, `site_id`, `provider enum(manual, dejavoo_spin, stripe_terminal)`,
`config jsonb` (non-secret: endpoint_url, tpn, register_id, stripe_reader_id),
`secret_ref text` (name of the Vault secret holding the auth key — **never the key**),
`is_active`.

### payment
`number` (PAY-…), `customer_id`, `terminal_id`, `provider`, `amount`, `tip`,
`state enum(pending, approved, declined, cancelled, indeterminate, voided, refunded,
error)`, `provider_ref text` (ReferenceId / PaymentIntent id), `provider_txn text`
(TransNum), `auth_code`, `card_brand`, `card_last4`, `entry_mode enum(chip, contactless,
swipe, manual, keyed)`, `host_response_code`, `decline_reason`, `receipt jsonb`,
`attempt int`, `idempotency_key text unique`, `settled_charge_ids uuid[]`,
`created_by`.

### payment_event
Append-only: `payment_id`, `kind enum(sale_requested, sale_result, status_check, abort,
reverse_requested, reverse_result, refund_requested, refund_result, error)`, `payload
jsonb` (scrubbed), `at`.

### register_order
One cashier session's cart: `customer_id`, `state enum(open, paid, void)`,
`line(register_order_id, charge_id | retail_product_id, qty, unit_price, amount,
batch_id?)`, `payment_ids`. On `paid`: settle charges, release storage batches, mark
settlements paid, write `release_audit`/`payment_event`. Hooks must fire on **create
as paid** (cash) as well as on transition.

---

## 10. Printing & devices

### printer
`name`, `site_id`, `kind enum(label_zpl, receipt_pdf)`, `agent_id → print_agent`,
`address text` (host:port for TCP 9100 or CUPS name), `is_default_for jsonb`.

### print_agent
`name`, `site_id`, `token_hash`, `last_seen_at`, `capabilities jsonb`.

### print_job
`printer_id`, `kind enum(tote_tag, receipt, storage_label, box_label, pick_list,
location_tag, shipping_label)`, `payload_type enum(zpl, pdf_url)`, `payload text`,
`copies int`, `state enum(queued, printing, done, failed)`, `error text`, `source jsonb`.

### scale
`name`, `site_id`, `agent_id`, `protocol enum(toledo_8217, manual)`, `port text`.

---

## 11. Audit spine

### action_log
`client_action_id text unique`, `user_id`/`device_id`, `action text`, `input jsonb`,
`result jsonb`, `at`. Replay returns stored result.

### domain_event
Transactional outbox: `kind text` (e.g. `customer_lodge_flag_changed`,
`intake_stored`, `shipment_shipped`), `subject_id uuid`, `payload jsonb`,
`processed_at`. Written in the same transaction as the change; consumers (reprice,
email) poll or react via Realtime and mark `processed_at`.

---

## 12. Org settings (`org.settings` jsonb, with defaults)
```json
{
  "hold_hours": 48,
  "estimated_pickup_days": 3,
  "wave_target_lb": 4000,
  "wave_tolerance_lb": 250,
  "receipt_footer": "",
  "status_page_enabled": true,
  "tax": { "mode": "exclusive", "rate": 0.06, "cap_amount": 30.00 },
  "shipping": { "carrier_allowlist": "*", "buy_window_days": 1 },
  "scanner": { "tag_digits": 4 },
  "reconcile": { "variance_hold_pct": 15 }
}
```
`reconcile.variance_hold_pct` (v1.1, #87): whole percent 1–100; absent on orgs from before
v1.1, which read the default 15.
`scanner.tag_digits` defaults to 4 for orgs created from v1.1 (earlier orgs keep 3) and can
only be raised (see asset_tag).
Money rates (Fast Pass, storage per box-day, method rates) live on the rate card, not
here. `tax.cap_amount`: Kenai Peninsula Borough-style cap (tax only on first $500 → max $30).
DECISION-07 covers whether tax is computed in v1 or recorded as a note.

---

## 13. Identifier formats (QR payloads — **parser and generator share one module**)

| Thing | QR text | Short code (printed beside the QR, typeable) |
|---|---|---|
| Tote tag | `FL:TOTE:<INT-0001>:<n>` | `INT-0001-3` |
| Asset tag | `FL:TAG:<org_slug>:<0042>` (padded to `scanner.tag_digits`) | `0042` |
| Location | `FL:LOC:<org_slug>:<IF-A-01-1-F>` | `IF-A-01-1-F` |
| Boxing token | `FL:BOX:<settlement.boxing_token>` | — (full QR text only) |
| Storage box | `FL:SBOX:<STG-0001>:<n>` | `STG-0001-2` |
| Device pairing | `FL:PAIR:<code>` (one-time 8-character code, scanned at `/pair`) | the code |

`packages/rules/src/qr.ts` exports `encode(kind, …)` and `parse(raw)`; every label
template and every scan handler imports from it. A scan handler must also accept bare
legacy forms (`INT-0001`, `042`) and normalise asset-tag padding. `shortCode(kind, …)` is the
human-readable code every label prints beside its QR; `parseManual(raw, options)` reads it (or
full QR text) when a person types it.
