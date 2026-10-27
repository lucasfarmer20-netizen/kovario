-- WP-14 counter allocation (docs/04-BUSINESS-RULES.md §8, docs/06-STATIONS-UX.md Counter
-- allocation, docs/02-DOMAIN-MODEL.md §8). Tables are WP-03's (20261026180000_allocation.sql);
-- this adds the functions that write them:
--   * admin_save_box_size — the box size catalogue (/admin/box-sizes);
--   * save_allocation_session — create/edit a session in one transaction: pooled intakes (m2m),
--     split method, anglers (settlements) with per-angler species lb, box plans (method, size,
--     weight, 70-lb heavy check). A priced session is repriced in the same transaction;
--   * price_session — pools the intakes' processing charges and splits them by app.split_amount
--     (the penny rule, generated from packages/rules allocation.ts), adds box fees and the
--     freight placeholder; draft → priced;
--   * cancel_allocation_session; print_settlement_receipt (receipt print job carrying the
--     boxing QR) and settlement_receipt (the same data for the browser print);
--   * allocation_session_list — the session list with the fulfillment rollup, for filters.
-- Founding rule: box plans and vessels have no data link; nothing here reads or writes vessels.
-- Release (box/vessel ticks, I1–I17) is WP-15; payment of settlements is WP-16.

-- Ordering ----------------------------------------------------------------------------------

-- Settlements in creation order (STL-0009 before STL-0010): the penny tie-break order.
create or replace function app.number_order(p_number text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lpad(length(p_number)::text, 4, '0') || p_number
$$;

-- Box size catalogue ------------------------------------------------------------------------

-- p_box_size_id null → create. dims: {length_in?, width_in?, height_in?} (display only).
create or replace function public.admin_save_box_size(
  p_client_action_id text, p_box_size_id uuid, p_name text, p_max_lb numeric, p_fee numeric,
  p_dims jsonb default '{}'::jsonb, p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_id uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'box_size.save', jsonb_build_object(
    'box_size_id', p_box_size_id, 'name', p_name, 'max_lb', p_max_lb, 'fee', p_fee,
    'dims', p_dims, 'is_active', p_is_active));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(btrim(coalesce(p_name, ''))) = 0 or length(btrim(p_name)) > 60 then
    raise exception 'box size needs a name (at most 60 characters)' using errcode = '22023';
  end if;
  if p_max_lb is null or p_max_lb <= 0 then
    raise exception 'max lb must be more than 0' using errcode = '22023';
  end if;
  if p_fee is null or p_fee < 0 then
    raise exception 'fee must be 0 or more' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_dims, '{}'::jsonb)) <> 'object' or exists (
    select 1 from jsonb_each(coalesce(p_dims, '{}'::jsonb)) d
    where d.key not in ('length_in', 'width_in', 'height_in')
       or jsonb_typeof(d.value) <> 'number' or (d.value #>> '{}')::numeric <= 0
  ) then
    raise exception 'dims are length_in / width_in / height_in, each more than 0' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.box_size
    where org_id = v_org and name = btrim(p_name) and id is distinct from p_box_size_id
  ) then
    raise exception 'a box size named % already exists', btrim(p_name) using errcode = '23505';
  end if;

  if p_box_size_id is null then
    insert into public.box_size (org_id, name, max_lb, fee, dims, is_active)
    values (v_org, btrim(p_name), p_max_lb, p_fee, coalesce(p_dims, '{}'::jsonb), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.box_size
    set name = btrim(p_name), max_lb = p_max_lb, fee = p_fee, dims = coalesce(p_dims, '{}'::jsonb),
        is_active = coalesce(p_is_active, true)
    where id = p_box_size_id and org_id = v_org
    returning id into v_id;
    if v_id is null then
      raise exception 'box size not found' using errcode = 'P0002';
    end if;
  end if;

  v_result := jsonb_build_object('box_size_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Pool and price ----------------------------------------------------------------------------

-- The session that bills an intake's processing charges: the earliest non-cancelled session
-- pooling it. An intake may be pooled into several sessions (m2m), but its charges are billed
-- once — never split twice. Cancelling that session hands the intake to the next one.
create or replace function app.intake_billing_session(p_intake_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.allocation_intake ai
  join public.allocation_session s on s.id = ai.session_id
  where ai.intake_id = p_intake_id and s.state <> 'cancelled'
  order by s.created_at, app.number_order(s.number), s.id
  limit 1
$$;

-- The processing charges a session bills: the open processing and ribbing charges of the
-- intakes it pools and bills. The paid hook (WP-16) settles exactly these.
create or replace function app.session_billed_charges(p_session_id uuid)
returns table (charge_id uuid, intake_id uuid, amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, ai.intake_id, c.amount
  from public.allocation_intake ai
  join public.charge c
    on c.source_type = 'intake' and c.source_id = ai.intake_id
   and c.kind in ('processing', 'ribbing') and c.state = 'open'
  where ai.session_id = p_session_id
    and app.intake_billing_session(ai.intake_id) = p_session_id
$$;

-- {total, intakes: [{intake_id, number, amount, billed_here, billed_by}]} — what the pool is
-- made of, so the counter sees which session bills a shared intake.
create or replace function app.session_pool(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', coalesce((select sum(b.amount) from app.session_billed_charges(p_session_id) b), 0),
    'intakes', coalesce(jsonb_agg(jsonb_build_object(
      'intake_id', i.id,
      'number', i.number,
      'state', i.state,
      'amount', (select coalesce(sum(c.amount), 0) from public.charge c
                 where c.source_type = 'intake' and c.source_id = i.id
                   and c.kind in ('processing', 'ribbing') and c.state = 'open'),
      'billed_here', bs.id = p_session_id,
      'billed_by', bs.number) order by app.number_order(i.number)), '[]'::jsonb))
  from public.allocation_intake ai
  join public.intake i on i.id = ai.intake_id
  left join public.allocation_session bs on bs.id = app.intake_billing_session(i.id)
  where ai.session_id = p_session_id
$$;

-- Writes every settlement of the session: weight_total_lb = Σ species lb; processing_share =
-- the session's billed pool split by app.split_amount (weight: ∝ take-home lb; even: equal),
-- in settlement order; box_fee_total = Σ catalogue fee of its box plans; freight_total is the
-- placeholder carried as-is (0 until shipping quotes it, WP-19); amount_total = the sum.
-- The caller holds the session row lock.
create or replace function app.price_session_apply(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.allocation_session;
  v_pool numeric;
  v_ids uuid[];
  v_lb numeric[];
  v_shares numeric[];
begin
  select * into v_session from public.allocation_session where id = p_session_id;
  select coalesce(sum(b.amount), 0) into v_pool from app.session_billed_charges(p_session_id) b;
  select array_agg(st.id order by app.number_order(st.number)),
         array_agg(coalesce((select sum(ss.lb) from public.settlement_species ss
                             where ss.settlement_id = st.id), 0) order by app.number_order(st.number))
  into v_ids, v_lb
  from public.settlement st
  where st.session_id = p_session_id;
  if v_ids is null then
    raise exception 'add at least one angler before pricing %', v_session.number using errcode = '22023';
  end if;

  v_shares := app.split_amount(v_pool, case v_session.split_method
    when 'even' then array_fill(1::numeric, array[cardinality(v_ids)])
    else v_lb end);

  with u as (
    select x.id, x.share, x.lb,
           (select coalesce(sum(bs.fee), 0) from public.box_plan b
            join public.box_size bs on bs.id = b.box_size_id
            where b.settlement_id = x.id) as box_fee
    from unnest(v_ids, v_shares, v_lb) as x (id, share, lb)
  )
  update public.settlement st
  set weight_total_lb = u.lb,
      processing_share = u.share,
      box_fee_total = u.box_fee,
      amount_total = u.share + u.box_fee + st.freight_total
  from u
  where st.id = u.id;
end;
$$;

-- Reprices the other priced, unpaid sessions pooling any of `p_intake_ids` — the billing
-- session of a shared intake can change when this session adds, drops or cancels it.
create or replace function app.reprice_sessions_sharing(p_session_id uuid, p_intake_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  for v_id in
    select s.id from public.allocation_session s
    where s.id <> p_session_id and s.state = 'priced'
      and exists (select 1 from public.allocation_intake ai
                  where ai.session_id = s.id and ai.intake_id = any (p_intake_ids))
      and not exists (select 1 from public.settlement st where st.session_id = s.id and st.state = 'paid')
    order by s.id
    for update of s
  loop
    perform app.price_session_apply(v_id);
  end loop;
end;
$$;

-- The session as the counter sees it after a save or price.
create or replace function app.allocation_session_json(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'session_id', s.id,
    'number', s.number,
    'state', s.state,
    'split_method', s.split_method,
    'pool', app.session_pool(s.id),
    'settlements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'settlement_id', st.id, 'number', st.number, 'angler_name', st.angler_name,
        'state', st.state, 'weight_total_lb', st.weight_total_lb,
        'processing_share', st.processing_share, 'box_fee_total', st.box_fee_total,
        'freight_total', st.freight_total, 'amount_total', st.amount_total)
        order by app.number_order(st.number))
      from public.settlement st where st.session_id = s.id), '[]'::jsonb))
  from public.allocation_session s
  where s.id = p_session_id
$$;

-- Session save --------------------------------------------------------------------------------

-- Raises unless the session can still be edited, priced or cancelled: not done/cancelled and
-- no paid settlement (a paid settlement's numbers are what the customer paid).
create or replace function app.allocation_session_editable(p_session public.allocation_session)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session.state in ('done', 'cancelled') then
    raise exception '% is %; it can no longer change', p_session.number, p_session.state
      using errcode = '55000';
  end if;
  if exists (select 1 from public.settlement where session_id = p_session.id and state = 'paid') then
    raise exception '% has a paid settlement; it can no longer change', p_session.number
      using errcode = '55000';
  end if;
end;
$$;

-- p_payload: {session_id?, party_customer_id?, split_method: weight|even, notes?,
--   intake_ids: [uuid, …],
--   settlements: [{id?, angler_name, customer_id?, retail_note?,
--                  species: [{species_code, method_code, lb}],
--                  boxes: [{id?, method: air|ship|willcall, box_size_id, weight_lb,
--                           heavy_allowed}]}]}
-- No session_id → creates the session (ALC-). The settlement and box lists are complete:
-- rows of this session missing from them are removed (planned boxes only). Box plans have
-- no vessel field (founding rule). Returns app.allocation_session_json.
create or replace function public.save_allocation_session(p_client_action_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_session public.allocation_session;
  v_split public.allocation_session_split_method;
  v_party uuid;
  v_intakes uuid[];
  v_old_intakes uuid[] := '{}';
  v_bad text;
  v_s jsonb;
  v_b jsonb;
  v_species jsonb;
  v_boxes jsonb;
  v_st public.settlement;
  v_box public.box_plan;
  v_size uuid;
  v_weight numeric;
  v_heavy boolean;
  v_method public.box_plan_method;
  v_customer uuid;
  v_keep_st uuid[] := '{}';
  v_keep_box uuid[];
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload must be an object' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'allocation.save', p_payload);
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  -- Header ---------------------------------------------------------------------------------
  if coalesce(p_payload ->> 'split_method', 'weight') not in ('weight', 'even') then
    raise exception 'split method is weight or even' using errcode = '22023';
  end if;
  v_split := coalesce(p_payload ->> 'split_method', 'weight')::public.allocation_session_split_method;

  if jsonb_typeof(p_payload -> 'intake_ids') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'intake_ids') = 0 then
    raise exception 'a session pools at least one intake' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload -> 'intake_ids') x
             where jsonb_typeof(x) <> 'string'
                or x #>> '{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
    raise exception 'intake ids must be uuids' using errcode = '22023';
  end if;
  select array_agg(x.v::uuid order by x.n) into v_intakes
  from jsonb_array_elements_text(p_payload -> 'intake_ids') with ordinality as x (v, n);
  if (select count(distinct x) from unnest(v_intakes) x) <> cardinality(v_intakes) then
    raise exception 'an intake is listed twice' using errcode = '22023';
  end if;
  if (select count(*) from public.intake where id = any (v_intakes) and org_id = v_org) <> cardinality(v_intakes) then
    raise exception 'intake not found' using errcode = 'P0002';
  end if;
  select string_agg(i.number || ' (' || i.state || ')', ', ' order by i.number) into v_bad
  from public.intake i
  where i.id = any (v_intakes) and i.state in ('draft', 'done', 'cancelled');
  if v_bad is not null then
    raise exception 'cannot pool %: only saved, open intakes can be allocated', v_bad using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_payload -> 'settlements', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payload -> 'settlements', '[]'::jsonb)) > 50 then
    raise exception 'settlements must be a list of at most 50 anglers' using errcode = '22023';
  end if;

  -- D4 party fallback: the given customer, else the first listed intake's customer.
  v_party := coalesce(nullif(p_payload ->> 'party_customer_id', '')::uuid,
                      (select customer_id from public.intake where id = v_intakes[1]));
  if not exists (select 1 from public.customer where id = v_party and org_id = v_org) then
    raise exception 'party customer not found' using errcode = 'P0002';
  end if;

  if nullif(p_payload ->> 'session_id', '') is null then
    insert into public.allocation_session (org_id, number, party_customer_id, split_method, notes)
    values (v_org, app.next_free_number(v_org, 'allocation_session', 'public.allocation_session'),
            v_party, v_split, nullif(btrim(p_payload ->> 'notes'), ''))
    returning * into v_session;
  else
    -- Lock order: session first (docs/01-ARCHITECTURE.md); vessels are never touched here.
    select * into v_session from public.allocation_session
    where id = (p_payload ->> 'session_id')::uuid and org_id = v_org
    for update;
    if not found then
      raise exception 'allocation session not found' using errcode = 'P0002';
    end if;
    perform app.allocation_session_editable(v_session);
    select coalesce(array_agg(intake_id), '{}') into v_old_intakes
    from public.allocation_intake where session_id = v_session.id;
    update public.allocation_session
    set party_customer_id = v_party, split_method = v_split,
        notes = nullif(btrim(p_payload ->> 'notes'), '')
    where id = v_session.id
    returning * into v_session;
  end if;

  -- Pooled intakes (m2m: an intake may also be pooled by other sessions) -----------------------
  delete from public.allocation_intake where session_id = v_session.id and intake_id <> all (v_intakes);
  insert into public.allocation_intake (org_id, session_id, intake_id)
  select v_org, v_session.id, x from unnest(v_intakes) x
  on conflict (session_id, intake_id) do nothing;

  -- Anglers ----------------------------------------------------------------------------------
  for v_s in select value from jsonb_array_elements(coalesce(p_payload -> 'settlements', '[]'::jsonb)) loop
    if jsonb_typeof(v_s) <> 'object' or length(btrim(coalesce(v_s ->> 'angler_name', ''))) = 0
       or length(btrim(v_s ->> 'angler_name')) > 80 then
      raise exception 'every angler needs a name (at most 80 characters)' using errcode = '22023';
    end if;
    v_customer := nullif(v_s ->> 'customer_id', '')::uuid;
    if v_customer is not null and not exists (select 1 from public.customer where id = v_customer and org_id = v_org) then
      raise exception 'customer not found for angler %', btrim(v_s ->> 'angler_name') using errcode = 'P0002';
    end if;
    v_species := coalesce(v_s -> 'species', '[]'::jsonb);
    v_boxes := coalesce(v_s -> 'boxes', '[]'::jsonb);
    if jsonb_typeof(v_species) <> 'array' or jsonb_typeof(v_boxes) <> 'array'
       or jsonb_array_length(v_boxes) > 50 or jsonb_array_length(v_species) > 50 then
      raise exception 'species and boxes must be lists (at most 50 each)' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_species) x
      where jsonb_typeof(x) <> 'object' or jsonb_typeof(x -> 'lb') is distinct from 'number' or (x ->> 'lb')::numeric < 0
         or not exists (select 1 from public.species sp where sp.org_id = v_org and sp.code = x ->> 'species_code')
         or not exists (select 1 from public.processing_method m where m.org_id = v_org and m.code = x ->> 'method_code')
    ) then
      raise exception '%: each species line needs a known species, method and lb of 0 or more',
        btrim(v_s ->> 'angler_name') using errcode = '22023';
    end if;
    if (select count(distinct (x ->> 'species_code', x ->> 'method_code')) from jsonb_array_elements(v_species) x)
       <> jsonb_array_length(v_species) then
      raise exception '%: a species and method is listed twice', btrim(v_s ->> 'angler_name') using errcode = '22023';
    end if;

    if nullif(v_s ->> 'id', '') is null then
      insert into public.settlement (org_id, number, session_id, angler_name, customer_id, retail_note)
      values (v_org, app.next_free_number(v_org, 'settlement', 'public.settlement'), v_session.id,
              btrim(v_s ->> 'angler_name'), v_customer, nullif(btrim(v_s ->> 'retail_note'), ''))
      returning * into v_st;
    else
      update public.settlement
      set angler_name = btrim(v_s ->> 'angler_name'), customer_id = v_customer,
          retail_note = nullif(btrim(v_s ->> 'retail_note'), '')
      where id = (v_s ->> 'id')::uuid and session_id = v_session.id
      returning * into v_st;
      if not found then
        raise exception 'settlement % is not in %', v_s ->> 'id', v_session.number using errcode = 'P0002';
      end if;
    end if;
    v_keep_st := v_keep_st || v_st.id;

    delete from public.settlement_species where settlement_id = v_st.id;
    insert into public.settlement_species (org_id, settlement_id, species_code, method_code, lb)
    select v_org, v_st.id, x ->> 'species_code', x ->> 'method_code', (x ->> 'lb')::numeric
    from jsonb_array_elements(v_species) x;

    -- Box plans --------------------------------------------------------------------------------
    v_keep_box := '{}';
    for v_b in select value from jsonb_array_elements(v_boxes) loop
      if jsonb_typeof(v_b) <> 'object' or coalesce(v_b ->> 'method', '') not in ('air', 'ship', 'willcall') then
        raise exception '%: box method is air, ship or willcall', v_st.angler_name using errcode = '22023';
      end if;
      if jsonb_typeof(v_b -> 'weight_lb') is distinct from 'number' or (v_b ->> 'weight_lb')::numeric < 0 then
        raise exception '%: box weight must be 0 lb or more', v_st.angler_name using errcode = '22023';
      end if;
      v_method := (v_b ->> 'method')::public.box_plan_method;
      v_weight := (v_b ->> 'weight_lb')::numeric;
      v_heavy := coalesce((v_b ->> 'heavy_allowed')::boolean, false);
      v_size := nullif(v_b ->> 'box_size_id', '')::uuid;
      if v_weight > 70 and not v_heavy then
        raise exception '%: a % lb box is over 70 lb; confirm the heavy check', v_st.angler_name, v_weight
          using errcode = '23514';
      end if;
      if v_size is null or not exists (select 1 from public.box_size where id = v_size and org_id = v_org) then
        raise exception '%: pick a box size from the catalogue', v_st.angler_name using errcode = '22023';
      end if;

      if nullif(v_b ->> 'id', '') is null then
        if not exists (select 1 from public.box_size where id = v_size and is_active) then
          raise exception '%: that box size is archived', v_st.angler_name using errcode = '22023';
        end if;
        insert into public.box_plan (org_id, number, settlement_id, session_id, method, box_size_id,
                                     weight_lb, heavy_allowed)
        values (v_org, app.next_free_number(v_org, 'box_plan', 'public.box_plan'), v_st.id, v_session.id,
                v_method, v_size, v_weight, v_heavy)
        returning * into v_box;
      else
        select * into v_box from public.box_plan
        where id = (v_b ->> 'id')::uuid and settlement_id = v_st.id
        for update;
        if not found then
          raise exception 'box % is not %''s', v_b ->> 'id', v_st.angler_name using errcode = 'P0002';
        end if;
        if (v_box.method, v_box.box_size_id, v_box.weight_lb, v_box.heavy_allowed)
           is distinct from (v_method, v_size, v_weight, v_heavy) then
          -- Terminal box states never roll back, and a released box is a fact the crew reported.
          if v_box.fulfillment_state <> 'planned' then
            raise exception '% is already %; it cannot change', v_box.number, v_box.fulfillment_state
              using errcode = '55000';
          end if;
          if v_size is distinct from v_box.box_size_id
             and not exists (select 1 from public.box_size where id = v_size and is_active) then
            raise exception '%: that box size is archived', v_st.angler_name using errcode = '22023';
          end if;
          update public.box_plan
          set method = v_method, box_size_id = v_size, weight_lb = v_weight, heavy_allowed = v_heavy
          where id = v_box.id;
        end if;
      end if;
      v_keep_box := v_keep_box || v_box.id;
    end loop;

    select string_agg(number, ', ') into v_bad from public.box_plan
    where settlement_id = v_st.id and id <> all (v_keep_box) and fulfillment_state <> 'planned';
    if v_bad is not null then
      raise exception '% already released; it cannot be removed', v_bad using errcode = '55000';
    end if;
    delete from public.box_plan where settlement_id = v_st.id and id <> all (v_keep_box);
  end loop;

  -- Anglers dropped from the list (their boxes must all still be planned).
  select string_agg(b.number, ', ') into v_bad from public.box_plan b
  join public.settlement st on st.id = b.settlement_id
  where st.session_id = v_session.id and st.id <> all (v_keep_st) and b.fulfillment_state <> 'planned';
  if v_bad is not null then
    raise exception '% already released; its angler cannot be removed', v_bad using errcode = '55000';
  end if;
  delete from public.box_plan b using public.settlement st
  where st.id = b.settlement_id and st.session_id = v_session.id and st.id <> all (v_keep_st);
  delete from public.settlement where session_id = v_session.id and id <> all (v_keep_st);

  -- A priced session never shows stale numbers: reprice it, and any priced session whose
  -- billing of a shared intake this save changed.
  if v_session.state = 'priced' then
    perform app.price_session_apply(v_session.id);
  end if;
  perform app.reprice_sessions_sharing(v_session.id, v_old_intakes || v_intakes);

  v_result := app.allocation_session_json(v_session.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Price ---------------------------------------------------------------------------------------

-- Prices (or reprices) every settlement of the session; draft → priced.
create or replace function public.price_session(p_client_action_id text, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_session public.allocation_session;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'allocation.price',
    jsonb_build_object('session_id', p_session_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_session from public.allocation_session
  where id = p_session_id and org_id = app.org_id()
  for update;
  if not found then
    raise exception 'allocation session not found' using errcode = 'P0002';
  end if;
  perform app.allocation_session_editable(v_session);
  perform app.price_session_apply(v_session.id);
  if v_session.state = 'draft' then
    update public.allocation_session set state = 'priced' where id = v_session.id;
  end if;

  v_result := app.allocation_session_json(v_session.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Cancel --------------------------------------------------------------------------------------

-- A cancelled session no longer pools its intakes (I10 / I12 / I17 ignore it) and stops
-- billing them. Refused once a settlement is paid or a box has been released.
create or replace function public.cancel_allocation_session(
  p_client_action_id text, p_session_id uuid, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_session public.allocation_session;
  v_bad text;
  v_intakes uuid[];
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'allocation.cancel',
    jsonb_build_object('session_id', p_session_id, 'reason', nullif(btrim(p_reason), '')));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_session from public.allocation_session
  where id = p_session_id and org_id = app.org_id()
  for update;
  if not found then
    raise exception 'allocation session not found' using errcode = 'P0002';
  end if;
  perform app.allocation_session_editable(v_session);
  select string_agg(number, ', ') into v_bad from public.box_plan
  where session_id = v_session.id and fulfillment_state <> 'planned';
  if v_bad is not null then
    raise exception '% already released; % cannot be cancelled', v_bad, v_session.number using errcode = '55000';
  end if;

  update public.allocation_session set state = 'cancelled' where id = v_session.id;
  select coalesce(array_agg(intake_id), '{}') into v_intakes
  from public.allocation_intake where session_id = v_session.id;
  perform app.reprice_sessions_sharing(v_session.id, v_intakes);

  v_result := app.allocation_session_json(v_session.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Settlement receipt ----------------------------------------------------------------------------

-- What the per-angler receipt shows. Lines sum to amount_total exactly: box fees are the
-- settlement's priced total (the catalogue may change later), boxes are listed without prices.
create or replace function app.settlement_receipt(p_settlement_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'settlement_id', st.id,
    'number', st.number,
    'session_id', s.id,
    'session_number', s.number,
    'session_state', s.state,
    'split_method', s.split_method,
    'state', st.state,
    'angler_name', st.angler_name,
    'party_name', c.name,
    'date', to_char(now() at time zone coalesce(o.timezone, 'UTC'), 'YYYY-MM-DD'),
    'weight_total_lb', st.weight_total_lb,
    'processing_share', st.processing_share,
    'box_fee_total', st.box_fee_total,
    'freight_total', st.freight_total,
    'amount_total', st.amount_total,
    'retail_note', st.retail_note,
    'boxing_token', st.boxing_token,
    'qr', app.qr_box(st.boxing_token),
    'species', coalesce((
      select jsonb_agg(jsonb_build_object('species', coalesce(sp.name, ss.species_code),
                                          'method', coalesce(m.name, ss.method_code), 'lb', ss.lb)
                       order by sp.name, m.name)
      from public.settlement_species ss
      left join public.species sp on sp.org_id = ss.org_id and sp.code = ss.species_code
      left join public.processing_method m on m.org_id = ss.org_id and m.code = ss.method_code
      where ss.settlement_id = st.id), '[]'::jsonb),
    'boxes', coalesce((
      select jsonb_agg(jsonb_build_object('number', b.number, 'method', b.method,
                                          'size', bs.name, 'weight_lb', b.weight_lb,
                                          'heavy', b.weight_lb > 70)
                       order by app.number_order(b.number))
      from public.box_plan b
      left join public.box_size bs on bs.id = b.box_size_id
      where b.settlement_id = st.id), '[]'::jsonb))
  from public.settlement st
  join public.allocation_session s on s.id = st.session_id
  join public.org o on o.id = st.org_id
  left join public.customer c on c.id = s.party_customer_id
  where st.id = p_settlement_id
$$;

create or replace function public.settlement_receipt(p_settlement_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if not exists (select 1 from public.settlement where id = p_settlement_id and org_id = app.org_id()) then
    raise exception 'settlement not found' using errcode = 'P0002';
  end if;
  return app.settlement_receipt(p_settlement_id);
end;
$$;

-- Queues the angler's receipt on the station's receipt printer (else the site's `receipt`
-- printer): a `receipt` print job whose source names the template and carries the boxing QR
-- (FL:BOX:<token>, app.qr_box). Like the intake receipt, the PDF itself is rendered by the
-- print pipeline (WP-08); the station also prints the same receipt from the browser.
-- Only a priced session's receipt prints (its amounts are current).
create or replace function public.print_settlement_receipt(p_client_action_id text, p_settlement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_st public.settlement;
  v_session public.allocation_session;
  v_site uuid;
  v_printer uuid;
  v_job uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'allocation.print_receipt',
    jsonb_build_object('settlement_id', p_settlement_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_st from public.settlement where id = p_settlement_id and org_id = v_org;
  if not found then
    raise exception 'settlement not found' using errcode = 'P0002';
  end if;
  select * into v_session from public.allocation_session where id = v_st.session_id;
  if v_session.state not in ('priced', 'done') then
    raise exception 'price % before printing receipts', v_session.number using errcode = '55000';
  end if;

  v_site := coalesce(
    (select d.site_id from public.device d where d.id = app.device_id() and d.org_id = v_org),
    (select s.id from public.site s where s.org_id = v_org and s.is_default));
  v_printer := app.station_printer(v_site, 'receipt_pdf', 'receipt');
  if v_printer is not null then
    insert into public.print_job (org_id, printer_id, kind, payload_type, payload, source)
    values (v_org, v_printer, 'receipt', 'pdf_url', '', jsonb_build_object(
      'template', 'settlement_receipt', 'settlement_id', v_st.id, 'settlement_number', v_st.number,
      'session_id', v_session.id, 'session_number', v_session.number,
      'qr', app.qr_box(v_st.boxing_token)))
    returning id into v_job;
  end if;

  v_result := jsonb_build_object('settlement_id', v_st.id, 'number', v_st.number,
    'print_job_id', v_job, 'printer_missing', v_printer is null);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Session summary ---------------------------------------------------------------------------

-- The editor's view of a session on load: the same shape save / price return (with the pool,
-- so the counter sees which session bills a shared intake).
create or replace function public.allocation_session_summary(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if not exists (select 1 from public.allocation_session where id = p_session_id and org_id = app.org_id()) then
    raise exception 'allocation session not found' using errcode = 'P0002';
  end if;
  return app.allocation_session_json(p_session_id);
end;
$$;

-- Session list -------------------------------------------------------------------------------

-- One row per session with its fulfillment rollup (allocation_session_fulfillment) and what
-- the counter filters on: state, fulfillment status, and search_text (number, party, anglers,
-- pooled intake numbers). Runs with the caller's rights.
create or replace view public.allocation_session_list with (security_invoker = true) as
  select
    s.id as session_id,
    s.org_id,
    s.number,
    s.state,
    s.split_method,
    s.party_customer_id,
    c.name as party_name,
    s.created_at,
    f.fulfillment_status,
    f.box_count,
    f.planned_count,
    coalesce(i.numbers, '{}') as intake_numbers,
    coalesce(st.anglers, '{}') as angler_names,
    coalesce(st.n, 0) as settlement_count,
    coalesce(st.paid, 0) as paid_count,
    coalesce(st.amount, 0)::numeric(12,2) as amount_total,
    lower(concat_ws(' ', s.number, c.name, array_to_string(i.numbers, ' '),
                    array_to_string(st.anglers, ' '))) as search_text
  from public.allocation_session s
  join public.allocation_session_fulfillment f on f.session_id = s.id
  left join public.customer c on c.id = s.party_customer_id
  left join lateral (
    select array_agg(it.number order by app.number_order(it.number)) as numbers
    from public.allocation_intake ai join public.intake it on it.id = ai.intake_id
    where ai.session_id = s.id
  ) i on true
  left join lateral (
    select array_agg(x.angler_name order by app.number_order(x.number)) as anglers,
           count(*)::int as n,
           (count(*) filter (where x.state = 'paid'))::int as paid,
           sum(x.amount_total) as amount
    from public.settlement x
    where x.session_id = s.id
  ) st on true;

revoke all on public.allocation_session_list from public, anon, authenticated;
grant select on public.allocation_session_list to authenticated, service_role;

-- Grants -----------------------------------------------------------------------------------------

revoke all on function
  app.number_order(text),
  app.intake_billing_session(uuid),
  app.session_billed_charges(uuid),
  app.session_pool(uuid),
  app.price_session_apply(uuid),
  app.reprice_sessions_sharing(uuid, uuid[]),
  app.allocation_session_json(uuid),
  app.allocation_session_editable(public.allocation_session),
  app.settlement_receipt(uuid)
from public;
-- The list view runs with the caller's rights and orders by number.
grant execute on function app.number_order(text) to authenticated, service_role;
grant execute on function app.session_billed_charges(uuid), app.intake_billing_session(uuid)
to service_role;

revoke all on function
  public.admin_save_box_size(text, uuid, text, numeric, numeric, jsonb, boolean),
  public.save_allocation_session(text, jsonb),
  public.price_session(text, uuid),
  public.cancel_allocation_session(text, uuid, text),
  public.settlement_receipt(uuid),
  public.print_settlement_receipt(text, uuid),
  public.allocation_session_summary(uuid)
from public, anon, authenticated;

grant execute on function
  public.admin_save_box_size(text, uuid, text, numeric, numeric, jsonb, boolean),
  public.save_allocation_session(text, jsonb),
  public.price_session(text, uuid),
  public.cancel_allocation_session(text, uuid, text),
  public.settlement_receipt(uuid),
  public.print_settlement_receipt(text, uuid),
  public.allocation_session_summary(uuid)
to authenticated;
