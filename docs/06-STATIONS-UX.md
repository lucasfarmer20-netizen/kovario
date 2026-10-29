# Filletry — Station UX

## Shared primitives (`apps/web/src/components/station/`)

- **`<StationShell>`** — full-screen, no top nav, station name + site + operator chip,
  large status banner area, persistent `<ScanInput>`. Dark-on-light high contrast;
  tap targets ≥ 56 px; no hover-only affordances; font ≥ 18 px on floor stations.
- **`<ScanInput>`** — hidden-but-focused text input capturing keyboard-wedge scanners.
  Enter submits; input cleared; re-focused after every render and every dialog close
  (dialogs are non-modal overlays, never trap focus). Emits parsed `{kind, …}` via
  `packages/rules/qr.parse`; unknown → red flash + buzz + `scan_log(rejected)`.
- **Type code** (v1.1, #84) — every scan station (and the storage pickup wizard, `/pair`) has a
  "Type code" button (≥ 56 px) that opens a visible field with the normal on-screen keyboard.
  It reads the short code printed beside each QR (`INT-0001-3`, `042`, `IF-A-01-1-F`,
  `STG-0001-2`, the pairing code) or full QR text via `packages/rules/qr.parseManual`, and
  submits the text a scan of that label would send through the **same** scan RPC (same
  validation, `action_log`, `client_action_id`), so a phantom code is rejected exactly like a
  scan. The request carries `x-filletry-entry-method: manual`, recorded as
  `scan_log.entry_method`. Closing it refocuses `<ScanInput>`. No PIN or manager gate beyond the
  station's own.
- **Feedback** — green flash + short beep on accept; red flash + double buzz on reject;
  text reason in ≥ 24 px for 3 s. Sounds are Web Audio, preloaded, user-gesture-unlocked
  on station open.
- **Queues** live-update via Realtime; show FIFO order and an age badge
  ("18h in cooler").
- **Operator PIN** overlay on first interaction after idle (15 min); manager PIN
  overlay for gated actions.
- **Scan queue** — every scan action is posted with a `client_action_id`; on network
  failure it is queued in IndexedDB and retried; the UI shows a small "N pending"
  badge; the station still gives optimistic feedback for locally-validatable scans
  and reconciles on reply.

## Intake (keyboard)
Phone search (≥ 3 digits, live dropdown: name, phone, last visit, lodge badge) → new
customer inline → species lines (species → condition → method dropdowns filtered by the
matrices; lb; fillets % for salmon+fresh; skin-off for whitefish/shark) → tote count →
dirty/cut/processing notes → Fast Pass toggle → live price panel (per-line rate, est.
yield, total) → **Save & Print Tote Tags** (locks the record; creates charges; queues
print jobs; shows "Reprint", "Print Receipt", "New Intake", manager "Unlock").
Intake number is the hero element on the tote tag (≥ 100 pt) so it reads across the
cooler.

## Storage intake (keyboard)
Customer → location → boxes (weight, description) → **Confirm** → storage box labels
(QR `FL:SBOX`) + receipt.

## Wave (scan + a few taps)
Left: holding intakes FIFO with age, lb, species summary, tote count, FAST PASS / DIRTY /
RIBBING badges. Tap to add to wave until target lb; **Start Verification** → scan each
tote; counter `scanned / expected`; **Complete — Start Processing** enables at parity.

## Rollstock (scan only)
Big panel: OPEN AT ROLLSTOCK (intake number, species summary, tote X/Y, notes badges)
and NEXT UP list. Scan loop per `04-BUSINESS-RULES.md §5`. One de-emphasised
"Finish queue" button.

## Reconcile (scan + scale)
Queue (FIFO by `rollstock_done_at`); tap or scan a tote to open. Form: expected yield per
line, vessel table (rows added by scanning a tag), live scale reading widget (latest
stable weight; **Accept** writes it to the highlighted vessel row; **Manual entry** types a
weight > 0 when the scale or its link is down, flagged MANUAL WEIGHT and counted in reports),
variance %,
exchange-vessel row type (no tag), **Send to Blast Freezer** when complete.

## Blast (scan only)
Scan vessel tag → `blast_in_at`; list shows vessels in blast with time-in.

## Locate (scan only)
Two-step loop: scan vessel tag (shows intake, species) → scan location → placement
written; both reset. Reject archived/unknown locations. No capacity hints.

## Counter allocation (tablet)
Create session from one or more intakes (customer search / scan boxing QR) → anglers
list → split method → per-angler species/lb → box plans (method, size, weight, heavy
check) → **Price** (settlements computed) → print per-angler receipt with boxing QR →
hand off to register.

## Boxing / will-call (scan + ticks)
Open by scanning a boxing QR or from the queue. Shows this party's `planned` boxes with
tick boxes, and `occupied` vessels (tag, species, lb, location sorted by walk path)
with tick + "Lbs left" input; notes panel (DIRTY, cut/processing notes, RIBBING,
SMOKING SPLIT links). **Complete** runs the release function. Pick list printable.
Manager: Release-by-Tag.

## Register (keyboard + terminal)
Customer search → **Load outstanding** (settlements, storage batches, open charges) →
cart (server-mirrored) → retail lines (optional, simple catalogue) → tax → **Charge** →
terminal flow (`05-PAYMENTS.md §2`) → receipt. Manager: void/refund with reason.

## Shipping (keyboard)
Queue of ship boxes grouped by shipment: address verify, rate shop (allowlist, Rate
Check tool bypasses), buy label (held if ship_date > today+window; blockers listed),
print label, mark shipped, tracking. Walk-in filter.

## Admin
Org settings, sites, devices (pairing QR), printers, scales, terminals (secret refs),
rate cards, species/methods toggles, box sizes, lodges, locations generator + QR tag
sheet, asset tag pool (print sheets), users & PINs, status page settings, subscription.

## Customer status page (public)
Phone lookup → list of intakes with plain-language stage, estimated pickup, amount due,
pickup hours, rates notice. Rate limited; no PII beyond the caller's own records.
