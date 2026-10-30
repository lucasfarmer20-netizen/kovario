// Renders the SQL forms of the suspect picker, move bin and pull back rules (suspects.ts) that
// public.variance_suspect_group, variance_move_vessel and intake_pull_back apply inside the
// database. Like variance-sql.ts this is the only place that SQL is written: `pnpm --filter
// rules gen:sql` writes the migration, a rules test fails when the committed file is stale, and
// packages/db suspects.db.test.ts checks the SQL agrees with suspects.ts on a grid. Ranking and
// move suggestions are pure TS (the picker); the database does not rank.
import {
  MOVE_BIN_STATES,
  PULL_BACK_FROM,
  PULL_BACK_NEEDS_REASON,
  PULL_BACK_NOT_IN_BLAST,
  PULL_BACK_REASON_MAX,
  PULL_BACK_REASON_TOO_LONG,
  PULL_BACK_TO,
  SUSPECT_WAITING,
  suspectStatus,
} from "./suspects.ts";
import { STATES } from "./states.ts";

export const SUSPECTS_SQL_PATH = "supabase/migrations/20261031000000_suspect_rules_sql.sql";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function states(list: readonly string[]): string {
  return list.map(literal).join(", ");
}

/** One `when` per intake state, each status taken from suspectStatus itself. */
function statusArms(): string[] {
  return STATES.intake.map((state) => {
    const complete = suspectStatus(state, 1, 0);
    const incomplete = suspectStatus(state, 0, 0);
    if (suspectStatus(state, 2, 1) !== incomplete)
      throw new Error(`suspectStatus(${state}) depends on more than complete vs not`);
    return complete === incomplete
      ? `    when ${literal(state)} then ${literal(complete)}`
      : `    when ${literal(state)} then case when coalesce(p_vessels, 0) > 0 and coalesce(p_unweighed, 0) = 0 then ${literal(complete)} else ${literal(incomplete)} end`;
  });
}

export function renderSuspectsSql(): string {
  return [
    "-- GENERATED from packages/rules/src/suspects-sql.ts — do not edit by hand.",
    "-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.",
    "-- Suspect picker, move bin, pull back from blast (#88, docs/04-BUSINESS-RULES.md §6b, suspects.ts):",
    "--   app.suspect_status        — suspectStatus;",
    "--   app.suspect_waiting       — suspectWaiting (SUSPECT_WAITING);",
    "--   app.bin_movable           — binMovable (MOVE_BIN_STATES);",
    "--   app.pull_back_problem     — pullBackProblem (PULL_BACK_FROM → PULL_BACK_TO).",
    "",
    "-- Reconciled: at reconcile with at least one occupied vessel, every one weighed.",
    "create or replace function app.suspect_status(",
    "  p_state public.intake_state, p_vessels int, p_unweighed int",
    ")",
    "returns text",
    "language sql",
    "immutable",
    "set search_path = ''",
    "as $$",
    "  select case p_state",
    ...statusArms(),
    "  end",
    "$$;",
    "",
    "-- Not yet reconciled: suggestions wait for every one of these.",
    "create or replace function app.suspect_waiting(p_status text)",
    "returns boolean",
    "language sql",
    "immutable",
    "set search_path = ''",
    "as $$",
    `  select coalesce(p_status in (${states(SUSPECT_WAITING)}), false)`,
    "$$;",
    "",
    "-- A bin moves only between intakes in these states.",
    "create or replace function app.bin_movable(p_state public.intake_state)",
    "returns boolean",
    "language sql",
    "immutable",
    "set search_path = ''",
    "as $$",
    `  select coalesce(p_state in (${states(MOVE_BIN_STATES)}), false)`,
    "$$;",
    "",
    `-- ${PULL_BACK_FROM} → ${PULL_BACK_TO}, with a reason (≤ ${PULL_BACK_REASON_MAX} characters).`,
    "create or replace function app.pull_back_problem(p_state public.intake_state, p_reason text)",
    "returns text",
    "language sql",
    "immutable",
    "set search_path = ''",
    "as $$",
    "  select case",
    `    when coalesce(p_reason, '') !~ '\\S' then ${literal(PULL_BACK_NEEDS_REASON)}`,
    `    when length(p_reason) > ${PULL_BACK_REASON_MAX} then ${literal(PULL_BACK_REASON_TOO_LONG)}`,
    `    when p_state is distinct from ${literal(PULL_BACK_FROM)} then ${literal(PULL_BACK_NOT_IN_BLAST)}`,
    "  end",
    "$$;",
    "",
    "revoke all on function app.suspect_status(public.intake_state, int, int),",
    "  app.suspect_waiting(text), app.bin_movable(public.intake_state),",
    "  app.pull_back_problem(public.intake_state, text) from public;",
    "grant execute on function app.suspect_status(public.intake_state, int, int),",
    "  app.suspect_waiting(text), app.bin_movable(public.intake_state),",
    "  app.pull_back_problem(public.intake_state, text) to authenticated, service_role;",
    "",
  ].join("\n");
}
