-- GENERATED from packages/rules/src/suspects-sql.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.
-- Suspect picker, move bin, pull back from blast (#88, docs/04-BUSINESS-RULES.md §6b, suspects.ts):
--   app.suspect_status        — suspectStatus;
--   app.suspect_waiting       — suspectWaiting (SUSPECT_WAITING);
--   app.bin_movable           — binMovable (MOVE_BIN_STATES);
--   app.pull_back_problem     — pullBackProblem (PULL_BACK_FROM → PULL_BACK_TO).

-- Reconciled: at reconcile with at least one occupied vessel, every one weighed.
create or replace function app.suspect_status(
  p_state public.intake_state, p_vessels int, p_unweighed int
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_state
    when 'draft' then 'upstream'
    when 'holding' then 'upstream'
    when 'processing' then 'upstream'
    when 'rollstock' then 'upstream'
    when 'reconcile' then case when coalesce(p_vessels, 0) > 0 and coalesce(p_unweighed, 0) = 0 then 'reconciled' else 'at_reconcile' end
    when 'blast_freezer' then 'in_blast'
    when 'stored' then 'stored'
    when 'done' then 'stored'
    when 'cancelled' then 'cancelled'
  end
$$;

-- Not yet reconciled: suggestions wait for every one of these.
create or replace function app.suspect_waiting(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_status in ('upstream', 'at_reconcile'), false)
$$;

-- A bin moves only between intakes in these states.
create or replace function app.bin_movable(p_state public.intake_state)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_state in ('reconcile'), false)
$$;

-- blast_freezer → reconcile, with a reason (≤ 500 characters).
create or replace function app.pull_back_problem(p_state public.intake_state, p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_reason, '') !~ '\S' then 'Pull back needs a reason'
    when length(p_reason) > 500 then 'Reason must be at most 500 characters'
    when p_state is distinct from 'blast_freezer' then 'Only an intake in the blast freezer can be pulled back'
  end
$$;

revoke all on function app.suspect_status(public.intake_state, int, int),
  app.suspect_waiting(text), app.bin_movable(public.intake_state),
  app.pull_back_problem(public.intake_state, text) from public;
grant execute on function app.suspect_status(public.intake_state, int, int),
  app.suspect_waiting(text), app.bin_movable(public.intake_state),
  app.pull_back_problem(public.intake_state, text) to authenticated, service_role;
