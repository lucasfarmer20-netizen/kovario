-- v1.1 suspect picker, move bin between orders, pull back from blast (#88;
-- docs/04-BUSINESS-RULES.md §6b, docs/06-STATIONS-UX.md). Once a variance hold flags an intake
-- (#87), the manager finds the order its fish actually went into among the hold group and moves
-- a bin (vessel, with its tag and weight) across; an intake already in blast can be pulled back
-- to reconcile first. Both are manager actions (account or manager PIN elevation, as #87's
-- sign-off, DECISION-29), single SQL functions in action_log, with rows in public.intake_history.
--
-- Built on #87's interfaces, not a second derivation: the group is app.variance_hold_group over
-- app.rollstock_sequence (variance_hold_group_of now delegates to app.intake_hold_group, so a
-- hold and a tapped "now in blast" line share one definition); variance comes from
-- public.intake_variance; a move re-evaluates holds through app.variance_holds_reevaluate, which
-- clears a hold whose group is back within the limit (no sign-off).
-- Rule predicates (picker status, which states a bin moves between, the pull back check) are
-- generated from packages/rules suspects.ts into 20261031000000_suspect_rules_sql.sql; the
-- blast_freezer → reconcile edge from states.ts into 20261031000100_state_transitions.sql.
--
-- Lock order (AGENTS rule 3, as #87): the org's variance advisory lock → each intake's reconcile
-- advisory lock (sorted ids) → vessels (sorted ids) → intakes (sorted ids) → variance_hold rows
-- (app.variance_holds_reevaluate). The freezer stations lock vessel → intake, the same way round.

-- Intake history --------------------------------------------------------------------------------
-- Append-only (D3): a bin move writes one row on each intake (from, to, vessel, who, when); a pull
-- back writes the state change with its reason on the intake.
do $$ begin
  create type public.intake_history_kind as enum ('vessel_moved_out', 'vessel_moved_in', 'pulled_back');
exception when duplicate_object then null; end $$;

create table if not exists public.intake_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  kind public.intake_history_kind not null,
  -- Plain ids, not foreign keys: a moved vessel may later be removed at reconcile (its row
  -- deleted) and a member may leave; the history keeps who and what. A foreign key would have to
  -- set null, an update the append-only trigger refuses. Intakes are removed only with their org,
  -- which cascades (cascaded deletes pass the trigger).
  vessel_id uuid,
  from_intake_id uuid references public.intake (id) on delete cascade,
  to_intake_id uuid references public.intake (id) on delete cascade,
  weight_lb numeric(10,2),
  tag_code text,
  from_state public.intake_state,
  to_state public.intake_state,
  reason text,
  -- the caller's org_member id (null for a station device) and the approving manager's
  actor_id uuid,
  manager_id uuid,
  client_action_id text not null,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint intake_history_shape check (
    (kind in ('vessel_moved_out', 'vessel_moved_in') and from_intake_id <> to_intake_id
      and intake_id = case kind when 'vessel_moved_out' then from_intake_id else to_intake_id end)
    or (kind = 'pulled_back' and from_state is not null and to_state is not null
      and coalesce(reason, '') ~ '\S'))
);
create index if not exists intake_history_intake on public.intake_history (intake_id, at);
select app.enable_org_rls('public.intake_history', write_roles => '{}');
drop trigger if exists append_only on public.intake_history;
create trigger append_only before update or delete on public.intake_history
  for each row execute function app.append_only();

-- The group -------------------------------------------------------------------------------------
-- 1 before, the intake, 2 after over its site's rollstock line (rules: holdGroup), the body of
-- #87's app.variance_hold_group_of, now shared with groups centred on any intake.
create or replace function app.intake_hold_group(p_org_id uuid, p_intake_id uuid)
returns uuid[] language sql stable set search_path = '' as $$
  select app.variance_hold_group(app.rollstock_sequence(i.org_id, i.site_id, ro.opened_at), i.id)
  from public.intake i
  left join public.rollstock_open ro on ro.intake_id = i.id and ro.org_id = i.org_id
  where i.id = p_intake_id and i.org_id = p_org_id
$$;

create or replace function app.variance_hold_group_of(p_hold public.variance_hold)
returns uuid[] language sql stable set search_path = '' as $$
  select app.intake_hold_group(p_hold.org_id, p_hold.intake_id)
$$;

-- The picker's group for p_intake_id: an active hold's group when the intake is in one (its own
-- hold first, else the oldest), otherwise the group centred on the intake itself (a tapped "now
-- in blast" line). Each member's variance, species, size (expected yield) and status
-- (rules: suspectStatus); `waiting` members hold back suggestions. Under RLS: own org only.
create or replace function public.variance_suspect_group(p_intake_id uuid)
returns table (
  center_intake_id uuid, hold_id uuid, intake_id uuid, "position" int, intake_number text,
  state public.intake_state, status text, waiting boolean, blocked boolean,
  expected_lb numeric, actual_lb numeric, variance_pct numeric, limit_pct int, band text,
  species text[], vessels int, unweighed int
)
language sql stable set search_path = '' as $$
  with hold as (
    select h.id, h.intake_id from public.variance_hold h
    where h.org_id = app.org_id() and h.state = 'active'
      and p_intake_id = any (app.variance_hold_group_of(h))
    order by (h.intake_id = p_intake_id) desc, h.flagged_at, h.id
    limit 1
  ), center as (
    select coalesce((select hold.intake_id from hold), i.id) as intake_id,
      (select hold.id from hold) as hold_id
    from public.intake i
    where i.id = p_intake_id and i.org_id = app.org_id()
  )
  select c.intake_id, c.hold_id, g.intake_id,
    (g.ord - array_position(grp.grp, c.intake_id))::int, iv.number, iv.state,
    s.status, app.suspect_waiting(s.status), c.hold_id is not null and app.variance_hold_blocks(iv.state),
    iv.expected_lb, iv.actual_lb, iv.variance_pct, iv.limit_pct, iv.band,
    sp.species, w.vessels, w.unweighed
  from center c
  cross join lateral (select app.intake_hold_group(app.org_id(), c.intake_id) as grp) grp
  cross join lateral unnest(grp.grp) with ordinality g(intake_id, ord)
  join public.intake_variance iv on iv.intake_id = g.intake_id and iv.org_id = app.org_id()
  cross join lateral (
    select count(*)::int as vessels, count(*) filter (where v.weight_lb <= 0)::int as unweighed
    from public.vessel v
    where v.intake_id = g.intake_id and v.org_id = app.org_id() and v.lifecycle_state = 'occupied'
  ) w
  cross join lateral (
    select coalesce(array_agg(distinct l.species_code order by l.species_code), '{}') as species
    from public.intake_line l where l.intake_id = g.intake_id and l.org_id = app.org_id()
  ) sp
  cross join lateral (select app.suspect_status(iv.state, w.vessels, w.unweighed) as status) s
  order by g.ord
$$;

-- The caller's member row (null for a station device) and the approving manager: a manager
-- account approves itself; anyone else needs a live manager PIN elevation (DECISION-29).
create or replace function app.manager_approval(p_elevation_token text, out actor_id uuid, out manager_id uuid)
language plpgsql stable set search_path = '' as $$
begin
  select m.id into actor_id from public.org_member m
  where m.org_id = app.org_id() and m.user_id = app.user_id();
  if app.role() in ('owner', 'manager') then
    manager_id := actor_id;
  else
    manager_id := app.require_elevation(p_elevation_token);
  end if;
end $$;

-- Move bin --------------------------------------------------------------------------------------
-- Moves an occupied vessel, with its tag and weight, from its intake to p_to_intake_id. Both
-- intakes must be at reconcile (rules: binMovable; one in blast is pulled back first) and in the
-- group centred on p_center_intake_id (the picker's centre: the flagged or tapped intake). Writes
-- intake_history on both intakes and a vessel_moved event, then re-evaluates the holds covering
-- them: a group back within the limit clears automatically. Both variances recompute at once
-- (intake_variance is live at reconcile). Replaying a client_action_id returns the stored result;
-- a vessel already in the target intake is a no-op.
create or replace function public.variance_move_vessel(p_client_action_id text, p_vessel_id uuid,
  p_to_intake_id uuid, p_center_intake_id uuid, p_elevation_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; r jsonb; approval record; v public.vessel; v_from uuid; v_ids uuid[]; v_id uuid;
  f public.intake; t public.intake; m public.intake; v_group uuid[]; v_tag text; v_cleared int;
  fv public.intake_variance; tv public.intake_variance;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a := app.action_begin(p_client_action_id, 'variance.move_vessel', jsonb_build_object(
    'vessel_id', p_vessel_id, 'to_intake_id', p_to_intake_id, 'center_intake_id', p_center_intake_id));
  if a ->> 'status' = 'done' then return a -> 'result'; end if;
  select * into approval from app.manager_approval(p_elevation_token);
  -- Serialises with sends and sign-offs; moves serialise with each other, so the vessel's
  -- intake read here cannot change before its row lock.
  perform pg_advisory_xact_lock(hashtextextended('variance_hold:' || app.org_id()::text, 0));
  select vs.intake_id into v_from from public.vessel vs where vs.id = p_vessel_id and vs.org_id = app.org_id();
  if v_from is null then raise exception 'Unknown vessel' using errcode = '22023'; end if;
  if not exists (select 1 from public.intake where id = p_to_intake_id and org_id = app.org_id()) then
    raise exception 'Unknown intake' using errcode = '22023';
  end if;
  v_ids := array(select distinct x from unnest(array[v_from, p_to_intake_id]) x order by x);
  foreach v_id in array v_ids loop
    perform pg_advisory_xact_lock(hashtextextended('reconcile:' || v_id::text, 0));
  end loop;
  perform 1 from public.vessel where intake_id = any (v_ids) and org_id = app.org_id() order by id for update;
  perform 1 from public.intake where id = any (v_ids) and org_id = app.org_id() order by id for update;
  select * into v from public.vessel where id = p_vessel_id and org_id = app.org_id();
  if v.id is null or v.lifecycle_state <> 'occupied' then
    raise exception 'Unknown occupied vessel' using errcode = '22023';
  end if;
  select * into f from public.intake where id = v.intake_id;
  select * into t from public.intake where id = p_to_intake_id;
  select code into v_tag from public.asset_tag where id = v.asset_tag_id;
  if f.id = t.id then
    r := jsonb_build_object('ok', true, 'moved', false, 'holds_cleared', 0,
      'reason', format('%s is already in %s', coalesce(v_tag, 'The exchange bin'), t.number));
  else
    foreach m in array array[f, t] loop
      if not app.bin_movable(m.state) then
        raise exception '%', case when m.state = 'blast_freezer'
          then format('%s is in the blast freezer; pull it back to reconcile first', m.number)
          else format('%s is not at reconcile', m.number) end using errcode = '22023';
      end if;
    end loop;
    -- Fail closed: an unknown, other-org or null centre has no group (null), and a null
    -- membership test must refuse, never fall through to the move.
    v_group := app.intake_hold_group(app.org_id(), p_center_intake_id);
    if v_group is null then
      raise exception 'Unknown hold group' using errcode = '22023';
    end if;
    if (f.id = any (v_group) and t.id = any (v_group)) is not true then
      raise exception '% and % are not in the same hold group', f.number, t.number using errcode = '22023';
    end if;
    update public.vessel set intake_id = t.id where id = v.id;
    insert into public.intake_history (org_id, intake_id, kind, vessel_id, from_intake_id, to_intake_id,
      weight_lb, tag_code, actor_id, manager_id, client_action_id)
    values
      (f.org_id, f.id, 'vessel_moved_out', v.id, f.id, t.id, v.weight_lb, v_tag, approval.actor_id,
        approval.manager_id, p_client_action_id),
      (t.org_id, t.id, 'vessel_moved_in', v.id, f.id, t.id, v.weight_lb, v_tag, approval.actor_id,
        approval.manager_id, p_client_action_id);
    perform app.emit_event(f.org_id, 'vessel_moved', v.id, jsonb_build_object('from_intake_id', f.id,
      'to_intake_id', t.id, 'weight_lb', v.weight_lb, 'tag_code', v_tag, 'manager_id', approval.manager_id));
    v_cleared := app.variance_holds_reevaluate(array[f.id, t.id]);
    select * into fv from public.intake_variance where intake_id = f.id and org_id = f.org_id;
    select * into tv from public.intake_variance where intake_id = t.id and org_id = t.org_id;
    r := jsonb_build_object('ok', true, 'moved', true, 'holds_cleared', v_cleared,
      'reason', format('Moved %s (%s lb) from %s to %s: %s now %s, %s now %s%s',
        coalesce(v_tag, 'exchange bin'), v.weight_lb, f.number, t.number,
        f.number, app.format_variance(fv.variance_pct), t.number, app.format_variance(tv.variance_pct),
        case when v_cleared > 0 then '. Hold cleared' else '' end),
      'from', jsonb_build_object('intake_id', f.id, 'variance_pct', fv.variance_pct, 'band', fv.band),
      'to', jsonb_build_object('intake_id', t.id, 'variance_pct', tv.variance_pct, 'band', tv.band));
  end if;
  perform app.action_complete(p_client_action_id, r);
  return r;
end $$;

-- Pull back from blast ----------------------------------------------------------------------------
-- blast_freezer → reconcile (manager edge, states.ts) with a reason (rules: pullBackProblem).
-- The intake's vessels' blast_in_at / blast_out_at are cleared, so re-entering blast restarts blast
-- time (a re-send also re-stamps intake.blast_at and overwrites intake_blast_send). The stamps
-- entering reconcile writes (rollstock_done_at, reconcile_at) are put back: they record the first
-- time, and the reconcile queue keeps the intake in its rollstock place. Logged in
-- intake_history (from, to, reason, who, when) and as an intake_pulled_back event.
create or replace function public.intake_pull_back(p_client_action_id text, p_intake_id uuid,
  p_reason text, p_elevation_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; r jsonb; approval record; i public.intake; v_problem text; v_vessels int;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a := app.action_begin(p_client_action_id, 'intake.pull_back',
    jsonb_build_object('intake_id', p_intake_id, 'reason', p_reason));
  if a ->> 'status' = 'done' then return a -> 'result'; end if;
  select * into approval from app.manager_approval(p_elevation_token);
  perform pg_advisory_xact_lock(hashtextextended('variance_hold:' || app.org_id()::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('reconcile:' || p_intake_id::text, 0));
  perform 1 from public.vessel where intake_id = p_intake_id and org_id = app.org_id() order by id for update;
  select * into i from public.intake where id = p_intake_id and org_id = app.org_id() for update;
  if i.id is null then raise exception 'Unknown intake' using errcode = '22023'; end if;
  v_problem := app.pull_back_problem(i.state, p_reason);
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
  update public.intake set state = 'reconcile' where id = i.id;
  update public.intake set rollstock_done_at = i.rollstock_done_at, reconcile_at = i.reconcile_at
  where id = i.id;
  update public.vessel set blast_in_at = null, blast_out_at = null
  where intake_id = i.id and org_id = i.org_id and lifecycle_state = 'occupied';
  get diagnostics v_vessels = row_count;
  insert into public.intake_history (org_id, intake_id, kind, from_state, to_state, reason, actor_id,
    manager_id, client_action_id)
  values (i.org_id, i.id, 'pulled_back', i.state, 'reconcile', btrim(p_reason), approval.actor_id,
    approval.manager_id, p_client_action_id);
  perform app.emit_event(i.org_id, 'intake_pulled_back', i.id, jsonb_build_object('reason', btrim(p_reason),
    'manager_id', approval.manager_id, 'vessels', v_vessels));
  r := jsonb_build_object('ok', true, 'intake_id', i.id, 'vessels', v_vessels,
    'reason', format('%s pulled back to reconcile; blast time restarts when it is sent again', i.number));
  perform app.action_complete(p_client_action_id, r);
  return r;
end $$;

-- Grants ----------------------------------------------------------------------------------------
revoke all on function app.intake_hold_group(uuid, uuid), app.manager_approval(text) from public;
grant execute on function app.intake_hold_group(uuid, uuid) to authenticated, service_role;
revoke all on function public.variance_suspect_group(uuid) from public, anon;
grant execute on function public.variance_suspect_group(uuid) to authenticated, service_role;
revoke all on function public.variance_move_vessel(text, uuid, uuid, uuid, text),
  public.intake_pull_back(text, uuid, text, text) from public, anon;
grant execute on function public.variance_move_vessel(text, uuid, uuid, uuid, text),
  public.intake_pull_back(text, uuid, text, text) to authenticated;
