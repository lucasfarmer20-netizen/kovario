// Renders the transition table as the SQL seed WP-03's guard trigger loads. Pure: the
// gen:states script writes it to disk and a test fails when the committed file is stale.
import { ENTITIES, TRANSITIONS, type Entity, type Transition } from "./states.ts";

export const STATE_TRANSITIONS_SQL_PATH = "supabase/seed/state_transitions.sql";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderStateTransitionsSql(): string {
  const rows = ENTITIES.flatMap((entity) =>
    (TRANSITIONS[entity] as readonly Transition<Entity>[]).map((t) => ({ entity, ...t })),
  );
  const values = rows.map((r, i) => {
    const sep = i === rows.length - 1 ? ";" : ",";
    const note = r.manager ? " -- manager" : "";
    return `  (${literal(r.entity)}, ${literal(r.from)}, ${literal(r.to)})${sep}${note}`;
  });
  return [
    "-- GENERATED from packages/rules/src/states.ts — do not edit by hand.",
    "-- Regenerate with `pnpm --filter rules gen:states`; a rules test fails when this is stale.",
    "-- Allowed state transitions (docs/03-STATE-MACHINES.md) for state_transition_guard().",
    "-- Rows marked `manager` are manager-only in canTransition(); the function performing",
    "-- the transition enforces the role.",
    "",
    "delete from state_transitions;",
    "",
    "insert into state_transitions (entity, from_state, to_state) values",
    ...values,
    "",
  ].join("\n");
}
