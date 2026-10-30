# Filletry — Floor wording and next-step prompts

v1.2 (#98, decided 2026-10-30). One vocabulary on every floor screen, receipt and the customer
status page, and a prompt on every station that walks the operator through it in order.
`docs/06-STATIONS-UX.md` describes the stations; this file decides the words they use.

Code identifiers, DB columns and enum values do **not** change (`intake`, `vessel`, `asset_tag`,
`location`, …). Operator-facing text does, including the `reason` text scan RPCs return.

## Vocabulary (floor screens, receipts, status page)

| Say                                    | Never say on the floor           | Meaning                                                                                    |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| **order** (`Order INT-0002`)           | intake                           | A customer's batch of fish. Code/DB names stay `intake`. The Intake _station_ keeps its name. |
| **tote** (`Tote INT-0002-1`)           | tote tag, numbered tote label    | The numbered tote from intake.                                                             |
| **basket** (`Basket 005`)              | vessel, bin, tag, asset tag      | The reusable tagged container. Its tag is how you scan it, not its name.                   |
| **exchange basket**                    | exchange vessel, no tag          | An untagged basket.                                                                        |
| **location** (`Location IF-A-01-1-F`)  | slot, code                       | Shelf or pallet position.                                                                  |
| **box** (`Box STG-0001-2`)             | storage box label                | Storage/ship box.                                                                          |

Verbs: **Scan** (barcode), **Enter** (type it), **Tap** (choose on screen), **Weigh**. Admin may
say "basket tags" for the printable tag pool (not "asset tag pool").

## Prompt grammar

1. **Next step line.** Every floor station shows one line, the largest text on screen, in the
   status area: imperative verb + object, naming the specific thing when known. It replaces
   "Ready to scan". e.g. "Scan a tote", "Scan basket", "Weigh basket 005", "Scan location for
   basket 005". (`<StationShell next=…>`.)
2. **Enter manually.** The typed-code button is **Enter manually**, shown directly under the next
   step line. The field's label names what's expected: "Basket number", "Tote number
   (INT-0002-1)", "Location (IF-A-01-1-F)". Its submit button is **Enter**.
3. **Steps.** Stations with more than one step show them in a row with the current one
   highlighted, e.g. Reconcile: `1 Add baskets · 2 Weigh · 3 Send to Blast`.
   (`<StationShell steps=… step=…>`.)
4. **Accept feedback says what happened**, noun first: "Basket 005 added to INT-0002". **Reject
   feedback says why, then what to do**: "Basket 005 is already on INT-0001. Scan a different
   basket."
5. **Disabled buttons say why** in helper text under them (not a tooltip): "Tap a basket first",
   "Weigh every basket first". (`<DisabledReason>`.)
6. **No verdict without data.** Don't show a variance, band or warning until there is something
   to judge (#97).

## Station flows (next step line, in order)

- **Wave:** "Tap orders to add to the wave" → "Scan each tote (3 of 5)" → "Complete wave".
- **Rollstock:** "Scan the next tote" · open panel: "Order INT-0002 · tote 1 of 2".
- **Reconcile:** "Scan a tote or tap an order" → "Scan basket" → "Weigh basket 005" → "Send to
  Blast" (over the limit: "Over the limit (−18%). Check weights before sending."). "Weigh" names only the
  selected basket (the one Accept / Enter weight write to); with another basket still unweighed it
  reads "Tap basket 006, then weigh it".
- **Blast:** "Scan a basket going into the blast" · exchange baskets: "Tap Blast in for an
  exchange basket".
- **Locate:** "Scan basket" (or "Tap an exchange basket") → "Scan location for basket 005".
- **Boxing:** "Scan the boxing QR or tap an order" → "Tick each box and basket" → "Complete".
- **Storage pickup / pairing / other scan points:** same grammar.

## Enforcement

Two lint-style tests fail on a banned word (vessel, bin, asset tag, intake as a noun, "Type code",
"Ready to scan"):

- `apps/web/src/components/station/floor-wording.test.ts`: every string literal and JSX text in
  the floor-station components, the shared primitives, the receipts and the status page.
- `supabase/tests/29_floor_wording.test.sql`: every quoted text in the floor RPCs and every
  function they call (the `reason` / message text operators see).
