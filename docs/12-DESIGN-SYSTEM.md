# Filletry — Floor station design system

UI pass 1 (#125), adopted from bake-off entry A (PR #123). This doc is the look and the
behaviour every floor station is built from; later station issues build on it. Wording is set
in [`11-FLOOR-WORDING.md`](11-FLOOR-WORDING.md), station flows in
[`06-STATIONS-UX.md`](06-STATIONS-UX.md). Where this doc and the code disagree, fix one of them
in the same PR.

- **Tokens:** `apps/web/app/globals.css`, `:root --st-*`, exposed to Tailwind as `st-*`
  colours (`bg-st-brand`, `text-st-ink-2`, …). shadcn `--primary` / `--ring` follow the brand.
- **Components:** `apps/web/src/components/station/` (exported from `index.ts`).
- **Gallery:** `/dev/station-gallery` shows the tokens, every component in every state, and
  Reconcile, Blast, Locate, Wave, Rollstock, Boxing, Intake and Storage intake in each of their
  states at 1280 × 800 and 400 px;
  each state is its own page (`/dev/station-gallery/<state>`). Static props, no DB. A new station
  adds its states here: its ids to `state-ids.ts`, its screens to `[state]/screen.tsx`, its frames with
  `StateFrames`.

## Principles

1. **The next step is the hero.** The step row and the next step line lead the screen; the scan
   feedback tile sits beside them, so the eye never leaves the top band to find out what
   happened. Steps tick off and advance as the operator goes (Reconcile:
   `1 Add baskets · 2 Weigh · 3 Send to Blast`).
2. **One place for scan feedback.** A fixed-height tile reads *Scanner ready*, then the result:
   accepted (green, check, short pop) or rejected (red, cross, shake; why, then what to do, in
   the docs/11 grammar). The layout never moves.
3. **Instrument, not form.** An order reads like the equipment on the bench: a scale head (big
   tabular figures, its state in words, which basket Accept writes to), a variance meter with
   the org's limit marked, and baskets as large tiles whose right edge shows a scale, a spinner
   or a check.
4. **Readable without colour.** Every state is colour **and** shape **and** words. Bands use
   icons (circle-check, triangle, octagon, dashed circle); the meter's near zone is striped and
   its over zone hatched; selected controls show a frame, a label and `aria-pressed`.
5. **The action that moves the order on is the only filled button.** Brand teal for Accept /
   Send / sign-off. Alternatives are outlined, removal is a red outline placed away from Send,
   disabled is a flat steel fill with the reason under it (`DisabledReason`, never a tooltip).
6. **Speed you can feel.** Results land where you tapped, in the same frame (optimistic,
   confirmed by the refresh). Buttons grey out only after 200 ms, so a fast save never flashes
   the screen. First load shows placeholders in the final layout.
7. **No verdict without data, no false alarms.** No variance until there is a basket; while
   baskets are unweighed the band reads *… so far, N to weigh*, muted, with no refusal warning.
   Red stays meaningful.
8. **Wet-glove first** (AGENTS rule 6). Targets ≥ 56 px (hero actions 72 px), text ≥ 18 px,
   nothing hover-only, one focused `ScanInput`; PIN and entry sheets are non-modal and hand
   focus back.

## Type

One sans family (`--st-font`: Inter, then the system UI fonts) with tabular figures for weights.
Label codes (`INT-2141`, `042`) use the mono family (`--st-mono`, class `st-code`) so the screen
matches the printed label. Scale ~1.25 from an 18 px floor:

| Token | Size | Use |
| --- | --- | --- |
| `--st-fs-label` | 18 px | labels, chips, meter scale, helper text (the floor minimum) |
| `--st-fs-body` | 20 px | body |
| `--st-fs-title` | 24 px | card titles |
| `--st-fs-heading` | 30 px | section headings |
| `--st-fs-readout` | 44–64 px (clamp) | scale readout, variance figure |
| `--st-fs-next` | 30–48 px (clamp) | the next step line: the largest text on screen |

The next step line reserves two lines on tablets so a long prompt never pushes the work area.

## Spacing, size, radius, elevation

- **Spacing:** 4 px base: `--st-1` … `--st-7` = 4 / 8 / 12 / 16 / 24 / 32 / 48.
- **Touch:** `--st-touch` 56 px (every target), `--st-touch-lg` 72 px (hero actions).
- **Radii:** `--st-r-sm` 10, `--st-r-md` 14, `--st-r-lg` 20, `--st-r-pill`.
- **Elevation:** `--st-e1` card, `--st-e2` raised, `--st-e3` sheet.

## Colour

Deepwater ink on steel. Every body text pair is ≥ 7:1; `--st-ink-3` (secondary only) ≥ 4.5:1.

| Role | Token | Value |
| --- | --- | --- |
| Ink (text, console bar, scale head) | `--st-ink` / `-2` / `-3` | `#0a1f29` / `#34505e` / `#587080` |
| Canvas / surface / sunken | `--st-canvas` / `--st-surface` / `--st-sunken` | `#e8eef0` / `#ffffff` / `#f2f6f7` |
| Lines | `--st-line` / `--st-line-strong` | `#d3dde1` / `#9fb3bb` |
| Brand (the one filled action) | `--st-brand` / `-strong` / `-soft` | `#0b5568` / `#073e4c` / `#def0f3` |
| Focus ring | `--st-focus` | `#1a8db0` |
| Salmon mark (brand, manager PIN) | `--st-salmon` | `#f0683a` |

### Variance bands

Each band is an ink / tint / edge triple plus a shape and words (`BandChip`); the band itself
comes from the rules engine (`varianceBand`), never from the UI.

| Band | Ink | Tint | Edge | Shape | Words |
| --- | --- | --- | --- | --- | --- |
| within | `#0f6b43` | `#ddf3e6` | `#23a26a` | circle-check | within limit |
| near | `#7a4a00` | `#fff1c4` | `#d99800` | triangle | near limit |
| over | `#a3201a` | `#fde3df` | `#e0483c` | octagon | over limit |
| unknown | `#44555e` | `#e7edef` | `#93a5ad` | dashed circle | no estimate |

**Near** starts at ⅔ of the org's limit (`NEAR_LIMIT_NUMERATOR / NEAR_LIMIT_DENOMINATOR`), so at
the default 15% limit: within < 10%, near 10–15%, over > 15%.

**Variance meter** (`VarianceMeter`): the full range, **−100% to +100%**, linear, with 0 at the
centre tick. Zones from the org's limit: within (plain tint), near (warning colour, striped),
over (hatched) beyond the limit. The scale labels both ends and ±limit. The needle sits at the
order's variance; past ±100% it is pinned to the end and turns red. The meter is decorative
(`aria-hidden`): the figure and the band chip beside it say the same in words.

## Motion

Short and interruptible; motion confirms what happened, it never decorates.

| Token | Duration | Uses |
| --- | --- | --- |
| `--st-dur-press` | 90 ms | button press |
| `--st-dur-state` | 180 ms | state changes (selection, colour) |
| `--st-dur-enter` | 260 ms | accept pop, basket enter, sheet rise, next-step fade-up, needle travel |

Reject shake is 320 ms. Easing `--st-ease` / `--st-ease-out`. Under
`prefers-reduced-motion` every animation and transition is cut to ~0 and the pulse and skeleton
shimmer stop.

## Icons

`lucide-react` (pinned). Icons sit beside words, never instead of them; decorative icons are
`aria-hidden`.

## Components (`apps/web/src/components/station/`)

| Component | What it is |
| --- | --- |
| `StationShell` | Full-screen frame: console bar (station, site, operator chip, `ConnectionChip`), command area (next step + scan feedback), one `ScanInput`; `nextTone` for warnings. `scanner={false}` is a keyboard station (no `ScanInput`, no Enter manually; below); `nav` adds console-bar links, `className` print rules |
| `NextStep` | Step row (done steps show a check, current has `aria-current="step"`) and the next step line. A one-step station (Blast) has no step row (docs/11 prompt grammar 3) |
| `DisabledReason` | The why under a disabled control |
| `ScanInput` | The single hidden-but-focused scanner input |
| `ScanFeedback` / `FeedbackBanner` | The fixed-height feedback tile (idle reads *Scanner ready* or paused, from the shell's `ScannerPaused` context) |
| `ManualEntry` | **Enter manually**: a visible, labelled field; keyboard Enter submits |
| `OperatorPinOverlay` / `ManagerPinOverlay` | Non-modal PIN sheets with 64 px keys; focus returns to the scanner |
| `ConnectionChip` / `useOnline` | *All sent* → *N pending* (amber) → *Offline · N pending* (red) |
| `BandChip` | A variance band as tint + edge + shape + words |
| `VarianceMeter` | The −100% to +100% meter above; `compact` drops the scale, for a list whose lines each say their figure and band (Blast's "now in blast" lines, `NowInBlastList meter`) |
| `ScaleReadout` | Scale head: reading, its state in words (stable, reading used, no reading), the basket Accept writes to |
| `BasketTile` | A basket: code, weight, and a scale / spinner / check at its right edge |
| `BasketRow` | A basket in a list (Blast, Locate, Boxing's released baskets): name over a meta line (order · lb · time); the right edge is a hint, a status or one action, and `busy` puts a spinner there; with `onSelect` the whole row is a toggle (frame, **Selected**, `aria-pressed`) |
| `OrderTile` | An order in a queue: number, HELD (lock + word), species, expected lb, age; `pressed` makes it a toggle (frame + *Added* with a check + `aria-pressed`, Wave), `flags` adds badges (FAST PASS, DIRTY, RIBBING). Without `onOpen` it is a static tile, for a queue the station only shows (Rollstock's NEXT UP) |
| `CountProgress` | A count toward a total, *3 / 5 totes*: readout-size figure, what is left in words, a bar that fills; green with a check at parity (Wave; Rollstock's totes of the open order; Boxing counts what is ticked, `2 / 6 ticked`) |
| `StationNotice` | An inline notice with a tone (ok / info / error) |
| `QueueList` | Realtime queue list |
| `speciesName` | A species code in the floor's words ("Reds" for `salmon_reds`), from the rules engine's species table |
| `Tick` | A yes/no choice as a 56 px tick (Dirty fish, Fast Pass): a real checkbox whose whole label is the target, ticked by fill, check and frame; `row` makes it a whole-row tick in a list (72 px, Storage pickup's boxes) with a meta line and a right edge. Boxing's `bx-tick` rows are the same pattern, built in parallel (#130) |
| `KeyboardStatus` | A keyboard station's status column: the scan tile's place and height, saying what a save or print did (green / red), idle "Keyboard ready" (`FeedbackBanner tone="keyboard"`), a notice under it |
| `useLasting` | A value once it has held for a while: a "Waiting for scans to send" reason shows only once the wait lasts (Locate, Rollstock) |

Shared classes: buttons are filled by default (brand); `st-btn-secondary` (outlined),
`st-btn-quiet`, `st-btn-danger` (red outline), `st-btn-hero` (72 px), `st-btn-block`. Older
`station-*` classes stay as aliases for screens not yet on the system.

Card parts (the same rules as Reconcile's `rc-*` parts): `st-card-head` + `st-count` (a list
card's heading and its count), `st-list` (rows or tiles), `st-empty` (an empty list: icon, what is
missing, where it comes from), `st-hero-empty` + `st-hero-art` (nothing open: art, what to scan),
`st-item` / `st-item-head` / `st-facts` (the open item: its name, then its facts as chips),
`st-expect` (a dashed box saying what the station waits for), `st-skeleton-list` (a loading
list) and `st-skeleton-stack` (a loading card). With them: `st-item-sub` (the rest of an item
heading after its code, "· tote 1 of 2"), `st-order-flags` + `st-badge-flag` (flag badges, on an
order tile or under an item heading), `st-notes` (an order's notes, each a `dt` saying what it is
about and the note), `st-finish` (a de-emphasised control at the foot of a card, its reason under
it). Panels that take the top of the work area (`st-panel`, `st-panel-title` / `-icon` /
`-kicker` / `-sub` / `-lead`, and `st-note` / `st-note-text` for a note typed in an editing mode)
are Reconcile's hold-panel rules under station-neutral names (Rollstock's missing totes, Boxing's I8
override).
`StationShell` takes `defaultManualOpen` so a gallery state can show **Enter manually** open.

Form parts (keyboard stations, Intake first; Register and Shipping next): `st-form` around fields
(its `select` and `textarea` are 56 px like inputs, and a customer search's options too),
`st-fields` (a grid that wraps by the card's width: four across on a tablet, two on a phone),
`st-field` (label over control; `st-field-span2` two cells, `st-field-wide` the whole row),
`st-line` (one line of a form, a species line or a box: its name and Remove, then its fields;
`data-complete` turns its edge green with a check), `st-stepper` (− / + beside a typed count),
`st-summary` (label left, figure right; `st-summary-sub` a caption, `st-summary-total` the total
as a readout), `st-yield`, `st-customer-name`, `st-hero-number` (a saved order's number at
readout size, as printed), `st-commit` (the forward action, alternatives under it) and
`st-link-secondary` (a link that looks like an outlined button). `st-floor[data-rail="end"]`
puts the rail right of the work from 1100 px: a form's summary and its forward action (Intake's
price and Save) rather than a queue.

### Lists that rank

When a list is ranked or grouped by a rule, the rules engine returns the groups and the order;
the UI renders them as given (AGENTS rule 8). Example: the suspect picker shows
`rankSuspects(...).suspects` under *Most likely first*, then a dashed divider with the words
**Same direction: unlikely source** above `.unlikely` (DECISION-33).

## States every station must design

Each one appears in the station's gallery entry. A station without the thing a state is about
shows its nearest case and says so in the gallery note: Blast and Locate have no scale or printer,
so *device offline* is a dead scanner (**Enter manually** open); they have no manager path, so
*held* is Blast's over-limit line (informational there: a held order never reaches the blast).
Rollstock has no scale or printer either (*device offline* is a dead scanner); its *held* is the
**Missing totes** panel (a manager approves an order short of totes), and its *empty item* is an
order just opened by its first tote (an order cannot open with none scanned).

| State | Expectation |
| --- | --- |
| Loading | Skeletons in the final layout; nothing jumps when data lands |
| Operator needed | *Identify operator* chip (salmon); the PIN sheet rises bottom-right (bottom on phones) |
| Nothing open / queue empty | What to scan or tap to start; an empty queue says where items come from |
| Empty item | What is expected, and every disabled control says why it waits |
| In progress | Current step ticked forward; the selected target is framed and labelled |
| Device offline (scale, printer) | Says so in words; the manual path becomes the filled button |
| Rejected scan | Red tile: why, then what to do, in the feedback tile |
| Warning / over limit | Band colour + shape + words, a warning next step line, the blocked action restyled |
| Held / needs a manager | The panel takes the top of the work area, with the manager path (PIN or account) |
| Done / signed off | Green confirmation in the feedback area; the next action is live |
| Offline / N pending | Connection chip state; controls that need the server say so |

### Wave (#127)

How Wave meets each state above (gallery: `/dev/station-gallery/wave-<state>`):

| State | Wave |
| --- | --- |
| Loading | `loading`: queue and card skeletons |
| Operator needed | `pin` |
| Nothing open / queue empty | `no-selection` (tap orders or Suggest FIFO fill); `empty-queue` (orders come from the Intake station) |
| Empty item | `started`: a wave with no totes scanned; every tote expected, Complete says why it waits |
| In progress | `selecting` (tapped orders framed, *Added*), `scanning` (count and per-order tote ticks) |
| Device offline | `manual-tote`: Wave has no scale or printer; with the scanner down, Enter manually reads the tote number |
| Rejected scan | `rejected` |
| Warning / over limit | `refused`: a refused Complete leads the next step line in red, Complete is restyled, Cancel wave becomes the filled button. The weight target is a suggestion, so the tapped weight is shown against it with no verdict |
| Held / needs a manager | Not at Wave: no manager gate, and orders reach Wave before any variance hold. `draft` shows a wave whose start did not go through |
| Done | `done`: green confirmation, the next wave live |
| Offline / N pending | `offline`: Complete and Cancel need the server and say so |

### Boxing / will-call (#130)

How Boxing meets each state above (gallery: `/dev/station-gallery/boxing-<state>`). Boxes and
baskets are ticked on whole-row targets (the checkbox covers the row, ≥ 72 px), framed with
*Ticked*; the pick list's Lbs left sits on the line once the card is 600 px wide.

| State | Boxing |
| --- | --- |
| Loading | `loading`: party, boxes and pick list skeletons; notes and queue in the rail |
| Operator needed | `pin` |
| Nothing open / queue empty | `queue` (scan the receipt's boxing QR or tap a party); `empty-queue` (parties come from the counter); `not-found` (the party did not load: the receipt's QR, scanned or entered, opens it) |
| Empty item | `open`: nothing ticked; Complete says why it waits; *Tick every box* for a whole party |
| In progress | `ticking` (step 3 current, ticked rows framed, a split says what stays), `ready` (count green at parity) |
| Device offline | `manual`: no scale or printer (the pick list prints from the browser); with the scanner down, Enter manually reads the basket number |
| Rejected scan | `rejected` |
| Warning / over limit | `lbs-left` (the fault on its line, Complete says to fix it), `tote-left` (I8 refusal leads the next step line in red, the pick list framed red, Complete restyled) |
| Held / needs a manager | `held`: I8 with no basket left (DECISION-23); the override panel takes the top of the work, with the manager PIN |
| Done | `done`: green confirmation and what Complete did; the next receipt's QR opens the next party. `emptied`: handed over at another station, with the dropped ticks (I15) and dropped Complete lines still listed |
| Offline / N pending | `offline`: ticks keep working; Complete needs the server and says so |

`tools` shows Manager tools open (Release by tag, restore a released basket).

### Intake (#131)

Gallery: `/dev/station-gallery/intake-<state>`.

| State | Intake |
| --- | --- |
| Loading | `loading`: the form's cards and the price rail as placeholders |
| Operator needed | `signin`: no staff sign-in or paired tablet; Identify operator, **Staff sign in** / **Pair device**. The desk has no operator PIN: the sign-in is the operator |
| Nothing open / queue empty | `new` (a new order: find the customer); `orders-empty` (orders come from the Intake desk) |
| Empty item | `customer`: a customer and no lines; Condition and Method say what they wait for, the price says when it shows, Save says why it waits |
| In progress | `filling` (line 1 ticked green, the next step names line 2's lb), `ready` (live price, Save filled), `orders` |
| Device offline | `no-printer`: the tote printer is the desk's device; tags read **Not printed** and the next step line says to write the number on each tote (the manual path) |
| Rejected scan | `rejected`: no scanner, so the nearest case is a refused save: red in the status tile, why then what to do |
| Warning / over limit | `no-rate`: the rate card has no rate for a line; the next step line warns, Save is held and says why |
| Held / needs a manager | `unlock` (manager PIN sheet over a locked order), `unlocked` (the Unlocked panel takes the top of the form) |
| Done | `saved`: green in the status tile, every step ticked, New Intake filled |
| Offline / N pending | `offline`: Save needs the server and says so; nothing is queued on the tablet |

### Storage intake (#131)

Gallery: `/dev/station-gallery/storage-<state>`.

| State | Storage intake |
| --- | --- |
| Loading | `loading` |
| Operator needed | `signin` (as Intake) |
| Nothing open / queue empty | `new`; `queue-empty` (storage orders come from New Storage) |
| Empty item | `customer`: location, weight and description are optional on the server, so Confirm is live; the next step line says what usually comes next |
| In progress | `boxes`, `pickup` (boxes ticked, the quote, Create Pickup Batch filled), `charge`, `queue` |
| Device offline | `no-printer`: the status tile says no label printer is set up; Reprint Labels retries |
| Rejected scan | `typed-box`: a typed box code from another order, refused in the status tile; `rejected` (Confirm refused) |
| Warning / over limit | `bad-weight`: a weight that is not a number warns and holds Confirm |
| Held / needs a manager | `release` (Force Release / COMP panel at the top: reason, then **Manager PIN…**), `release-pin` |
| Done | `stored`: green "STG-0009 stored; 3 box labels queued." |
| Offline / N pending | `offline`: Confirm needs the server and says so |

## Keyboard stations

Intake and Storage intake are typed at a desk on the floor, so they are built from this system
with three differences from the scan stations (WP-07: the always-focused scanner input would take
the keyboard away from the form):

- **No scanner input.** `StationShell scanner={false}`: the console bar, step row and next step
  line stay; there is no `ScanInput` and no shell **Enter manually** (a station that reads a
  printed code, as Storage pickup does for box labels, puts its own `ManualEntry` where the codes
  are). Focus moves with the form instead: to the next field the order needs once one is filled.
- **The status column says what a save did.** `KeyboardStatus` takes the scan tile's place and
  height: green for a save or print, red with why and what to do; idle it reads *Keyboard ready*.
- **The forward action waits and says why.** Save / Confirm stay disabled with the reason
  (`DisabledReason`) in the same words as the next step line, rather than refusing after the tap.

Everything else is the floor's: 56 px targets for every field, tick and button (hero 72 px),
18 px text minimum, colour plus shape plus words, the states table above, and no sideways
scrolling at 400 px or 1280 × 800.

## Layout

- **Landscape tablet (1280 × 800)** is the primary target: queue rail + work area, no scroll for
  the common path.
- **Floor layout classes:** `st-floor` holds `st-main` (the work: first in the markup, a size
  container) and an optional `st-rail` (left of the work from 1100 px, after it on a phone);
  `st-columns` puts two lists side by side once `st-main` is 760 px wide (Blast, Locate).
  Reconcile's `rc-floor` is the same grid.
- **Phone (400 px)**: a single column with the hero controls right under the item header; the
  forward action pins to the bottom only when it can be used.
- No horizontal scrolling at either size, in any state. Containers use `minmax(0, 1fr)` and
  wrap; long codes may break, never overflow.
- Reflow uses container queries and `:has()` (current Chrome / Safari / Edge).
- `apps/web/e2e/station-gallery.spec.ts` checks every gallery page at both sizes: no sideways
  scroll, and every button, link and field in `.station` at least 56 × 56 px (the hidden scanner
  input excepted). A rule that sets a smaller `min-height` on a control fails it.
