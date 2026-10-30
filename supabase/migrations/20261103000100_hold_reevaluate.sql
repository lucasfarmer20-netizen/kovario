-- v1.2 (#95, docs/08 DECISION-27): keep variance holds current when their inputs change.
-- A hold was re-evaluated only when one of its intakes' weights changed (reconcile, #88's bin
-- move) or it was sent, so a neighbour reaching reconcile, a cancellation or a new
-- variance_hold_pct left the HELD badge and the hold row stale until someone touched an intake.
--
-- Choice: re-evaluate in the same transaction as the change (not "held" derived at read time).
-- variance_hold.state stays the one stored answer that realtime, sign-off, reports and #88's
-- picker already read; re-evaluation only ever clears (app.variance_holds_reevaluate, the rule
-- DECISION-27 already uses), and a newly flagged hold is always open on its own over intake.
--   * Intake state: an AFTER UPDATE OF state trigger on public.intake re-evaluates the holds whose
--     group holds the intake when the change alters how a hold judges it (rules:
--     holdReevaluateOn, generated as app.variance_hold_reevaluate_on): entering reconcile
--     (rollstock_scan_advance, intake_pull_back), leaving it (Send to Blast, a cancellation)
--     and a cancellation before reconcile. A trigger, so every writer is covered, including
--     force_transition (the manager cancellation path) and any later one.
--   * variance_hold_pct: admin_update_org re-evaluates every active hold of the org when the
--     limit changes, and returns how many cleared (`variance_holds_cleared`).
--   * Backfill: holds already stale when this migration runs are re-evaluated once, below.
-- Replays return the stored action result (action_begin) before any write, and re-evaluating a
-- cleared hold is a no-op, so nothing clears twice.
--
-- Lock order (AGENTS rule 3; #87, #88). Hold rows are always last, locked in id order:
--   intake state change: whatever the writer takes first (rollstock: wave → intakes; send and
--     pull back: the org's variance lock → reconcile lock → vessels → intake; force_transition:
--     the intake) → the trigger → variance_hold rows (ids).
--   settings: action_log (key-shares the org row) → org row FOR UPDATE → the org's variance
--     advisory lock → variance_hold rows (ids). Sends, sign-offs, bin moves and pull backs also
--     key-share the org row (action_begin) before the variance lock, so the org row always comes
--     first and no cycle forms; a send flagging under the old limit has either committed (and
--     is re-evaluated here) or waits on the org row and reads the new limit.

-- Re-evaluation for an explicit org ------------------------------------------------------------
-- As 20261030000100_variance_hold.sql, with the org passed in, so the intake trigger and the
-- backfill use the row's org rather than the caller's claims. The one-argument form keeps its
-- callers (reconcile_action, variance_move_vessel) on app.org_id().
create or replace function app.variance_holds_reevaluate(p_org_id uuid, p_intake_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare h public.variance_hold; v_group uuid[]; v public.intake_variance; n int := 0;
begin
  for h in select * from public.variance_hold vh where vh.org_id = p_org_id and vh.state = 'active'
      and (p_intake_ids is null or app.variance_hold_group_of(vh) && p_intake_ids)
      order by vh.id for update loop
    v_group := app.variance_hold_group_of(h);
    continue when not app.variance_group_within(h.org_id, v_group);
    select * into v from public.intake_variance where intake_id = h.intake_id and org_id = h.org_id;
    update public.variance_hold set state = 'cleared', clear_kind = 'auto', cleared_at = now(),
      cleared_actual_lb = v.actual_lb, cleared_variance_pct = v.variance_pct
    where id = h.id;
    perform app.emit_event(h.org_id, 'variance_hold_cleared', h.intake_id,
      jsonb_build_object('hold_id', h.id, 'kind', 'auto', 'group', to_jsonb(v_group),
        'variance_pct', v.variance_pct));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app.variance_holds_reevaluate(p_intake_ids uuid[])
returns int language sql security definer set search_path = '' as $$
  select app.variance_holds_reevaluate(app.org_id(), p_intake_ids)
$$;

-- Intake state changes -----------------------------------------------------------------------------
create or replace function app.variance_holds_on_intake_state()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.variance_holds_reevaluate(new.org_id, array[new.id]);
  return null;
end $$;

drop trigger if exists variance_holds_reevaluate on public.intake;
create trigger variance_holds_reevaluate after update of state on public.intake
  for each row when (app.variance_hold_reevaluate_on(old.state, new.state))
  execute function app.variance_holds_on_intake_state();

-- variance_hold_pct --------------------------------------------------------------------------------
-- Re-create admin_update_org from its current definition with exact replacements (as
-- 20261102000100_hold_waiting.sql). Raises if the old text is missing, unless the new text is
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

select pg_temp.reword('public.admin_update_org(text,text,text,jsonb)',
  $o$  v_repadded integer := 0;
begin$o$,
  $n$  v_repadded integer := 0;
  v_holds_cleared integer := 0;
begin$n$,
  $o$  where id = v_org.id;

  if v_to > v_from then$o$,
  $n$  where id = v_org.id;

  -- #95: a changed variance limit re-judges the org's active holds now. The org row is locked
  -- above, then the org's variance lock, then hold rows (ids), as sends take them.
  if app.variance_hold_limit(p_settings) <> app.variance_hold_limit(v_org.settings) then
    perform pg_advisory_xact_lock(hashtextextended('variance_hold:' || v_org.id::text, 0));
    v_holds_cleared := app.variance_holds_reevaluate(v_org.id, null);
  end if;

  if v_to > v_from then$n$,
  $o$    'repadded_tags', v_repadded);$o$,
  $n$    'repadded_tags', v_repadded, 'variance_holds_cleared', v_holds_cleared);$n$);

-- Backfill ---------------------------------------------------------------------------------------
-- docs/10 (stored computes): a migration adding a trigger backfills. Holds left stale by a
-- neighbour reaching reconcile, a cancellation or a limit change before this migration clear now.
select app.variance_holds_reevaluate(o.id, null)
from public.org o
where exists (select 1 from public.variance_hold h where h.org_id = o.id and h.state = 'active');

-- Grants ----------------------------------------------------------------------------------------
revoke all on function app.variance_holds_reevaluate(uuid, uuid[]),
  app.variance_holds_reevaluate(uuid[]), app.variance_holds_on_intake_state() from public;
