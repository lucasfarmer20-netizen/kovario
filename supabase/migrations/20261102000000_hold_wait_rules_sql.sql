-- GENERATED from packages/rules/src/variance-sql.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.
-- What a variance hold waits on (#93, docs/08 DECISION-27, variance.ts):
--   app.variance_hold_wait_text        — holdWaitingOn's reason + holdWaitText, one member;
--   app.variance_hold_wait_list        — joinWaitTexts;
--   app.variance_hold_waiting_message  — holdWaitingMessage.

-- One member keeping the hold open: "INT-0003 (not at reconcile yet)", "INT-0004 (+22%)".
create or replace function app.variance_hold_wait_text(
  p_number text, p_state public.intake_state, p_actual numeric, p_variance_pct numeric
)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_number || ' (' || case
    when p_state in ('draft', 'holding', 'processing', 'rollstock') then 'not at reconcile yet'
    when round(coalesce(p_actual, 0), 2) = 0 then 'not weighed yet'
    else app.format_variance(p_variance_pct)
  end || ')'
$$;

-- "A", "A and B", "A, B and C".
create or replace function app.variance_hold_wait_list(p_texts text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(cardinality(p_texts), 0) <= 1 then coalesce(p_texts[1], '')
    else array_to_string(p_texts[1:cardinality(p_texts) - 1], ', ') || ' and '
      || p_texts[cardinality(p_texts)]
  end
$$;

-- Why an order whose own hold is active, though it is not over the limit, is refused; null
-- when it is over (that refusal names its own variance).
create or replace function app.variance_hold_waiting_message(p_number text, p_band text, p_waits text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_band = 'over' then null else
    p_number || ' ' || case when p_band = 'unknown'
      then 'has no expected yield to compare' else 'is within the limit' end || '.' ||
    case when coalesce(cardinality(p_waits), 0) = 0 then ' The rest of its hold group is within the limit too. Send to Blast clears the hold.'
      else ' Hold waits on ' || app.variance_hold_wait_list(p_waits) || '. It clears when they are at reconcile within the limit, or a manager signs off.' end
  end
$$;

revoke all on function app.variance_hold_wait_text(text, public.intake_state, numeric, numeric),
  app.variance_hold_wait_list(text[]), app.variance_hold_waiting_message(text, text, text[])
  from public;
grant execute on function app.variance_hold_wait_text(text, public.intake_state, numeric, numeric),
  app.variance_hold_wait_list(text[]), app.variance_hold_waiting_message(text, text, text[])
  to authenticated, service_role;
