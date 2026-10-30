// Renders the transition table as the SQL migration that fills app.state_transitions, read by
// WP-03's state_transition_guard(). Pure: the gen:states script writes it to disk and a test
// fails when the committed file is stale. Shipping it as a migration means every environment
// gets the edges with the schema; the statement is idempotent (upsert + prune), so the table
// always equals TRANSITIONS after it runs.
import { ENTITIES, TRANSITIONS, type Entity, type Transition } from "./states.ts";

// Moved to a new migration whenever the table changes (an applied migration never runs again);
// the statement upserts and prunes, so the latest copy alone makes the table equal TRANSITIONS.
// 20261026100100_state_transitions.sql (WP-04) is the first copy; #88 added the pull back.
export const STATE_TRANSITIONS_SQL_PATH = "supabase/migrations/20261031000100_state_transitions.sql";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderStateTransitionsSql(): string {
  const rows = ENTITIES.flatMap((entity) =>
    (TRANSITIONS[entity] as readonly Transition<Entity>[]).map((t) => ({ entity, ...t })),
  );
  const values = rows.map((r, i) => {
    const sep = i === rows.length - 1 ? "" : ",";
    return `  (${literal(r.entity)}, ${literal(r.from)}, ${literal(r.to)}, ${r.manager ? "true" : "false"})${sep}`;
  });
  return [
    "-- GENERATED from packages/rules/src/states.ts — do not edit by hand.",
    "-- Regenerate with `pnpm --filter rules gen:states`; a rules test fails when this is stale.",
    "-- Allowed state transitions (docs/03-STATE-MACHINES.md) for state_transition_guard().",
    "-- `manager` edges are manager-only in canTransition(); the function performing the",
    "-- transition enforces the role. Idempotent: upserts every edge and deletes edges that are",
    "-- no longer in states.ts, so the table equals the generated set.",
    "",
    "with generated (entity, from_state, to_state, manager) as (values",
    ...values,
    "), pruned as (",
    "  delete from app.state_transitions t",
    "  where not exists (",
    "    select 1 from generated g",
    "    where g.entity = t.entity and g.from_state = t.from_state and g.to_state = t.to_state",
    "  )",
    ")",
    "insert into app.state_transitions (entity, from_state, to_state, manager)",
    "select entity, from_state, to_state, manager from generated",
    "on conflict (entity, from_state, to_state) do update set manager = excluded.manager;",
    "",
  ].join("\n");
}
