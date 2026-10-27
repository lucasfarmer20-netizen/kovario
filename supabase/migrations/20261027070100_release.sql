-- WP-15 boxing / will-call release (docs/10-LESSONS-FROM-CSP.md §2 — invariants I1–I17 and
-- the P1–P24 path matrix; docs/03-STATE-MACHINES.md vessel / box / intake; docs/04 §9):
--   * release_party — the boxing Complete: box ticks finalise boxes, vessel ticks empty or
--     split vessels, the two never inferred from each other (founding rule, I1);
--   * release_by_tag — manager Release-by-Tag for a tote the crew forgot to tick (totes only,
--     warn-not-block across parties, no payment gate);
--   * restore_vessel — manager undo of a release, append-only (D3);
--   * app.try_close_after_release — THE close gate I10, used by every release path;
--   * boxing_wizard — the boxing screen's projection (I15); shipment_buy_check — the I13 gate
--     shipping (WP-19) asks before buying a label.
-- Lock order on every release path: sessions → vessels → intakes, sorted ids within a level
-- (§11 amendment). A party's ticked boxes are locked with its session (they are the
-- session's children); a freed tag is locked with its vessel. Intake rows are locked last,
-- inside the close gate, and nothing is acquired after them.
-- Occupancy is read ONLY from vessel.lifecycle_state; asset_tag_id is tag identity / reuse.

-- Shared predicates -------------------------------------------------------------------------

-- The operator for a boxing Complete: live PIN proof on station devices, else the signed-in
-- member. Will-call also runs at the counter, so counter tablets may complete too.
create or replace function app.boxing_operator(p_session uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op uuid;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if app.device_id() is not null and not exists (
    select 1 from public.device
    where id = app.device_id() and org_id = app.org_id() and auth_user_id = app.user_id()
      and is_active and station in ('boxing', 'allocate')
  ) then
    raise exception 'station_mismatch' using errcode = '42501';
  end if;
  if app.role() = 'station' then
    update public.station_operator_session set expires_at = now() + interval '15 minutes'
    where id = p_session and org_id = app.org_id() and user_id = app.user_id() and expires_at > now()
    returning operator_id into v_op;
    if v_op is null then
      raise exception 'operator_pin_required' using errcode = '42501';
    end if;
  else
    select id into v_op from public.org_member where org_id = app.org_id() and user_id = app.user_id();
  end if;
  return v_op;
end;
$$;

-- Manager-gated release tools: a live elevation token (station), else an owner/manager
-- session. Returns the approving member.
create or replace function app.release_manager(p_elevation_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_elevation_token is not null then
    return app.require_elevation(p_elevation_token);
  end if;
  perform app.require_role('{owner,manager}');
  return (select id from public.org_member where org_id = app.org_id() and user_id = app.user_id());
end;
$$;

-- "Tag 042 (INT-0007)" / "Exchange basket (INT-0007)" — how errors and notices name a vessel.
create or replace function app.vessel_label(p_vessel public.vessel)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce('Tag ' || t.code, case when p_vessel.is_exchange then 'Exchange basket' else 'Untagged basket' end)
         || ' (' || i.number || ')'
  from public.intake i
  left join public.asset_tag t on t.id = p_vessel.asset_tag_id
  where i.id = p_vessel.intake_id
$$;

-- The non-cancelled sessions pooling an intake (m2m): I10 (d), I12, I17 and the tag tool's
-- party warning all read this one predicate.
create or replace function app.pooling_sessions(p_intake_id uuid)
returns setof public.allocation_session
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
  from public.allocation_intake ai
  join public.allocation_session s on s.id = ai.session_id
  where ai.intake_id = p_intake_id and s.state <> 'cancelled'
$$;

-- I8 discriminator: the party's `moved` rows net of `restored` rows (restore is append-only,
-- so an undo nets rather than deletes). Positive = fish has moved for this party.
create or replace function app.party_net_movement(p_session_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select (count(*) filter (where event_kind = 'moved') - count(*) filter (where event_kind = 'restored'))::int
  from public.release_audit
  where session_id = p_session_id
$$;

-- Close gate I10 ------------------------------------------------------------------------------

-- An intake closes to `done` iff (a) state ∈ {stored, blast_freezer}; (b) it has ≥ 1 vessel
-- (no vacuous all-of-nothing: zero-vessel intakes never auto-close); (c) every vessel is
-- emptied or void; (d) every non-cancelled session pooling it has zero planned boxes. Locks
-- the intake rows (sorted) and re-reads under the lock, so two concurrent sibling-vessel
-- releases cannot both skip (c) and strand the intake open: the second waits, then sees the
-- first's committed vessel. Always the LAST lock a release path takes. Returns closed ids.
create or replace function app.try_close_after_release(p_intake_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.intake;
  v_closed uuid[] := '{}';
begin
  perform 1 from public.intake where id = any (p_intake_ids) order by id for update;
  for v_intake in select * from public.intake where id = any (p_intake_ids) order by id loop
    if v_intake.state in ('stored', 'blast_freezer')
       and exists (select 1 from public.vessel where intake_id = v_intake.id)
       and not exists (select 1 from public.vessel
                       where intake_id = v_intake.id and lifecycle_state not in ('emptied', 'void'))
       and not exists (select 1 from app.pooling_sessions(v_intake.id) s
                       join public.box_plan b on b.session_id = s.id and b.fulfillment_state = 'planned')
    then
      update public.intake set state = 'done' where id = v_intake.id;
      perform app.emit_event(v_intake.org_id, 'intake_done', v_intake.id, '{}'::jsonb);
      v_closed := v_closed || v_intake.id;
    end if;
  end loop;
  return v_closed;
end;
$$;

-- Vessel release primitive ----------------------------------------------------------------------

-- The one write path for a released vessel (party and tag tools alike). Full pull →
-- `emptied`: measure → 0, location cleared, tag freed, snapshot kept for restore. Split →
-- stays `occupied`: measure := R, location cleared, tag KEPT. Appends the `moved` audit row
-- (I9; moved rows never carry a payment ref). The caller holds the vessel lock and has
-- validated the line (app.release_line_issue).
create or replace function app.release_vessel_apply(
  p_vessel public.vessel, p_action text, p_lbs_left numeric, p_operator uuid, p_session_id uuid,
  p_detail jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location text;
  v_tag text;
  v_left numeric := case p_action when 'split' then p_lbs_left else 0 end;
begin
  select code into v_location from public.location where id = p_vessel.location_id;
  select code into v_tag from public.asset_tag where id = p_vessel.asset_tag_id;
  if p_action = 'full_pull' then
    update public.vessel
    set lifecycle_state = 'emptied', weight_lb = 0, location_id = null, emptied_by = p_operator,
        release_snapshot = jsonb_build_object(
          'weight_lb', p_vessel.weight_lb, 'location_id', p_vessel.location_id, 'location_code', v_location,
          'asset_tag_id', p_vessel.asset_tag_id, 'tag_code', v_tag, 'released_at', now())
    where id = p_vessel.id;
    -- Tag identity / reuse: free the tag this vessel holds.
    update public.asset_tag set state = 'available', current_vessel_id = null
    where current_vessel_id = p_vessel.id and org_id = p_vessel.org_id;
  elsif p_action = 'split' then
    update public.vessel set weight_lb = p_lbs_left, location_id = null where id = p_vessel.id;
  else
    raise exception 'unknown release action %', p_action using errcode = '22023';
  end if;

  insert into public.release_audit (org_id, intake_id, session_id, event_kind, released_by, vessel_id, detail)
  values (p_vessel.org_id, p_vessel.intake_id, p_session_id, 'moved', p_operator, p_vessel.id,
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object(
            'action', p_action, 'tag_code', v_tag, 'location_code', v_location,
            'weight_before', p_vessel.weight_lb, 'weight_after', v_left));

  return jsonb_build_object(
    'vessel_id', p_vessel.id, 'intake_id', p_vessel.intake_id, 'label', app.vessel_label(p_vessel),
    'tag_code', v_tag, 'is_exchange', p_vessel.is_exchange, 'action', p_action,
    'weight_before', p_vessel.weight_lb, 'weight_left', v_left, 'location_code', v_location);
end;
$$;

-- Shipping gate (I13 / I13b / I14) ------------------------------------------------------------

-- The rule is app.shipment_buy_gate (generated from rules/release.ts); this feeds it the
-- shipment, the org's today and buy window, and the stored blockers (strings or {code}).
create or replace function app.shipment_gate(p_shipment public.shipment, p_force_buy_held boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app.shipment_buy_gate(
    p_shipment.ship_date,
    app.org_today(p_shipment.org_id),
    coalesce((o.settings #>> '{shipping,buy_window_days}')::int, 1),
    p_force_buy_held,
    p_shipment.service,
    (select coalesce(array_agg(coalesce(x.b ->> 'code', x.b #>> '{}') order by x.n), '{}')
     from jsonb_array_elements(case when jsonb_typeof(p_shipment.blockers) = 'array'
                                    then p_shipment.blockers else '[]'::jsonb end)
          with ordinality as x (b, n)),
    p_shipment.state in ('label_bought', 'shipped'))
  from public.org o
  where o.id = p_shipment.org_id
$$;

-- One line the crew reads after Complete; a held notice is never swallowed by a blocker.
create or replace function app.shipment_notice(p_box_number text, p_shipment public.shipment, p_gate jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_shipment.id is null then p_box_number || ' packed; no shipment yet — set it up at Shipping'
    when (p_gate ->> 'can_reprint')::boolean then p_box_number || ' packed; label already bought (reprint any time)'
    else concat_ws('; ',
      p_box_number || ' packed',
      case when (p_gate ->> 'held')::boolean
        then 'label held: ships ' || to_char(p_shipment.ship_date, 'YYYY-MM-DD') || ', buy opens nearer the date' end,
      case when jsonb_array_length(p_gate -> 'blockers') > 0
        then 'label blocked: ' || (select string_agg(b, ', ') from jsonb_array_elements_text(p_gate -> 'blockers') b) end,
      case when (p_gate ->> 'can_buy')::boolean then 'label ready to buy' end)
  end
$$;

-- Boxing Complete ------------------------------------------------------------------------------

-- p_box_ticks: the ticked boxes. p_vessel_ticks: [{vessel_id, lbs_left?, ticked?, measure}] —
--   ticked defaults true; lbs_left blank = 0; measure (required on a ticked line) is the
--   weight the wizard showed: a basket whose weight changed since is a stale selection
--   (I16b). Unticked lines may be sent so a remainder left on one is rejected rather than
--   ignored (I5).
-- Order (I16): lock the session → scope (I11/I17) → lock ticked boxes and vessels → re-read
-- and split the selection: input faults abort everything, stale-but-was-valid selections are
-- dropped (reported in `stale`), the actionable remainder applies; empty remainder → no-op
-- (I7). Then I8, vessels, boxes, audit (I9), session done, I10.
create or replace function public.release_party(
  p_client_action_id text,
  p_session_id uuid,
  p_box_ticks uuid[] default '{}',
  p_vessel_ticks jsonb default '[]'::jsonb,
  p_payment_ref text default null,
  p_operator_session uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_boxes_in uuid[] := coalesce(p_box_ticks, '{}');
  v_lines jsonb := coalesce(p_vessel_ticks, '[]'::jsonb);
  v_ref text := nullif(btrim(p_payment_ref), '');
  v_action jsonb;
  v_op uuid;
  v_session public.allocation_session;
  v_pooled uuid[];
  v_party uuid;
  v_line jsonb;
  v_vessel public.vessel;
  v_box public.box_plan;
  v_ticked boolean;
  v_lbs numeric;
  v_measure numeric;
  v_issue text;
  v_label text;
  v_bad text;
  v_vessel_ids uuid[];
  v_ticked_ids uuid[];
  v_boxes uuid[] := '{}';
  v_moves jsonb := '{}'::jsonb;
  v_stale jsonb := '[]'::jsonb;
  v_moved jsonb := '[]'::jsonb;
  v_finalized jsonb := '[]'::jsonb;
  v_shipping jsonb := '[]'::jsonb;
  v_closed uuid[];
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'release.party', jsonb_build_object(
    'session_id', p_session_id, 'box_ticks', to_jsonb(v_boxes_in), 'vessel_ticks', v_lines,
    'payment_ref', v_ref));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  v_op := app.boxing_operator(p_operator_session);

  -- Shape ----------------------------------------------------------------------------------
  if exists (select 1 from unnest(v_boxes_in) b where b is null)
     or (select count(distinct b) from unnest(v_boxes_in) b) <> cardinality(v_boxes_in) then
    raise exception 'each box is ticked once' using errcode = '22023';
  end if;
  if jsonb_typeof(v_lines) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_lines) l
    where jsonb_typeof(l) <> 'object'
       or coalesce(l ->> 'vessel_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or coalesce(jsonb_typeof(l -> 'lbs_left'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(l -> 'measure'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(l -> 'ticked'), 'null') not in ('boolean', 'null')
  ) then
    raise exception 'vessel lines are [{vessel_id, lbs_left, ticked, measure}]' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) l
             where coalesce((l ->> 'ticked')::boolean, true) and jsonb_typeof(l -> 'measure') is distinct from 'number') then
    raise exception 'a ticked vessel line needs the measure (lb) the screen showed' using errcode = '22023';
  end if;
  select coalesce(array_agg((l ->> 'vessel_id')::uuid), '{}'),
         coalesce(array_agg((l ->> 'vessel_id')::uuid order by (l ->> 'vessel_id')::uuid)
                    filter (where coalesce((l ->> 'ticked')::boolean, true)), '{}')
  into v_vessel_ids, v_ticked_ids
  from jsonb_array_elements(v_lines) l;
  if (select count(distinct x) from unnest(v_vessel_ids) x) <> cardinality(v_vessel_ids) then
    raise exception 'each vessel is listed once' using errcode = '22023';
  end if;

  -- Lock level 1: the session. Serialises concurrent Completes on this party (I16).
  select * into v_session from public.allocation_session
  where id = p_session_id and org_id = v_org
  for update;
  if not found then
    raise exception 'allocation session not found' using errcode = 'P0002';
  end if;
  if v_session.state = 'cancelled' then
    raise exception '% is cancelled; nothing in it is releasable (I17)', v_session.number using errcode = '55000';
  end if;
  if v_session.state = 'draft' then
    raise exception 'price % before releasing it', v_session.number using errcode = '55000';
  end if;

  select coalesce(array_agg(intake_id order by intake_id), '{}') into v_pooled
  from public.allocation_intake where session_id = v_session.id;
  -- D4: the party is the session's customer, else its first pooled intake's customer.
  v_party := coalesce(v_session.party_customer_id, (
    select i.customer_id from public.allocation_intake ai join public.intake i on i.id = ai.intake_id
    where ai.session_id = v_session.id order by app.number_order(i.number) limit 1));

  -- Scope: one party per Complete (I11); nothing outside it is releasable (I17). Faults abort.
  if exists (select 1 from unnest(v_boxes_in) b
             where not exists (select 1 from public.box_plan where id = b and org_id = v_org)) then
    raise exception 'box not found' using errcode = 'P0002';
  end if;
  select string_agg(b.number || ' (' || s.number || ')', ', ' order by b.number) into v_bad
  from public.box_plan b join public.allocation_session s on s.id = b.session_id
  where b.id = any (v_boxes_in) and b.session_id <> v_session.id;
  if v_bad is not null then
    raise exception '% belongs to another party; one party per Complete (I11)', v_bad using errcode = '22023';
  end if;
  for v_vessel in select * from public.vessel where id = any (v_vessel_ids) and org_id = v_org loop
    if v_vessel.intake_id = any (v_pooled) then continue; end if;
    v_label := app.vessel_label(v_vessel);
    select string_agg(s.number, ', ' order by s.number) into v_bad from app.pooling_sessions(v_vessel.intake_id) s;
    if v_bad is not null then
      raise exception '% is pooled in %, not %; it is not releasable here (I17)', v_label, v_bad, v_session.number
        using errcode = '22023';
    end if;
    select c.name into v_bad from public.intake i join public.customer c on c.id = i.customer_id
    where i.id = v_vessel.intake_id and i.customer_id is distinct from v_party;
    if v_bad is not null then
      raise exception '% belongs to %, not this party (I11)', v_label, v_bad using errcode = '22023';
    end if;
    raise exception '% is not pooled in % (I17)', v_label, v_session.number using errcode = '22023';
  end loop;
  if (select count(*) from public.vessel where id = any (v_vessel_ids) and org_id = v_org) <> cardinality(v_vessel_ids) then
    raise exception 'vessel not found' using errcode = 'P0002';
  end if;

  -- Lock: the session's ticked boxes, then level 2: the ticked vessels (sorted ids).
  perform 1 from public.box_plan where id = any (v_boxes_in) order by id for update;
  perform 1 from public.vessel where id = any (v_ticked_ids) order by id for update;

  -- Re-read and split the selection (I16). Boxes: only `planned` is actionable (I2).
  for v_box in select * from public.box_plan where id = any (v_boxes_in) order by app.number_order(number) loop
    if v_box.fulfillment_state = 'planned' then
      v_boxes := v_boxes || v_box.id;
    else
      v_stale := v_stale || jsonb_build_object('kind', 'box', 'id', v_box.id, 'label', v_box.number,
                                               'state', v_box.fulfillment_state);
    end if;
  end loop;
  -- Vessels: the tick alone selects (I4); actionable iff occupied AND ticked (I6); a weight
  -- that moved since the wizard read it is stale too.
  for v_line in select value from jsonb_array_elements(v_lines) loop
    select * into v_vessel from public.vessel where id = (v_line ->> 'vessel_id')::uuid;
    v_ticked := coalesce((v_line ->> 'ticked')::boolean, true);
    v_lbs := (v_line ->> 'lbs_left')::numeric;
    v_measure := (v_line ->> 'measure')::numeric;
    v_label := app.vessel_label(v_vessel);
    if v_ticked and (v_vessel.lifecycle_state <> 'occupied' or v_measure <> v_vessel.weight_lb) then
      v_issue := app.release_line_issue(true, v_lbs, 'Infinity'::numeric);
      if v_issue is not null then
        raise exception '%: %', v_label, v_issue using errcode = '22023';
      end if;
      v_stale := v_stale || jsonb_build_object('kind', 'vessel', 'id', v_vessel.id, 'label', v_label,
                                               'state', v_vessel.lifecycle_state, 'weight_lb', v_vessel.weight_lb);
      continue;
    end if;
    v_issue := app.release_line_issue(v_ticked, v_lbs, v_vessel.weight_lb);
    if v_issue is not null then
      raise exception '%: %', v_label, v_issue using errcode = '22023';
    end if;
    if v_ticked then
      v_moves := v_moves || jsonb_build_object(v_vessel.id::text, v_lbs);
    end if;
  end loop;

  -- I7: nothing actionable → no writes; the screen stays on the form and warns.
  if cardinality(v_boxes) = 0 and v_moves = '{}'::jsonb then
    v_result := jsonb_build_object(
      'ok', true, 'noop', true, 'session_id', v_session.id, 'session_number', v_session.number,
      'session_state', v_session.state,
      'message', case when jsonb_array_length(v_stale) > 0
                      then 'Nothing left to release: everything ticked was already released or changed'
                      else 'Nothing ticked: tick boxes or totes before Complete' end,
      'finalized', '[]'::jsonb, 'moved', '[]'::jsonb, 'stale', v_stale,
      'closed_intakes', '[]'::jsonb, 'shipping', '[]'::jsonb);
    perform app.action_complete(p_client_action_id, v_result);
    return v_result;
  end if;

  -- I8: finalising a box is a hard block when fish has not moved for the party — no tote
  -- acted on this run and no net `moved` row for the session.
  if cardinality(v_boxes) > 0 and v_moves = '{}'::jsonb and app.party_net_movement(v_session.id) <= 0 then
    raise exception 'no fish has moved for % yet: tick the totes being handed over before finalising boxes (I8)',
      v_session.number using errcode = '55000';
  end if;

  -- Vessels (I5/I6): full pull or split, sorted ids.
  for v_vessel in select * from public.vessel where id in (select k::uuid from jsonb_object_keys(v_moves) k) order by id loop
    v_lbs := (v_moves ->> v_vessel.id::text)::numeric;
    v_moved := v_moved || app.release_vessel_apply(v_vessel,
      app.vessel_release_action(true, v_lbs, v_vessel.weight_lb), v_lbs, v_op, v_session.id,
      jsonb_build_object('path', 'party'));
  end loop;

  -- Boxes (I2/I3): ship → packed, air / will-call → picked_up. One finalized row per party
  -- intake (the box has no intake link; its party's intakes are what it draws from) (I9).
  if cardinality(v_boxes) > 0 then
    with u as (
      update public.box_plan
      set fulfillment_state = case when method = 'ship' then 'packed' else 'picked_up' end::public.box_plan_fulfillment_state
      where id = any (v_boxes)
      returning id, number, method, fulfillment_state
    )
    select jsonb_agg(jsonb_build_object('box_id', id, 'number', number, 'method', method, 'state', fulfillment_state)
                     order by app.number_order(number))
    into v_finalized from u;
    insert into public.release_audit (org_id, intake_id, session_id, event_kind, released_by, payment_ref, detail)
    select v_org, i, v_session.id, 'finalized', v_op, v_ref, jsonb_build_object(
      'path', 'party',
      'box_plan_ids', (select jsonb_agg(f -> 'box_id') from jsonb_array_elements(v_finalized) f),
      'box_numbers', (select jsonb_agg(f -> 'number') from jsonb_array_elements(v_finalized) f))
    from unnest(v_pooled) i;

    select coalesce(jsonb_agg(jsonb_build_object(
             'box_id', x.id, 'box_number', x.number, 'shipment_id', x.sh_id, 'shipment_number', x.sh_number,
             'gate', x.gate, 'notice', app.shipment_notice(x.number, x.sh, x.gate))
           order by app.number_order(x.number)), '[]'::jsonb)
    into v_shipping
    from (select b.id, b.number, sh.id as sh_id, sh.number as sh_number, sh,
                 case when sh.id is not null then app.shipment_gate(sh, false) end as gate
          from public.box_plan b left join public.shipment sh on sh.id = b.shipment_id
          where b.id = any (v_boxes) and b.method = 'ship') x;
  end if;

  -- The session is done once its fulfillment rollup reads released.
  if v_session.state = 'priced'
     and exists (select 1 from public.box_plan where session_id = v_session.id)
     and not exists (select 1 from public.box_plan where session_id = v_session.id and fulfillment_state = 'planned') then
    update public.allocation_session set state = 'done' where id = v_session.id returning * into v_session;
  end if;

  -- Lock level 3, last: the close gate (I10) over the party's intakes.
  v_closed := app.try_close_after_release(v_pooled);

  v_result := jsonb_build_object(
    'ok', true, 'noop', false, 'session_id', v_session.id, 'session_number', v_session.number,
    'session_state', v_session.state, 'finalized', v_finalized, 'moved', v_moved, 'stale', v_stale,
    'closed_intakes', (select coalesce(jsonb_agg(number order by app.number_order(number)), '[]'::jsonb)
                       from public.intake where id = any (v_closed)),
    'shipping', v_shipping);
  perform app.emit_event(v_org, 'party_released', v_session.id, jsonb_build_object(
    'boxes', (select coalesce(jsonb_agg(f -> 'box_id'), '[]'::jsonb) from jsonb_array_elements(v_finalized) f),
    'vessels', (select coalesce(jsonb_agg(m -> 'vessel_id'), '[]'::jsonb) from jsonb_array_elements(v_moved) m),
    'closed_intakes', to_jsonb(v_closed)));
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Release-by-Tag ---------------------------------------------------------------------------------

-- Manager tool for a tote the crew forgot to tick: totes only (I1), Lbs Left as in boxing
-- (I5), a reason, no payment gate. Cross-party is warn-not-block: the forgotten tote usually
-- IS in an active party. Attribution: the single still-active pooling party, else none.
-- Locks the pooling sessions → the vessel (then re-reads: D0, an already-released basket is a
-- no-op) → the intake (I10).
create or replace function public.release_by_tag(
  p_client_action_id text,
  p_tag text,
  p_lbs_left numeric default 0,
  p_reason text default null,
  p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
  v_raw text := btrim(p_tag, E' \t\r\n');
  v_reason text := nullif(btrim(p_reason), '');
  v_action jsonb;
  v_tag public.asset_tag;
  v_intake_id uuid;
  v_vessel public.vessel;
  v_issue text;
  v_active uuid[];
  v_parties text;
  v_attr uuid;
  v_moved jsonb;
  v_closed uuid[];
  v_warnings jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  v_manager := app.release_manager(p_elevation_token);
  if v_reason is null then
    raise exception 'Release-by-Tag needs a reason' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'release.by_tag', jsonb_build_object(
    'tag', v_raw, 'lbs_left', p_lbs_left, 'reason', v_reason, 'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_tag from public.asset_tag
  where org_id = app.org_id() and (qr = v_raw or code = app.normalize_tag_code(v_raw));
  if v_tag.id is null then
    raise exception 'Unknown tag' using errcode = 'P0002';
  end if;
  if v_tag.state <> 'in_use' or v_tag.current_vessel_id is null then
    v_result := jsonb_build_object('ok', true, 'noop', true, 'tag_code', v_tag.code,
      'message', format('Tag %s is not on a basket (already released?)', v_tag.code), 'warnings', '[]'::jsonb);
    perform app.action_complete(p_client_action_id, v_result);
    return v_result;
  end if;
  select intake_id into v_intake_id from public.vessel where id = v_tag.current_vessel_id;

  -- Level 1: every non-cancelled session pooling the basket's intake.
  perform 1 from public.allocation_session s
  where s.id in (select p.id from app.pooling_sessions(v_intake_id) p)
  order by s.id
  for update;
  -- Level 2: the vessel; re-read. The tag must still be on it and the basket still occupied.
  select * into v_vessel from public.vessel where id = v_tag.current_vessel_id for update;
  if v_vessel.lifecycle_state <> 'occupied' or not exists (
    select 1 from public.asset_tag where id = v_tag.id and state = 'in_use' and current_vessel_id = v_vessel.id
  ) then
    v_result := jsonb_build_object('ok', true, 'noop', true, 'tag_code', v_tag.code,
      'message', format('Tag %s was released meanwhile; nothing to do', v_tag.code), 'warnings', '[]'::jsonb);
    perform app.action_complete(p_client_action_id, v_result);
    return v_result;
  end if;
  v_issue := app.release_line_issue(true, p_lbs_left, v_vessel.weight_lb);
  if v_issue is not null then
    raise exception '%: %', app.vessel_label(v_vessel), v_issue using errcode = '22023';
  end if;

  select array_agg(s.id order by s.id), string_agg(s.number, ', ' order by s.number)
  into v_active, v_parties
  from app.pooling_sessions(v_intake_id) s where s.state in ('draft', 'priced');
  if v_parties is not null then
    v_warnings := v_warnings || to_jsonb(format('%s is pooled in %s (party release); released by tag anyway',
      (select number from public.intake where id = v_intake_id), v_parties));
  end if;
  v_attr := case when cardinality(v_active) = 1 then v_active[1] end;

  v_moved := app.release_vessel_apply(v_vessel,
    app.vessel_release_action(true, p_lbs_left, v_vessel.weight_lb), p_lbs_left, v_manager, v_attr,
    jsonb_build_object('path', 'tag', 'reason', v_reason));
  -- Level 3: the close gate.
  v_closed := app.try_close_after_release(array[v_intake_id]);

  v_result := v_moved || jsonb_build_object(
    'ok', true, 'noop', false,
    'intake_number', (select number from public.intake where id = v_intake_id),
    'session_number', (select number from public.allocation_session where id = v_attr),
    'closed_intakes', (select coalesce(jsonb_agg(number), '[]'::jsonb) from public.intake where id = any (v_closed)),
    'warnings', v_warnings);
  perform app.emit_event(app.org_id(), 'vessel_released_by_tag', v_vessel.id, jsonb_build_object(
    'reason', v_reason, 'action', v_moved ->> 'action', 'session_id', v_attr));
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Restore ----------------------------------------------------------------------------------------

-- Manager undo of a full pull: emptied → occupied with the snapshot's weight, its shelf if
-- still live, and its tag if still free (warn-not-block otherwise: the basket comes back
-- unlocated / untagged). Append-only: writes a `restored` row (D3), never edits history.
-- Attribution (I8, net-aware): the session of the latest `moved` row of this intake whose
-- session still has a positive moved-minus-restored balance. A closed intake reopens to
-- `stored` (it holds an occupied basket again) through the manager-forced edge, like
-- force_transition; the reason rides the action_log. Locks sessions → vessel → tag → intake.
create or replace function public.restore_vessel(
  p_client_action_id text,
  p_vessel_id uuid,
  p_reason text,
  p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_action jsonb;
  v_intake_id uuid;
  v_vessel public.vessel;
  v_intake public.intake;
  v_tag public.asset_tag;
  v_tag_id uuid;
  v_location uuid;
  v_weight numeric;
  v_attr uuid;
  v_reopened boolean := false;
  v_warnings jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  v_manager := app.release_manager(p_elevation_token);
  if v_reason is null then
    raise exception 'Restore needs a reason' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'release.restore', jsonb_build_object(
    'vessel_id', p_vessel_id, 'reason', v_reason, 'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select intake_id into v_intake_id from public.vessel where id = p_vessel_id and org_id = app.org_id();
  if v_intake_id is null then
    raise exception 'vessel not found' using errcode = 'P0002';
  end if;
  -- Level 1: the sessions this intake's movement is attributed to.
  perform 1 from public.allocation_session
  where id in (select session_id from public.release_audit where intake_id = v_intake_id and session_id is not null)
  order by id
  for update;
  -- Level 2: the vessel (re-read), then its tag.
  select * into v_vessel from public.vessel where id = p_vessel_id for update;
  if v_vessel.lifecycle_state = 'occupied' then
    v_result := jsonb_build_object('ok', true, 'restored', false, 'vessel_id', v_vessel.id,
      'message', app.vessel_label(v_vessel) || ' is already occupied; nothing to restore', 'warnings', '[]'::jsonb);
    perform app.action_complete(p_client_action_id, v_result);
    return v_result;
  end if;
  if v_vessel.lifecycle_state = 'void' then
    raise exception '% is void; a void basket cannot be restored', app.vessel_label(v_vessel) using errcode = '55000';
  end if;
  v_weight := (v_vessel.release_snapshot ->> 'weight_lb')::numeric;
  if v_weight is null then
    raise exception '% has no release snapshot to restore from', app.vessel_label(v_vessel) using errcode = '55000';
  end if;

  v_tag_id := v_vessel.asset_tag_id;
  if v_tag_id is not null then
    select * into v_tag from public.asset_tag where id = v_tag_id for update;
    if v_tag.state <> 'available' then
      v_warnings := v_warnings || to_jsonb(format(
        'Tag %s is %s%s; the basket comes back untagged', v_tag.code, replace(v_tag.state::text, '_', ' '),
        coalesce(' on ' || (select i.number from public.vessel h join public.intake i on i.id = h.intake_id
                             where h.id = v_tag.current_vessel_id), '')));
      v_tag_id := null;
    end if;
  end if;
  v_location := (v_vessel.release_snapshot ->> 'location_id')::uuid;
  if v_location is not null and not exists (select 1 from public.location where id = v_location and is_active) then
    v_warnings := v_warnings || to_jsonb(format('Shelf %s is archived; the basket comes back unlocated',
      v_vessel.release_snapshot ->> 'location_code'));
    v_location := null;
  end if;

  -- Level 3: the intake.
  select * into v_intake from public.intake where id = v_intake_id for update;
  if v_intake.state = 'cancelled' then
    raise exception '% is cancelled; its baskets cannot be restored', v_intake.number using errcode = '55000';
  end if;

  update public.vessel
  set lifecycle_state = 'occupied', weight_lb = v_weight, location_id = v_location, asset_tag_id = v_tag_id,
      emptied_at = null, emptied_by = null
  where id = v_vessel.id;
  if v_tag_id is not null then
    update public.asset_tag set state = 'in_use', current_vessel_id = v_vessel.id where id = v_tag_id;
  end if;
  if v_intake.state = 'done' then
    perform set_config('app.forced_transition', format('intake:%s:stored', v_intake.id), true);
    update public.intake set state = 'stored' where id = v_intake.id;
    perform set_config('app.forced_transition', '', true);
    update public.intake set stored_at = v_intake.stored_at, done_at = null where id = v_intake.id;
    v_reopened := true;
  end if;

  select ra.session_id into v_attr
  from public.release_audit ra
  where ra.intake_id = v_intake_id and ra.event_kind = 'moved' and ra.session_id is not null
    and app.party_net_movement(ra.session_id) > 0
  order by ra.released_at desc, ra.created_at desc, ra.id desc
  limit 1;
  insert into public.release_audit (org_id, intake_id, session_id, event_kind, released_by, vessel_id, detail)
  values (v_vessel.org_id, v_intake_id, v_attr, 'restored', v_manager, v_vessel.id, jsonb_build_object(
    'reason', v_reason, 'weight_lb', v_weight, 'tag_code', (select code from public.asset_tag where id = v_tag_id),
    'location_code', (select code from public.location where id = v_location), 'intake_reopened', v_reopened));

  v_result := jsonb_build_object(
    'ok', true, 'restored', true, 'vessel_id', v_vessel.id, 'intake_number', v_intake.number,
    'weight_lb', v_weight, 'tag_code', (select code from public.asset_tag where id = v_tag_id),
    'location_code', (select code from public.location where id = v_location),
    'session_number', (select number from public.allocation_session where id = v_attr),
    'intake_reopened', v_reopened, 'warnings', v_warnings);
  perform app.emit_event(v_vessel.org_id, 'vessel_restored', v_vessel.id, jsonb_build_object(
    'reason', v_reason, 'session_id', v_attr));
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Projection & shipping check -------------------------------------------------------------------

-- What the boxing screen shows (I15): exactly the currently `planned` boxes and currently
-- `occupied` vessels (pick list in walk order, untagged exchange baskets included), the
-- party's anglers, and the notes panel per pooled intake. Rebuilt from committed state on
-- every open, so a closed tab or lost transient never loses anything (D0).
create or replace function public.boxing_wizard(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.allocation_session;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  select * into v_session from public.allocation_session where id = p_session_id and org_id = app.org_id();
  if not found then
    raise exception 'allocation session not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'session_id', v_session.id,
    'number', v_session.number,
    'state', v_session.state,
    'party_name', coalesce(
      (select name from public.customer where id = v_session.party_customer_id),
      (select c.name from public.allocation_intake ai join public.intake i on i.id = ai.intake_id
       join public.customer c on c.id = i.customer_id
       where ai.session_id = v_session.id order by app.number_order(i.number) limit 1)),
    'moved_before', app.party_net_movement(v_session.id) > 0,
    'finalized_count', (select count(*)::int from public.box_plan
                        where session_id = v_session.id and fulfillment_state <> 'planned'),
    'anglers', coalesce((
      select jsonb_agg(jsonb_build_object('settlement_id', st.id, 'number', st.number,
                                          'angler_name', st.angler_name, 'state', st.state)
                       order by app.number_order(st.number))
      from public.settlement st where st.session_id = v_session.id), '[]'::jsonb),
    'boxes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'box_id', b.id, 'number', b.number, 'settlement_id', b.settlement_id,
               'angler_name', st.angler_name, 'method', b.method, 'size', bs.name, 'weight_lb', b.weight_lb,
               'shipment_number', sh.number, 'ship_date', sh.ship_date)
             order by app.number_order(st.number), app.number_order(b.number))
      from public.box_plan b
      join public.settlement st on st.id = b.settlement_id
      left join public.box_size bs on bs.id = b.box_size_id
      left join public.shipment sh on sh.id = b.shipment_id
      where b.session_id = v_session.id and b.fulfillment_state = 'planned'), '[]'::jsonb),
    'vessels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vessel_id', w.vessel_id, 'intake_id', w.intake_id, 'intake_number', w.intake_number,
               'tag_code', w.tag_code, 'is_exchange', w.is_exchange, 'weight_lb', w.weight_lb,
               'species_summary', w.species_summary, 'location_code', w.location_code, 'walk_seq', w.walk_seq)
             order by w.walk_seq)
      from public.vessel_walk_order w where w.session_id = v_session.id), '[]'::jsonb),
    'intakes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'intake_id', i.id, 'number', i.number, 'state', i.state, 'customer_name', c.name,
               'dirty_fish', i.dirty_fish, 'dirty_notes', i.dirty_notes, 'cut_notes', i.cut_notes,
               'processing_notes', i.processing_notes, 'ribbing', i.ribbing,
               'smoking', exists (select 1 from public.intake_line l where l.intake_id = i.id
                                  and (l.method_code = 'smoking' or l.method_code like 'smoked_exchange%')),
               'lines', coalesce((
                 select jsonb_agg(jsonb_build_object('species', coalesce(sp.name, l.species_code),
                                                     'method', coalesce(m.name, l.method_code),
                                                     'method_code', l.method_code, 'lb', l.lb, 'notes', l.notes)
                                  order by l.sort)
                 from public.intake_line l
                 left join public.species sp on sp.org_id = l.org_id and sp.code = l.species_code
                 left join public.processing_method m on m.org_id = l.org_id and m.code = l.method_code
                 where l.intake_id = i.id), '[]'::jsonb),
               'other_sessions', coalesce((
                 select jsonb_agg(s.number order by s.number) from app.pooling_sessions(i.id) s
                 where s.id <> v_session.id), '[]'::jsonb))
             order by app.number_order(i.number))
      from public.allocation_intake ai
      join public.intake i on i.id = ai.intake_id
      join public.customer c on c.id = i.customer_id
      where ai.session_id = v_session.id), '[]'::jsonb));
end;
$$;

-- The I13 / I13b / I14 gate for one shipment: what shipping (WP-19) asks before buying or
-- reprinting a label. p_force_buy_held is manager Buy Now: it lifts the date hold only.
create or replace function public.shipment_buy_check(
  p_shipment_id uuid, p_force_buy_held boolean default false, p_elevation_token text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipment;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if coalesce(p_force_buy_held, false) then
    perform app.release_manager(p_elevation_token);
  end if;
  select * into v_shipment from public.shipment where id = p_shipment_id and org_id = app.org_id();
  if not found then
    raise exception 'shipment not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'shipment_id', v_shipment.id, 'number', v_shipment.number, 'state', v_shipment.state,
    'ship_date', v_shipment.ship_date,
    'gate', app.shipment_gate(v_shipment, coalesce(p_force_buy_held, false)));
end;
$$;

-- Grants -----------------------------------------------------------------------------------------

revoke all on function
  app.boxing_operator(uuid),
  app.release_manager(text),
  app.vessel_label(public.vessel),
  app.pooling_sessions(uuid),
  app.party_net_movement(uuid),
  app.try_close_after_release(uuid[]),
  app.release_vessel_apply(public.vessel, text, numeric, uuid, uuid, jsonb),
  app.shipment_gate(public.shipment, boolean),
  app.shipment_notice(text, public.shipment, jsonb)
from public;
-- The WP-16 paid hook and other server paths close intakes through the same gate.
grant execute on function app.try_close_after_release(uuid[]), app.pooling_sessions(uuid),
  app.party_net_movement(uuid) to service_role;

revoke all on function
  public.release_party(text, uuid, uuid[], jsonb, text, uuid),
  public.release_by_tag(text, text, numeric, text, text),
  public.restore_vessel(text, uuid, text, text),
  public.boxing_wizard(uuid),
  public.shipment_buy_check(uuid, boolean, text)
from public, anon;
grant execute on function
  public.release_party(text, uuid, uuid[], jsonb, text, uuid),
  public.release_by_tag(text, text, numeric, text, text),
  public.restore_vessel(text, uuid, text, text),
  public.boxing_wizard(uuid),
  public.shipment_buy_check(uuid, boolean, text)
to authenticated;

do $$ begin alter publication supabase_realtime add table public.box_plan; exception when duplicate_object then null; end $$;
