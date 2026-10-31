# Filletry — Station UX

Floor wording (order / tote / basket / location / box), the next-step line, the step row and
"Enter manually" are decided in [`11-FLOOR-WORDING.md`](11-FLOOR-WORDING.md) (v1.2, #98).

The look of every station (type, spacing, colour and the variance bands, motion, the shared
components and the states each station must design) is set in
[`12-DESIGN-SYSTEM.md`](12-DESIGN-SYSTEM.md) (UI pass 1, #125). Build new station screens from it.

## Shared primitives (`apps/web/src/components/station/`)

- **`<StationShell>`** — full-screen, no top nav, station name + site + operator chip,
  large status banner area, persistent `<ScanInput>`. Dark-on-light high contrast;
  tap targets ≥ 56 px; no hover-only affordances; font ≥ 18 px on floor stations.
- **`<ScanInput>`** — hidden-but-focused text input capturing keyboard-wedge scanners.
  Enter submits; input cleared; re-focused after every render and every dialog close
  (dialogs are non-modal overlays, never trap focus). Emits parsed `{kind, …}` via
  `packages/rules/qr.parse`; unknown → red flash + buzz + `scan_log(rejected)`.
- **Next step line** (v1.2, #98) — the largest text on screen, in the status area: what to do
  next ("Scan basket", "Weigh basket 005"), with a step row on multi-step stations. See
  `11-FLOOR-WORDING.md`.
- **Enter manually** (v1.1, #84; renamed v1.2, #98) — every scan station (and the storage pickup
  wizard, `/pair`) has an "Enter manually" button (≥ 56 px), directly under the next step line,
  that opens a visible field (labelled with what's expected, e.g. "Basket number") with the
  normal on-screen keyboard.
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
**Design system** (UI pass, #128; `12-DESIGN-SYSTEM.md`; client side only, same RPC): the open
order is the hero card: "Order INT-0002 · tote 1 of 2", species and the FAST PASS / DIRTY /
RIBBING badges as chips, one pip per tote (`Tally`), the order's notes each with what it is about
(dirty fish, cut, processing), and what to scan next. NEXT UP is below it as order tiles (species,
totes, cooler bypass or processing, hours since drop-off). The step row is
`1 Open an order · 2 Scan its totes · 3 Next order`; it ticks off as totes come in. Flow changes:
- Finish queue stays outlined while scanning leads. Once every tote of the open order is in and
  nothing is next up, the next step line is "Tap Finish queue" and it is the filled button.
- A refusal for missing totes (a tote of the next order, or Finish queue, before every tote is
  scanned) puts a **Missing totes** panel at the top of the work area with the next step line as a
  warning ("Scan the missing tote for INT-0002"). It replaces the "Manager override" disclosure,
  which had to be found and opened first. Scanning the missing tote clears it.
- The override reason is typed in an explicit editing mode (**Add reason**, then **Done** or the
  keyboard's Enter) that pauses the scanner, as for Reconcile's sign-off note; before, the
  scanner took focus back from the reason field.
- **Approve incomplete totes and finish** sends the refused tote with the approval, so the next
  order opens in the same step (before, its tote was scanned again). A manager account approves
  directly; anyone else enters a manager PIN, as before.
- Finish queue and the approval go straight to the server: offline, they wait and say "Needs a
  connection". While scans are sending they wait and say "Waiting for scans to send" (shown once
  the wait lasts, so a quick round trip never flashes it).
- A finished order says so in green: "Order INT-0002 sent to reconcile" (and which order opened).
- First load shows placeholders in the final layout; a failed refresh says "Refresh unavailable;
  check connection." An open order that moved on elsewhere reads "Open order not found", with
  **Clear stale open order** as the step (it is no longer shown while a just-scanned order's
  refresh is on its way). Orders left open at another station are listed to **Resume**.

## Reconcile (scan + scale)
Queue (FIFO by `rollstock_done_at`); tap or scan a tote to open. Form: expected yield per
line, vessel table (rows added by scanning a tag), live scale reading widget (latest
stable weight; **Accept** writes it to the highlighted vessel row; **Enter weight manually** types a
weight > 0 when the scale or its link is down, flagged MANUAL WEIGHT and counted in reports),
variance % with its band (within / near / over the org's limit),
exchange-vessel row type (no tag), **Send to Blast Freezer** when complete.
**Adding baskets** (v1.2, #97): the order card has **Enter manually** (field "Basket number",
reads a tag) next to **Add exchange basket**, so a phone (~400 px) never scrolls back to the top
to type a code; with an order open the shell's own Enter manually is not shown. An order with no
baskets says "Scan basket to add it — or tap Enter manually." and shows "No baskets yet" instead
of a variance, band or hold warning; the weight and remove buttons say "Add a basket first" (then
"Tap a basket first" until one is selected). A basket added by scan or typed number is selected
straight away, so Accept / Enter weight manually are live without a tap.
**Weighing** (UI pass 1, #125; bake-off entry A, client side only, same RPC): after a successful
**Accept** the next unweighed basket is selected on its own. Accept then waits for a **new** stable
reading: a reading counts as used once it is on a basket of the order (`vessel.scale_reading_id`,
the reading the server actually wrote, which may be newer than the one shown), and the one shown
is held as used until the refresh lands. Meanwhile the scale reads "Reading used" and Accept says
"Put the basket on the scale for a new reading", so one reading never goes to two baskets.
**Enter weight manually** is a form: the keyboard's Enter saves it, like **Save manual weight**,
and after a typed weight the selection stays on that basket (no auto-advance). A weight shows on
its basket as soon as it is tapped, with a spinner until the refresh confirms it. While baskets are
unweighed the variance is a running figure ("… so far, N to weigh"), muted, with no refusal
warning.
**Variance hold** (v1.1, #87; `04-BUSINESS-RULES.md §6a`): a send over the limit is refused
and the intake is held with its rollstock neighbours (1 before, 2 after). Held intakes carry a
HELD badge in the queue. Opening a held intake shows the hold group in rollstock order (each
member's variance, band and where it is) and the **manager sign-off**: tap a reason (≥ 56 px
buttons; "Other" needs a note), then a manager PIN (a manager account signs off directly). The
"now in blast" lines (this station's site only, #96) are listed below. A flagged order back within the limit shows, under its
band and before Send is pressed, the same line the refusal gives (v1.2, #93): "INT-0002 is
within the limit. Hold waits on INT-0004 (+22%) and INT-0003 (not at reconcile yet). …"
(`04-BUSINESS-RULES.md §6a`, Waiting on).
**Suspect picker** (v1.1, #88; `04-BUSINESS-RULES.md §6b`): **Find the fish (suspects)** on the
hold panel, or a tap on any "now in blast" line, opens a card (no modal) with the group: the
flagged (or tapped) intake, then its suspects most likely first, each "INT-0003 · −40% · over
limit · salmon · 50 lb · reconciled". Members whose variance has the flagged intake's direction
follow below a divider, **Same direction: unlikely source**, with no suggested move
(DECISION-33, #125; the rules engine groups them). Until every member is reconciled it reads "Suggestions
appear once every intake in the group is reconciled. Waiting on: …"; then it lists suggested
moves ("Move 0042 · 20 lb INT-0002 → INT-0003 (off by 44 lb → 4 lb)", **Move this bin**, or
**Pull back INT-… first**). Any bin of a member at reconcile can be moved by tapping it, then
**Move … to INT-…**. A member in blast has **Pull back INT-…**: a reason (typed in an explicit
editing mode that pauses the scanner, like the sign-off note), then **Confirm pull back**. Moves
and pull backs need a manager PIN unless a manager account is signed in.

## Blast (scan only)
Scan vessel tag → `blast_in_at`; list shows vessels in blast with time-in.
**Released, waiting for blast-in** (v1.1, #86): occupied vessels of intakes sent to blast
(`blast_freezer`, or already `stored` by a sibling vessel) with no `blast_in_at`, oldest release
(`intake.blast_at`) first, showing tag (or "Exchange"), intake number and weight. Tagged vessels
are blasted in by scan; an exchange (untagged) vessel has a **Blast in** button (≥ 56 px) that
calls `blast_vessel_by_id` (same operator proof, locking, `action_log`, `scan_log`). A tagged
vessel is never accepted by id. "Blast freezer empty" shows only when both lists are empty.
**Now in blast** (v1.1, #87): one line per intake sent to blast while any of its vessels is not
yet on a shelf, in rollstock order: "INT-2120 is in the blast · variance +14% · near limit",
coloured within (green) / near (amber, ≥ 2/3 of the limit) / over (red), with the band in words.
Only the station's own site is listed (v1.2, #96): `now_in_blast` filters by the paired device's
site (`app.station_site_id()`), so a multi-site org's blast and reconcile screens show one
rollstock line. Managers in Admin, and a device with no site, see every site.
**Design system** (UI pass, #129; `12-DESIGN-SYSTEM.md`; client side only, same RPCs): the
released baskets and the in-blast baskets are two lists of basket rows side by side (one column on
a phone, waiting first); the "now in blast" lines sit in the rail with a compact variance meter
under each. One step, so no step row. Flow changes:
- A waiting row shows how long since its order was sent to blast; a tagged row says **Scan**. An
  exchange row's **Blast in** is outlined while scanning leads, and is the filled button when only
  exchange baskets wait (the next step line is then the tap).
- **Blast in** lands on the tapped row at once: a spinner replaces the button (so a second tap
  sends nothing) until the refresh moves the basket to In blast.
- First load shows placeholders in the final layout; a failed refresh says "Refresh unavailable;
  check connection." under the scan tile. Nothing waiting and nothing in the blast each say so;
  both empty reads "Blast freezer empty" and where baskets come from.

## Locate (scan only)
Two-step loop: scan vessel tag (shows intake, species) → scan location → placement
written; both reset. Reject archived/unknown locations. No capacity hints.
Exchange (untagged) baskets awaiting a shelf (occupied, unlocated, intake sent to blast) are
listed under step 1; tapping one (`locate_vessel_by_id`) makes it the pending vessel, keyed by
id, and the location is then scanned or typed through `locate_scan` as usual (v1.1, #86).
**Design system** (UI pass, #129; `12-DESIGN-SYSTEM.md`; client side only, same RPCs): the step
row ticks "Scan basket" off once a basket is scanned. Step 1 is a card saying what to scan; step 2
names the basket (order, species) and the location it waits for ("Scan its location", with the
label format). Flow changes:
- Each exchange basket is one whole-row tap target (≥ 72 px) instead of a Select button beside
  its text.
- The exchange list stays in step 2 with the chosen basket framed (**Selected**, `aria-pressed`):
  switching to another exchange basket is one tap (was **Scan a different basket**, then
  **Select**). Tapping the chosen basket again sends nothing. The tapped row shows a spinner until
  the reply lands.
- Step 2 says a wrong basket is fixed by scanning the right one (`locate_scan` already replaces
  the pending basket on a basket scan); **Scan a different basket** stays for clearing it.
- While scans are still sending, the exchange rows and **Scan a different basket** wait and say
  "Waiting for scans to send" (shown once the wait lasts, so a quick round trip never flashes it).
- First load shows a placeholder card; a failed refresh says "Refresh unavailable; check
  connection." under the scan tile (it used to empty the list silently).

## Counter allocation (tablet)
Create session from one or more intakes (customer search / scan boxing QR) → anglers
list → split method → per-angler species/lb → box plans (method, size, weight, heavy
check) → **Price** (settlements computed) → print per-angler receipt with boxing QR →
hand off to register.

## Boxing / will-call (scan + ticks)
Open by scanning a boxing QR or from the queue. Shows this party's `planned` boxes with
tick boxes, and `occupied` vessels (tag, species, lb, location sorted by walk path)
with tick + "Lbs left" input (an exchange basket has no tag to scan: it is ticked by tap);
notes panel (DIRTY, cut/processing notes, RIBBING,
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
