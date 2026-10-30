// State machines (docs/03-STATE-MACHINES.md) as allowed-transition tables. The DB guard
// trigger reads the same table, filled by the migration
// `supabase/migrations/20261031000100_state_transitions.sql` (STATE_TRANSITIONS_SQL_PATH;
// earlier copies stay as applied), generated from this file by
// `pnpm --filter rules gen:states` — never edit the SQL by hand.
//
// Guards that need data (tote completeness, close gate I10, wave parity) live in the SQL
// functions that perform the transition; this table only says which edges exist.
// Self-loops (`partial → partial`, a vessel split keeping `occupied`) are updates, not
// transitions, and are not listed.

export const STATES = {
  intake: [
    "draft",
    "holding",
    "processing",
    "rollstock",
    "reconcile",
    "blast_freezer",
    "stored",
    "done",
    "cancelled",
  ],
  storage_intake: ["draft", "stored", "partial", "released", "cancelled"],
  storage_pickup_batch: ["pending", "released", "void"],
  storage_box: ["stored", "released"],
  wave: ["draft", "verifying", "done", "cancelled"],
  asset_tag: ["available", "in_use", "retired"],
  vessel: ["occupied", "emptied", "void"],
  box_plan: ["planned", "packed", "shipped", "picked_up"],
  allocation_session: ["draft", "priced", "done", "cancelled"],
  settlement: ["draft", "paid"],
  shipment: ["draft", "held", "label_bought", "shipped", "cancelled"],
  payment: [
    "pending",
    "approved",
    "declined",
    "cancelled",
    "indeterminate",
    "error",
    "voided",
    "refunded",
  ],
  register_order: ["open", "paid", "void"],
  print_job: ["queued", "printing", "done", "failed"],
} as const;

export type Entity = keyof typeof STATES;
export type StateOf<E extends Entity> = (typeof STATES)[E][number];

export const ENTITIES = Object.keys(STATES) as Entity[];

/** Column holding the state, where it is not `state` (docs/02-DOMAIN-MODEL.md). */
export const STATE_COLUMN: Readonly<Record<Entity, string>> = {
  ...(Object.fromEntries(ENTITIES.map((e) => [e, "state"])) as Record<Entity, string>),
  vessel: "lifecycle_state",
  box_plan: "fulfillment_state",
};

export interface Transition<E extends Entity> {
  from: StateOf<E>;
  to: StateOf<E>;
  /** Only a manager may take this edge (the doc marks it "manager"). */
  manager?: true;
}

type Table = { [E in Entity]: readonly Transition<E>[] };

const INTAKE_NON_TERMINAL = [
  "draft",
  "holding",
  "processing",
  "rollstock",
  "reconcile",
  "blast_freezer",
  "stored",
] as const;

export const TRANSITIONS: Table = {
  intake: [
    { from: "draft", to: "holding" }, // save & print
    { from: "holding", to: "processing" }, // wave complete / rollstock bypass (audited)
    { from: "processing", to: "rollstock" }, // rollstock scan
    { from: "rollstock", to: "reconcile" }, // next scan or finish (tote completeness)
    { from: "reconcile", to: "blast_freezer" }, // send to blast
    { from: "blast_freezer", to: "stored" }, // first locate placement
    { from: "stored", to: "done" }, // close gate I10
    { from: "blast_freezer", to: "done" }, // close gate I10 (state ∈ {stored, blast_freezer})
    { from: "blast_freezer", to: "reconcile", manager: true }, // pull back from blast (#88)
    ...INTAKE_NON_TERMINAL.map((from) => ({
      from,
      to: "cancelled" as const,
      manager: true as const,
    })),
  ],
  storage_intake: [
    { from: "draft", to: "stored" }, // confirm
    { from: "stored", to: "partial" }, // batch released, some boxes left
    { from: "stored", to: "released" }, // batch released, no boxes left
    { from: "partial", to: "released" },
  ],
  storage_pickup_batch: [
    { from: "pending", to: "released" }, // payment / manager release
    { from: "pending", to: "void" }, // supersede / cancel
    { from: "void", to: "released", manager: true }, // manager force release
  ],
  storage_box: [{ from: "stored", to: "released" }], // by a batch release only
  wave: [
    { from: "draft", to: "verifying" },
    { from: "verifying", to: "done" }, // scanned_totes = expected_totes
    { from: "draft", to: "cancelled" },
    { from: "verifying", to: "cancelled" },
  ],
  asset_tag: [
    { from: "available", to: "in_use" }, // scanned onto a vessel at reconcile
    { from: "in_use", to: "available" }, // emptied / freed / row removed before send
    { from: "available", to: "retired" },
    { from: "retired", to: "available" }, // reactivate
  ],
  vessel: [
    { from: "occupied", to: "emptied" }, // full pull
    { from: "occupied", to: "void", manager: true },
    { from: "emptied", to: "void", manager: true },
    { from: "emptied", to: "occupied", manager: true }, // restore (release_audit 'restored')
  ],
  box_plan: [
    { from: "planned", to: "packed" }, // ship
    { from: "packed", to: "shipped" },
    { from: "planned", to: "picked_up" }, // air / will-call
  ],
  allocation_session: [
    { from: "draft", to: "priced" },
    { from: "priced", to: "done" }, // fulfillment rollup = released
    { from: "draft", to: "cancelled" },
    { from: "priced", to: "cancelled" },
    { from: "done", to: "cancelled" }, // "any → cancelled"
  ],
  settlement: [{ from: "draft", to: "paid" }],
  shipment: [
    { from: "draft", to: "held" }, // ship_date > today + buy_window
    { from: "draft", to: "label_bought" },
    { from: "held", to: "label_bought" }, // incl. manager "buy now"
    { from: "label_bought", to: "shipped" },
    { from: "draft", to: "cancelled" }, // "any → cancelled"
    { from: "held", to: "cancelled" },
    { from: "label_bought", to: "cancelled" },
    { from: "shipped", to: "cancelled" },
  ],
  payment: [
    { from: "pending", to: "approved" },
    { from: "pending", to: "declined" },
    { from: "pending", to: "cancelled" }, // cashier cancel / terminal 1012
    { from: "pending", to: "indeterminate" }, // timeout / ambiguous
    { from: "pending", to: "error" }, // transport / config error
    { from: "indeterminate", to: "approved" }, // status check
    { from: "indeterminate", to: "declined" },
    { from: "indeterminate", to: "cancelled" },
    { from: "approved", to: "voided", manager: true }, // reverse
    { from: "approved", to: "refunded", manager: true }, // reverse
  ],
  register_order: [
    { from: "open", to: "paid" },
    { from: "open", to: "void" },
  ],
  print_job: [
    { from: "queued", to: "printing" },
    { from: "printing", to: "done" },
    { from: "printing", to: "failed" },
    { from: "failed", to: "queued" }, // retry
  ],
};

export interface TransitionContext {
  isManager?: boolean;
}

function find<E extends Entity>(entity: E, from: string, to: string): Transition<E> | undefined {
  const edges = TRANSITIONS[entity] as readonly Transition<E>[];
  return edges.find((t) => t.from === from && t.to === to);
}

/** Whether `from → to` is an allowed edge for `entity` (and, if manager-only, ctx is a manager). */
export function canTransition<E extends Entity>(
  entity: E,
  from: StateOf<E>,
  to: StateOf<E>,
  ctx: TransitionContext = {},
): boolean {
  const edge = find(entity, from, to);
  return edge !== undefined && (!edge.manager || ctx.isManager === true);
}

/** States reachable from `from` in one step, in table order. */
export function nextStates<E extends Entity>(
  entity: E,
  from: StateOf<E>,
  ctx: TransitionContext = {},
): StateOf<E>[] {
  return (TRANSITIONS[entity] as readonly Transition<E>[])
    .filter((t) => t.from === from && (!t.manager || ctx.isManager === true))
    .map((t) => t.to);
}

/** States with no outgoing edge. */
export function isTerminal<E extends Entity>(entity: E, state: StateOf<E>): boolean {
  return !(TRANSITIONS[entity] as readonly Transition<E>[]).some((t) => t.from === state);
}
