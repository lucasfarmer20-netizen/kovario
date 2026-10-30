-- v1.2 (#93, docs/08 DECISION-27): Send to Blast on an order whose own hold is still active,
-- although the order is no longer over the limit, is refused with the hold's waiting-on list:
-- "INT-0002 is within the limit. Hold waits on INT-0003 (not at reconcile yet) and INT-0004
-- (+22%). It clears when …". The list and the text are rules (variance.ts holdWaitingOn /
-- holdWaitingMessage), generated into 20261102000000_hold_wait_rules_sql.sql; this file only
-- feeds them the hold's group. It replaces the hand-written app.variance_hold_waiting_on.
--
-- variance_hold_member gains `signed_off` (the member's variance is signed off at its current
-- weight), so the reconcile screen can show the same line before Send through holdWaitingOn.

-- The other members keeping p_hold open, in rollstock order, as wait texts (rules: holdWaitingOn,
-- memberKeepsHoldOpen, holdWaitText).
create or replace function app.variance_hold_waits(p_hold public.variance_hold)
returns text[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(
      app.variance_hold_wait_text(iv.number, iv.state, iv.actual_lb, iv.variance_pct)
      order by g.ord), '{}')
  from unnest(app.variance_hold_group_of(p_hold)) with ordinality g(intake_id, ord)
  join public.intake_variance iv on iv.intake_id = g.intake_id and iv.org_id = p_hold.org_id
  where g.intake_id <> p_hold.intake_id and app.variance_member_open(iv)
$$;
revoke all on function app.variance_hold_waits(public.variance_hold) from public;

-- Re-create reconcile_action from its current definition with an exact replacement (as
-- 20261101000100_floor_wording.sql). Raises if the old text is missing, unless the new text is
-- already there (re-run).
create or replace function pg_temp.reword(p_fn regprocedure, variadic p_pairs text[])
returns void
language plpgsql
as $$
declare
  v_def text := pg_get_functiondef(p_fn);
  v_n int;
begin
  for v_n in 1 .. cardinality(p_pairs) / 2 loop
    if strpos(v_def, p_pairs[2 * v_n - 1]) > 0 then
      v_def := replace(v_def, p_pairs[2 * v_n - 1], p_pairs[2 * v_n]);
    elsif strpos(v_def, p_pairs[2 * v_n]) = 0 then
      raise exception 'reword(%): text not found: %', p_fn, p_pairs[2 * v_n - 1];
    end if;
  end loop;
  execute v_def;
end;
$$;

select pg_temp.reword('public.reconcile_action(text,uuid,text,uuid,text,numeric,uuid,text,jsonb)',
  $o$    elsif blocking.intake_id=i.id and iv.band in ('within','near') then
     -- Back within the limit, but the hold waits on neighbours (docs/08 DECISION-27).
     reason:=format('Variance hold: %s is back within the limit (%s); waiting on %s. The hold clears when they are within the limit, or a manager signs off',
       i.number,app.format_variance(iv.variance_pct),app.variance_hold_waiting_on(blocking));
    elsif blocking.intake_id=i.id then
     -- No expected yield any more (band unknown): nothing to be within, so name the neighbours only.
     reason:=format('Variance hold: %s has no expected yield to compare; waiting on %s. The hold clears when they are within the limit, or a manager signs off',
       i.number,app.variance_hold_waiting_on(blocking));
$o$,
  $n$    elsif blocking.intake_id=i.id then
     -- Not over the limit (within, near, or no expected yield), but its hold waits on neighbours
     -- (docs/08 DECISION-27): name each one and why (#93; rules: holdWaitingMessage).
     reason:=app.variance_hold_waiting_message(i.number,iv.band,app.variance_hold_waits(blocking));
$n$);

drop function if exists app.variance_hold_waiting_on(public.variance_hold);

-- As 20261030000100_variance_hold.sql, plus `signed_off` (rules: memberKeepsHoldOpen's input).
create or replace view public.variance_hold_member with (security_invoker = true) as
select h.id as hold_id, h.org_id, h.state as hold_state, h.intake_id as flagged_intake_id,
  g.intake_id, (g.ord - array_position(g.grp, h.intake_id))::int as position,
  iv.number as intake_number, iv.state, iv.expected_lb, iv.actual_lb, iv.variance_pct,
  iv.limit_pct, iv.band, app.variance_hold_blocks(iv.state) as blocked,
  app.variance_signed_off(iv.org_id, iv.intake_id, iv.actual_lb) as signed_off
from public.variance_hold h
cross join lateral (
  select x.intake_id, x.ord, grp.grp
  from (select app.variance_hold_group_of(h) as grp) grp
  cross join lateral unnest(grp.grp) with ordinality x(intake_id, ord)
) g
join public.intake_variance iv on iv.intake_id = g.intake_id and iv.org_id = h.org_id;
