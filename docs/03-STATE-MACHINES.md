# Filletry — State Machines

Implement each as a table of allowed transitions in `packages/rules/src/states.ts`
(`canTransition(entity, from, to, ctx)`), enforced again by a DB `check` trigger that
rejects any transition not in the table. Managers may force transitions through a
dedicated `force_transition` function that writes `action_log` with `reason`.

Every transition stamps its timestamp column (see `02-DOMAIN-MODEL.md`).

## Intake

```
draft ──save&print──▶ holding ──wave complete / rollstock bypass──▶ processing
processing ──rollstock scan──▶ rollstock ──next scan or finish──▶ reconcile
reconcile ──send to blast──▶ blast_freezer ──locate scan (first vessel stored)──▶ stored
stored ──close gate I10──▶ done
blast_freezer ──manager pull back + reason (v1.1, #88)──▶ reconcile
any non-terminal ──manager──▶ cancelled
```

Notes:
- The 48-hour hold is a **guideline**: `hold_until` is displayed and used for sorting
  (hours-in-cooler badge), never a gate. There is no `ready` state (CSP removed it).
- `holding → processing` via **rollstock bypass** (scanning a `holding` tote at
  rollstock) is allowed and writes an audit note on the intake. Do not "fix" it.
- Tote completeness (X of X scanned) is enforced before an intake may leave
  `rollstock` for `reconcile` unless a manager overrides.
- `blast_freezer → stored` happens on the **first** locate placement of any of the
  intake's vessels; `stored` persists while any vessel is `occupied`.
- **Close gate I10** (`try_close_after_release(intake_id)`): intake → `done` iff
  (a) state ∈ {stored, blast_freezer}; (b) it has ≥ 1 vessel; (c) all vessels are
  `emptied` or `void`; (d) every non-cancelled allocation session pooling it has zero
  `planned` boxes. Zero-vessel intakes never auto-close.
- **Pull back from blast** (v1.1, #88; `04-BUSINESS-RULES.md §6b`): `blast_freezer → reconcile`
  is a manager edge (`states.ts`), taken only by `intake_pull_back` with a reason (manager
  account or manager PIN elevation, DECISION-31) and logged in `intake_history` with who and
  when. The intake's vessels' `blast_in_at` / `blast_out_at` are cleared, so re-entering blast
  restarts blast time (`blast_at` is re-stamped by the next send); `rollstock_done_at` and
  `reconcile_at` keep their first values. A `stored` intake (a vessel on a shelf) cannot be
  pulled back.

## Variance hold (v1.1, #87)
```
(send over the limit) ──▶ active ──group back within the limit──▶ cleared (auto)
                          active ──manager sign-off + reason──▶ cleared (signoff)
```
While `active`, the hold's group members not yet sent to blast cannot leave `reconcile` for
`blast_freezer` (`04-BUSINESS-RULES.md §6a`). `cleared` is terminal; a new flag is a new row.

## Storage intake
```
draft ──confirm──▶ stored ──batch released (some boxes left)──▶ partial ──▶ partial …
stored | partial ──batch released (no boxes left)──▶ released
```

## Storage pickup batch
```
pending ──payment / manager release──▶ released       (terminal)
pending ──supersede / cancel──▶ void
void ──manager force release──▶ released
```

## Storage box
`stored → released` (by a batch release only; `released_at`, `released_by` set;
`days_stored` frozen).

## Wave
`draft → verifying → done`; `draft|verifying → cancelled`. Intakes lock to the wave on
`verifying`. `done` requires `scanned_totes = expected_totes`.

## Asset tag
```
available ──scanned onto a vessel at reconcile──▶ in_use ──vessel emptied / tag freed / vessel row removed before send──▶ available
available ──retire──▶ retired ──reactivate──▶ available
```
Binding an `in_use` tag raises with the holder's intake number. `retired` cannot bind.

## Vessel lifecycle_state (the occupancy backbone)
```
occupied ──full pull──▶ emptied     (tag freed, location cleared, weight → 0, snapshot kept)
occupied ──split R──▶ occupied     (tag KEPT, location cleared, weight := R)
occupied | emptied ──manager void──▶ void
emptied ──manager restore──▶ occupied   (writes release_audit 'restored')
```
Split is an **action**, not a state. `void` is never actionable and never evidence of fish.

## Box plan fulfillment_state
`planned → packed → shipped` (ship) ; `planned → picked_up` (air / will-call).
Release transitions only `planned`. Terminal states never roll back.

## Allocation session
`draft → priced → done`; any → `cancelled`. `done` when fulfillment rollup = released.

## Settlement (payment axis only)
`draft → paid`.

## Shipment
`draft → held` (ship_date > today+buy_window) ; `draft|held → label_bought → shipped`;
any → `cancelled`. Held and blocked are orthogonal: blockers are reported alongside the
held notice (I13b). Manager `buy now` overrides the date hold but preserves real
blockers (I14). Reprinting a bought label is always allowed.

## Payment
```
pending ──approved──▶ approved ──reverse──▶ voided | refunded
pending ──declined──▶ declined
pending ──cashier cancel / terminal 1012──▶ cancelled
pending ──timeout / ambiguous──▶ indeterminate ──status check──▶ approved | declined | cancelled
pending ──transport / config error──▶ error
```
Only `approved` settles charges. `indeterminate` **must** be resolved by a status
check before the register can retry; the retry increments `attempt` and uses a new
`provider_ref` so it can never collide with the first.

## Register order
`open → paid` ; `open → void`. Paid hooks run on insert-as-paid and on transition.

## Print job
`queued → printing → done | failed`; `failed → queued` (retry).
