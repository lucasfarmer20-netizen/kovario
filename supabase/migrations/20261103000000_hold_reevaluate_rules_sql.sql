-- GENERATED from packages/rules/src/variance-sql.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.
-- When a variance hold is re-evaluated (#95, docs/08 DECISION-27, variance.ts):
--   app.variance_hold_judgement     — holdJudgement: awaiting | judged | not_judged;
--   app.variance_hold_reevaluate_on — holdReevaluateOn (an intake state change).

-- How a hold judges a member in this state.
create or replace function app.variance_hold_judgement(p_state public.intake_state)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_state in ('draft', 'holding', 'processing', 'rollstock') then 'awaiting'
    when p_state = 'reconcile' then 'judged' else 'not_judged' end
$$;

-- A state change that can clear a hold the intake belongs to: it changes how the hold judges it.
create or replace function app.variance_hold_reevaluate_on(
  p_from public.intake_state, p_to public.intake_state
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select app.variance_hold_judgement(p_from) <> app.variance_hold_judgement(p_to)
$$;

revoke all on function app.variance_hold_judgement(public.intake_state),
  app.variance_hold_reevaluate_on(public.intake_state, public.intake_state) from public;
grant execute on function app.variance_hold_judgement(public.intake_state),
  app.variance_hold_reevaluate_on(public.intake_state, public.intake_state)
  to authenticated, service_role;
