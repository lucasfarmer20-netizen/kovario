-- GENERATED from packages/rules/src/suspects-sql.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.
-- Suspect picker, move bin, pull back from blast (#88, docs/04-BUSINESS-RULES.md §6b, suspects.ts):
--   app.suspect_status        — suspectStatus;
--   app.suspect_waiting       — suspectWaiting (SUSPECT_WAITING);
--   app.bin_movable           — binMovable (MOVE_BIN_STATES);
--   app.bin_move_problem      — binMoveProblem (at reconcile, not pooled);
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

-- Bins move into or out of an intake only at reconcile and while no allocation pools it.
create or replace function app.bin_move_problem(
  p_number text, p_state public.intake_state, p_pooling_sessions int
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when not app.bin_movable(p_state) and p_state = 'blast_freezer' then format('%s is in the blast freezer; pull it back to reconcile first', p_number)
    when not app.bin_movable(p_state) then format('%s is not at reconcile', p_number)
    when coalesce(p_pooling_sessions, 0) > 0 then format('%s is in a counter allocation; its bins cannot move', p_number)
  end
$$;

-- blast_freezer → reconcile, with a reason (≤ 500 characters), while every
-- vessel is still occupied and no allocation pools the intake.
create or replace function app.pull_back_problem(
  p_state public.intake_state, p_reason text, p_vessels_not_occupied int, p_pooling_sessions int
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_reason, '') !~ E'[^\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]' then 'Pull back needs a reason'
    when length(p_reason) > 500 then 'Reason must be at most 500 characters'
    when p_state is distinct from 'blast_freezer' then 'Only an intake in the blast freezer can be pulled back'
    when coalesce(p_vessels_not_occupied, 0) > 0 then 'Fish from this intake has already been released; it cannot be pulled back'
    when coalesce(p_pooling_sessions, 0) > 0 then 'This intake is in a counter allocation; it cannot be pulled back'
  end
$$;

revoke all on function app.suspect_status(public.intake_state, int, int),
  app.suspect_waiting(text), app.bin_movable(public.intake_state),
  app.bin_move_problem(text, public.intake_state, int),
  app.pull_back_problem(public.intake_state, text, int, int) from public;
grant execute on function app.suspect_status(public.intake_state, int, int),
  app.suspect_waiting(text), app.bin_movable(public.intake_state),
  app.bin_move_problem(text, public.intake_state, int),
  app.pull_back_problem(public.intake_state, text, int, int) to authenticated, service_role;
