-- WP-19 shipping (docs/07-INTEGRATIONS.md §4, docs/06-STATIONS-UX.md "Shipping", I13/I13b/I14 in
-- docs/10-LESSONS-FROM-CSP.md): shipments from ship boxes and walk-ins, one parcel row per
-- carrier parcel (each gets its own Shippo label), the shipping queue, label print jobs, mark
-- shipped, cancel, and the ship-from address per site.
--
-- Two kinds of function:
--   * station calls (authenticated, client_action_id → action_log): create, edit, select a rate,
--     begin a buy (the gate + a purchase claim), print / reprint, mark shipped, cancel;
--   * provider results (service_role ONLY — the /api/shipping route handlers): address check,
--     rates, bought labels, a failed buy, tracking. The browser can never record a Shippo
--     result, so it can never mark a label bought without paying for it.
-- The buy gate is WP-15's app.shipment_gate / app.shipment_buy_gate (I13 / I13b / I14).
-- Blockers stored on shipment.blockers: address_unverified, bad_address. The gate adds
-- missing_ship_date and no_service itself.

-- Schema ---------------------------------------------------------------------------------------

-- Where this site's boxes ship from (Shippo address_from). Null until a manager sets it.
alter table public.site add column if not exists ship_from jsonb;

alter table public.shipment
  add column if not exists site_id uuid references public.site (id) on delete set null,
  -- the chosen rate (carrier / service / rate_amount are its display fields)
  add column if not exists shippo_rate_id text,
  -- last rate shop: {rates:[…], missingCarriers:[…], carrierMessages:[…], attempts, at}
  add column if not exists rate_shop jsonb,
  -- last address check: {valid, messages:[…], at}
  add column if not exists address_check jsonb,
  -- A buy in flight. begin_label_buy issues a single-use claim (id + time + Buy Now flag)
  -- under the row lock; shipping_start_purchase consumes it once (purchase_started_at) before
  -- the route may call Shippo; recording labels or a failure must present the same claim id
  -- and clears it. A claim lives 5 minutes (the route's maxDuration is 60 s).
  add column if not exists buy_claim_id uuid,
  add column if not exists buy_claimed_at timestamptz,
  add column if not exists buy_claim_forced boolean not null default false,
  add column if not exists buy_purchase_started_at timestamptz,
  -- The rate a started purchase is (or may be) paying for. Set when the purchase starts; kept
  -- through failures and claim expiry; cleared only when its labels are recorded, when Shippo
  -- confirms nothing was bought for it, or by a manager cancel. While set, the chosen rate is
  -- pinned, so the next Buy adopts the paid labels instead of buying a different rate.
  add column if not exists buy_outstanding_rate_id text,
  add column if not exists buy_error text,
  add column if not exists tracking_status text,
  add column if not exists shipped_at timestamptz,
  -- append-only operator / anomaly notes (never overwritten)
  add column if not exists notes text not null default '';

-- One row per carrier parcel. A box shipment has one parcel per ship box (dims and weight read
-- live from the box and its size — never copied); a walk-in parcel carries its own gross
-- weight and dims. Label fields are filled when the label is bought (one Shippo transaction
-- per parcel); the ZPL is stored so reprints never call Shippo.
create table if not exists public.shipment_parcel (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  shipment_id uuid not null references public.shipment (id) on delete cascade,
  seq int not null check (seq >= 0),
  box_plan_id uuid references public.box_plan (id),
  length_in numeric(6,1) check (length_in > 0),
  width_in numeric(6,1) check (width_in > 0),
  height_in numeric(6,1) check (height_in > 0),
  weight_lb numeric(10,2) check (weight_lb > 0),
  dry_ice_lb numeric(10,2) not null default 0 check (dry_ice_lb >= 0),
  shippo_transaction_id text,
  tracking_number text,
  label_url text,
  label_zpl text,
  tracking_status text,
  label_printed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipment_id, seq),
  check (box_plan_id is not null
         or (length_in is not null and width_in is not null and height_in is not null
             and weight_lb is not null))
);

create unique index if not exists shipment_parcel_transaction
  on public.shipment_parcel (shippo_transaction_id) where shippo_transaction_id is not null;
create index if not exists shipment_parcel_tracking
  on public.shipment_parcel (tracking_number) where tracking_number is not null;
create index if not exists shipment_parcel_box on public.shipment_parcel (box_plan_id)
  where box_plan_id is not null;

select app.track_updated_at('public.shipment_parcel');
select app.enable_org_rls('public.shipment_parcel', write_roles => '{}');

-- Helpers --------------------------------------------------------------------------------------

-- A ship-to / ship-from address: known keys only, strings, trimmed, empties dropped, state and
-- country upper-cased (country defaults to US). Raises on anything else.
create or replace function app.clean_address(p_address jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_text text;
begin
  if p_address is null or jsonb_typeof(p_address) <> 'object' then
    raise exception 'address must be an object' using errcode = '22023';
  end if;
  for v_key, v_val in select * from jsonb_each(p_address) loop
    if v_key not in ('name', 'company', 'street1', 'street2', 'city', 'state', 'zip', 'country',
                     'phone', 'email') then
      raise exception 'unknown address field %', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(v_val) = 'null' then continue; end if;
    if jsonb_typeof(v_val) <> 'string' then
      raise exception 'address field % must be text', v_key using errcode = '22023';
    end if;
    v_text := btrim(v_val #>> '{}');
    if length(v_text) > 200 then
      raise exception 'address field % is too long', v_key using errcode = '22023';
    end if;
    if v_key in ('state', 'country') then v_text := upper(v_text); end if;
    if v_text <> '' then v_out := v_out || jsonb_build_object(v_key, v_text); end if;
  end loop;
  if not v_out ? 'country' then v_out := v_out || '{"country": "US"}'::jsonb; end if;
  return v_out;
end;
$$;

create or replace function app.blockers_with(p_blockers jsonb, p_add text[], p_remove text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(b) order by n), '[]'::jsonb)
  from (
    select b, min(n) as n from (
      select coalesce(x.b ->> 'code', x.b #>> '{}') as b, x.n
      from jsonb_array_elements(case when jsonb_typeof(p_blockers) = 'array' then p_blockers
                                     else '[]'::jsonb end) with ordinality as x (b, n)
      union all
      select a, 1000 + i from unnest(coalesce(p_add, '{}')) with ordinality as y (a, i)
    ) s
    where not b = any (coalesce(p_remove, '{}'))
    group by b
  ) d
$$;

-- The calling station's site, else the org's default site.
create or replace function app.caller_site()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select d.site_id from public.device d where d.id = app.device_id() and d.org_id = app.org_id()),
    (select s.id from public.site s where s.org_id = app.org_id() and s.is_default))
$$;

create or replace function app.shipment_note(p_shipment_id uuid, p_text text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shipment
  set notes = notes || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z ' || p_text || E'\n'
  where id = p_shipment_id
$$;

-- Locks and returns the caller's shipment (org-checked).
create or replace function app.lock_shipment(p_org uuid, p_shipment_id uuid)
returns public.shipment
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.shipment;
begin
  select * into v from public.shipment where id = p_shipment_id and org_id = p_org for update;
  if not found then
    raise exception 'shipment not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- Why the chosen rate cannot change right now, or null: a live purchase claim, or a purchase
-- that reached Shippo and is not recorded yet. Every rate-changing path checks this.
create or replace function app.shipment_rate_lock(p_sh public.shipment)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_sh.buy_outstanding_rate_id is not null then
      format('a label purchase for %s (rate %s) reached Shippo and is not recorded yet; press Buy to fetch it, or a manager cancels and refunds it',
             p_sh.number, p_sh.buy_outstanding_rate_id)
    when p_sh.buy_claimed_at > now() - interval '5 minutes' then
      format('a label purchase for %s is in progress', p_sh.number)
  end
$$;

create or replace function app.require_rate_unlocked(p_sh public.shipment)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_reason text := app.shipment_rate_lock(p_sh);
begin
  if v_reason is not null then
    raise exception '%', v_reason using errcode = '55006';
  end if;
end;
$$;

-- Re-evaluates the date hold after a write: draft → held when the gate says held. (A held
-- shipment stays `held` — there is no held → draft edge; the gate is evaluated live on every
-- buy and on the queue, so a stale `held` never blocks a buy.)
create or replace function app.shipment_sync_hold(p_shipment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.shipment;
begin
  select * into v from public.shipment where id = p_shipment_id;
  if v.state = 'draft' and (app.shipment_gate(v, false) ->> 'held')::boolean then
    update public.shipment set state = 'held' where id = p_shipment_id;
  end if;
end;
$$;

-- Parcels as the route handlers and the screen read them: box parcels carry the box's fish
-- weight and its size's dims (packaging_lb / dry_ice_lb included); the gross weight rule is
-- packages/shipping boxParcel. Walk-in parcels carry their own gross weight.
create or replace function app.shipment_parcels(p_shipment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'parcel_id', p.id, 'seq', p.seq, 'box_plan_id', p.box_plan_id, 'box_number', b.number,
    'box_state', b.fulfillment_state, 'box_size', bs.name,
    'kind', case when p.box_plan_id is null then 'walkin' else 'box' end,
    'weight_lb', coalesce(p.weight_lb, b.weight_lb),
    'dims', case when p.box_plan_id is null
                 then jsonb_build_object('length_in', p.length_in, 'width_in', p.width_in,
                                         'height_in', p.height_in, 'dry_ice_lb', p.dry_ice_lb)
                 else coalesce(bs.dims, '{}'::jsonb) end,
    'tracking_number', p.tracking_number, 'tracking_status', p.tracking_status,
    'label_url', p.label_url, 'has_label', p.label_zpl is not null,
    'label_printed_at', p.label_printed_at) order by p.seq), '[]'::jsonb)
  from public.shipment_parcel p
  left join public.box_plan b on b.id = p.box_plan_id
  left join public.box_size bs on bs.id = b.box_size_id
  where p.shipment_id = p_shipment_id
$$;

create or replace function app.shipment_json(p_shipment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'shipment_id', sh.id, 'number', sh.number, 'state', sh.state, 'is_walkin', sh.is_walkin,
    'customer_id', sh.customer_id, 'customer_name', c.name,
    'angler_name', (select st.angler_name from public.box_plan b
                    join public.settlement st on st.id = b.settlement_id
                    where b.id = any (sh.box_plan_ids) order by b.number limit 1),
    'session_number', (select s.number from public.box_plan b
                       join public.allocation_session s on s.id = b.session_id
                       where b.id = any (sh.box_plan_ids) order by b.number limit 1),
    'ship_to', sh.ship_to, 'ship_date', sh.ship_date,
    'site_id', sh.site_id, 'ship_from', si.ship_from,
    'carrier', sh.carrier, 'service', sh.service, 'rate_amount', sh.rate_amount,
    'shippo_rate_id', sh.shippo_rate_id, 'shippo_shipment_id', sh.shippo_shipment_id,
    'rate_shop', sh.rate_shop, 'address_check', sh.address_check,
    'tracking_number', sh.tracking_number, 'tracking_status', sh.tracking_status,
    'shipped_at', sh.shipped_at, 'notes', sh.notes,
    'blockers', sh.blockers,
    'buying', sh.buy_claimed_at is not null and sh.buy_claimed_at > now() - interval '5 minutes',
    'buy_error', sh.buy_error,
    'purchase_outstanding', sh.buy_outstanding_rate_id is not null,
    'rate_lock', app.shipment_rate_lock(sh),
    'gate', app.shipment_gate(sh, false),
    'today', app.org_today(sh.org_id),
    'allowlist', coalesce(o.settings #> '{shipping,carrier_allowlist}', '"*"'::jsonb),
    'parcels', app.shipment_parcels(sh.id),
    'created_at', sh.created_at)
  from public.shipment sh
  join public.org o on o.id = sh.org_id
  left join public.customer c on c.id = sh.customer_id
  left join public.site si on si.id = sh.site_id
  where sh.id = p_shipment_id
$$;

-- Station calls --------------------------------------------------------------------------------

-- A shipment for one angler's ship boxes (planned or packed, not already in a live shipment).
-- One parcel per box. Starts `draft` (or `held` when the ship date is past the buy window) with
-- the address unverified.
create or replace function public.create_shipment(
  p_client_action_id text, p_box_plan_ids uuid[], p_ship_to jsonb, p_ship_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_ids uuid[];
  v_box record;
  v_settlement uuid;
  v_customer uuid;
  v_id uuid;
  v_seq int := 0;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.create', jsonb_build_object(
    'box_plan_ids', p_box_plan_ids, 'ship_to', p_ship_to, 'ship_date', p_ship_date));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_ids from unnest(p_box_plan_ids) x;
  if cardinality(v_ids) = 0 then
    raise exception 'pick at least one ship box' using errcode = '22023';
  end if;

  -- Lock the boxes (sorted ids) so two desks cannot put one box in two shipments.
  for v_box in
    select b.id, b.number, b.method, b.fulfillment_state, b.shipment_id, b.settlement_id,
           st.customer_id, s.state as session_state
    from public.box_plan b
    join public.settlement st on st.id = b.settlement_id
    join public.allocation_session s on s.id = b.session_id
    where b.id = any (v_ids) and b.org_id = v_org
    order by b.id
    for update of b
  loop
    if v_box.method <> 'ship' then
      raise exception '% is not a ship box', v_box.number using errcode = '22023';
    end if;
    if v_box.fulfillment_state not in ('planned', 'packed') then
      raise exception '% is already %', v_box.number, v_box.fulfillment_state using errcode = '55000';
    end if;
    if v_box.session_state = 'cancelled' then
      raise exception '% belongs to a cancelled session', v_box.number using errcode = '55000';
    end if;
    if v_box.shipment_id is not null then
      raise exception '% is already in shipment %', v_box.number,
        (select number from public.shipment where id = v_box.shipment_id) using errcode = '55000';
    end if;
    if v_settlement is not null and v_settlement <> v_box.settlement_id then
      raise exception 'a shipment holds one angler''s boxes' using errcode = '22023';
    end if;
    v_settlement := v_box.settlement_id;
    v_customer := v_box.customer_id;
    v_seq := v_seq + 1;
  end loop;
  if v_seq <> cardinality(v_ids) then
    raise exception 'box not found' using errcode = 'P0002';
  end if;

  insert into public.shipment (org_id, number, box_plan_ids, customer_id, ship_to, ship_date,
                               site_id, blockers)
  values (v_org, app.next_seq(v_org, 'shipment'), v_ids, v_customer,
          app.clean_address(coalesce(p_ship_to, '{}'::jsonb)), p_ship_date, app.caller_site(),
          '["address_unverified"]'::jsonb)
  returning id into v_id;

  insert into public.shipment_parcel (org_id, shipment_id, seq, box_plan_id)
  select v_org, v_id, (row_number() over (order by b.number)) - 1, b.id
  from public.box_plan b where b.id = any (v_ids);
  update public.box_plan set shipment_id = v_id where id = any (v_ids);

  perform app.shipment_sync_hold(v_id);
  v_result := app.shipment_json(v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- A walk-in shipment: a customer's own packed parcels (gross weight and dims as measured at the
-- desk), no box plans.
create or replace function public.create_walkin_shipment(
  p_client_action_id text, p_customer_id uuid, p_ship_to jsonb, p_ship_date date, p_parcels jsonb
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
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.create_walkin', jsonb_build_object(
    'customer_id', p_customer_id, 'ship_to', p_ship_to, 'ship_date', p_ship_date,
    'parcels', p_parcels));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if p_customer_id is not null
     and not exists (select 1 from public.customer where id = p_customer_id and org_id = v_org) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_parcels) <> 'array' or jsonb_array_length(p_parcels) not between 1 and 20 then
    raise exception 'a walk-in shipment has 1 to 20 parcels' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_parcels) p
    where jsonb_typeof(p) <> 'object'
       or exists (select 1 from jsonb_object_keys(p) k
                  where k not in ('length_in', 'width_in', 'height_in', 'weight_lb', 'dry_ice_lb'))
       or exists (select 1 from unnest(array['length_in', 'width_in', 'height_in', 'weight_lb']) k
                  where jsonb_typeof(p -> k) is distinct from 'number' or (p ->> k)::numeric <= 0
                     or (p ->> k)::numeric > 999)
       or (p ? 'dry_ice_lb' and (jsonb_typeof(p -> 'dry_ice_lb') <> 'number'
                                 or (p ->> 'dry_ice_lb')::numeric < 0))
  ) then
    raise exception 'each parcel needs length / width / height in inches and a weight in lb, all above 0'
      using errcode = '22023';
  end if;

  insert into public.shipment (org_id, number, customer_id, ship_to, ship_date, site_id,
                               is_walkin, blockers)
  values (v_org, app.next_seq(v_org, 'shipment'), p_customer_id,
          app.clean_address(coalesce(p_ship_to, '{}'::jsonb)), p_ship_date, app.caller_site(),
          true, '["address_unverified"]'::jsonb)
  returning id into v_id;

  insert into public.shipment_parcel (org_id, shipment_id, seq, length_in, width_in, height_in,
                                      weight_lb, dry_ice_lb)
  select v_org, v_id, (x.n - 1)::int, (x.p ->> 'length_in')::numeric, (x.p ->> 'width_in')::numeric,
         (x.p ->> 'height_in')::numeric, (x.p ->> 'weight_lb')::numeric,
         coalesce((x.p ->> 'dry_ice_lb')::numeric, 0)
  from jsonb_array_elements(p_parcels) with ordinality as x (p, n);

  perform app.shipment_sync_hold(v_id);
  v_result := app.shipment_json(v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Edit the address and / or ship date of a shipment that has no label yet. A changed address
-- must be verified again and re-rated (rates were quoted for the old one).
create or replace function public.update_shipment(
  p_client_action_id text, p_shipment_id uuid, p_ship_to jsonb, p_ship_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_sh public.shipment;
  v_to jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.update', jsonb_build_object(
    'shipment_id', p_shipment_id, 'ship_to', p_ship_to, 'ship_date', p_ship_date));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_sh := app.lock_shipment(v_org, p_shipment_id);
  if v_sh.state not in ('draft', 'held') then
    raise exception '% has a label (%); cancel it to change the address or date', v_sh.number, v_sh.state
      using errcode = '55000';
  end if;
  perform app.require_rate_unlocked(v_sh);

  v_to := app.clean_address(coalesce(p_ship_to, '{}'::jsonb));
  if v_to is distinct from v_sh.ship_to then
    update public.shipment
    set ship_to = v_to, address_check = null,
        blockers = app.blockers_with(blockers, '{address_unverified}', '{bad_address}'),
        rate_shop = null, shippo_shipment_id = null, shippo_rate_id = null,
        carrier = null, service = null, rate_amount = null
    where id = v_sh.id;
  end if;
  update public.shipment set ship_date = p_ship_date where id = v_sh.id;

  perform app.shipment_sync_hold(v_sh.id);
  v_result := app.shipment_json(v_sh.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Choose one of the shipment's last shopped rates (allowlisted when shopped). Rate Check quotes
-- are never stored on a shipment, so they cannot be bought.
create or replace function public.select_shipment_rate(
  p_client_action_id text, p_shipment_id uuid, p_rate_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_sh public.shipment;
  v_rate jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.select_rate', jsonb_build_object(
    'shipment_id', p_shipment_id, 'rate_id', p_rate_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_sh := app.lock_shipment(v_org, p_shipment_id);
  if v_sh.state not in ('draft', 'held') then
    raise exception '% already has a label' , v_sh.number using errcode = '55000';
  end if;
  perform app.require_rate_unlocked(v_sh);
  select r into v_rate
  from jsonb_array_elements(coalesce(v_sh.rate_shop -> 'rates', '[]'::jsonb)) r
  where r ->> 'rateId' = p_rate_id;
  if v_rate is null then
    raise exception 'that rate is not one of %''s current rates; shop rates again', v_sh.number
      using errcode = '22023';
  end if;

  update public.shipment
  set shippo_rate_id = v_rate ->> 'rateId',
      carrier = v_rate ->> 'carrier',
      service = coalesce(nullif(v_rate ->> 'service', ''), v_rate ->> 'serviceToken'),
      rate_amount = (v_rate ->> 'amount')::numeric
  where id = v_sh.id;

  v_result := app.shipment_json(v_sh.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Step 1 of a buy: the I13 / I13b / I14 gate, evaluated now under the row lock, then a purchase
-- claim. Held (ship date past today + window) is reported as info with every real blocker
-- alongside it (I13b) and buys nothing; manager Buy Now (p_force_buy_held + a live elevation)
-- lifts the date hold only — blockers survive it (I14). A claim younger than 5 minutes refuses
-- a second concurrent buy.
-- The result is a CLAIM, not permission to pay: the /api/shipping/buy route must first consume
-- it with shipping_start_purchase (single use, re-checks the shipment and the gate now), and
-- only then buys at Shippo and records the labels (shipping_record_labels). A replayed
-- client_action_id returns the stored claim marked `replayed`; its claim id is spent or stale,
-- so the replay can never start a second purchase.
create or replace function public.begin_label_buy(
  p_client_action_id text, p_shipment_id uuid, p_force_buy_held boolean default false,
  p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_sh public.shipment;
  v_force boolean := coalesce(p_force_buy_held, false);
  v_manager uuid;
  v_gate jsonb;
  v_parcels int;
  v_claim uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if v_force then
    v_manager := app.require_elevation(p_elevation_token);
  end if;
  v_action := app.action_begin(p_client_action_id, 'shipping.begin_buy', jsonb_build_object(
    'shipment_id', p_shipment_id, 'force_buy_held', v_force, 'manager_member_id', v_manager));
  if v_action ->> 'status' = 'done' then
    return (v_action -> 'result') || '{"replayed": true}'::jsonb;
  end if;

  v_sh := app.lock_shipment(v_org, p_shipment_id);
  if v_sh.state in ('label_bought', 'shipped') then
    raise exception '% already has its label; reprint it instead', v_sh.number using errcode = '55000';
  end if;
  if v_sh.state = 'cancelled' then
    raise exception '% is cancelled', v_sh.number using errcode = '55000';
  end if;
  if v_sh.buy_claimed_at > now() - interval '5 minutes' then
    raise exception 'a label purchase for % is already in progress', v_sh.number using errcode = '55006';
  end if;
  -- An outstanding purchase is recovered on its own rate (the pin makes these equal).
  if v_sh.buy_outstanding_rate_id is not null
     and v_sh.buy_outstanding_rate_id is distinct from v_sh.shippo_rate_id then
    raise exception '% has an outstanding purchase on rate %; it must be recovered first', v_sh.number,
      v_sh.buy_outstanding_rate_id using errcode = '55000';
  end if;

  v_gate := app.shipment_gate(v_sh, v_force);
  select count(*) into v_parcels from public.shipment_parcel where shipment_id = v_sh.id;

  if not (v_gate ->> 'can_buy')::boolean or v_sh.shippo_rate_id is null then
    perform app.shipment_sync_hold(v_sh.id);
    v_result := jsonb_build_object('ok', false, 'shipment_id', v_sh.id, 'number', v_sh.number,
      'held', (v_gate ->> 'held')::boolean, 'blockers', v_gate -> 'blockers', 'gate', v_gate);
  else
    v_claim := gen_random_uuid();
    update public.shipment
    set buy_claim_id = v_claim, buy_claimed_at = now(), buy_claim_forced = v_force,
        buy_purchase_started_at = null, buy_error = null
    where id = v_sh.id;
    if v_force and (app.shipment_gate(v_sh, false) ->> 'held')::boolean then
      perform app.shipment_note(v_sh.id, 'Buy Now: held label bought early by manager '
        || coalesce((select display_name from public.org_member where id = v_manager), v_manager::text));
    end if;
    v_result := jsonb_build_object('ok', true, 'shipment_id', v_sh.id, 'number', v_sh.number,
      'held', false, 'blockers', '[]'::jsonb, 'gate', v_gate, 'claim_id', v_claim,
      'rate_id', v_sh.shippo_rate_id, 'shippo_shipment_id', v_sh.shippo_shipment_id,
      'parcel_count', v_parcels, 'forced', v_force);
  end if;

  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Print (or reprint) every parcel's label: one shipping_label ZPL job per parcel, from the
-- stored ZPL. Reprinting a bought label is ALWAYS allowed — the date hold gates buying, never
-- printing (I13, P24).
create or replace function public.print_shipment_labels(p_client_action_id text, p_shipment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_sh public.shipment;
  v_printer uuid;
  v_jobs int := 0;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.print_labels',
    jsonb_build_object('shipment_id', p_shipment_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_sh from public.shipment where id = p_shipment_id and org_id = v_org;
  if not found then
    raise exception 'shipment not found' using errcode = 'P0002';
  end if;
  if not (app.shipment_gate(v_sh, false) ->> 'can_reprint')::boolean then
    raise exception '% has no label to print yet', v_sh.number using errcode = '55000';
  end if;

  v_printer := app.station_printer(coalesce(v_sh.site_id, app.caller_site()), 'label_zpl',
                                   'shipping_label');
  if v_printer is not null then
    insert into public.print_job (org_id, printer_id, kind, payload_type, payload, source)
    select v_org, v_printer, 'shipping_label', 'zpl', p.label_zpl, jsonb_build_object(
      'template', 'shipping_label', 'shipment_id', v_sh.id, 'shipment_number', v_sh.number,
      'parcel_seq', p.seq, 'tracking_number', p.tracking_number)
    from public.shipment_parcel p
    where p.shipment_id = v_sh.id and p.label_zpl is not null
    order by p.seq;
    get diagnostics v_jobs = row_count;
    update public.shipment_parcel set label_printed_at = now()
    where shipment_id = v_sh.id and label_zpl is not null;
    update public.box_plan b set label_printed_at = now()
    from public.shipment_parcel p
    where p.shipment_id = v_sh.id and p.box_plan_id = b.id and p.label_zpl is not null;
  end if;

  v_result := jsonb_build_object('shipment_id', v_sh.id, 'number', v_sh.number, 'jobs', v_jobs,
    'printer_missing', v_printer is null);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- The carrier has it: label_bought → shipped, and every box packed → shipped. A box still
-- `planned` has not been released through boxing (WP-15), so it refuses — ship after release.
create or replace function app.ship_shipment(p_sh public.shipment, p_how text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.shipment set state = 'shipped', shipped_at = now() where id = p_sh.id;
  update public.box_plan set fulfillment_state = 'shipped'
  where shipment_id = p_sh.id and fulfillment_state = 'packed';
  perform app.emit_event(p_sh.org_id, 'shipment_shipped', p_sh.id, jsonb_build_object(
    'number', p_sh.number, 'tracking_number', p_sh.tracking_number, 'carrier', p_sh.carrier,
    'customer_id', p_sh.customer_id, 'how', p_how));
end;
$$;

create or replace function public.mark_shipment_shipped(p_client_action_id text, p_shipment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_sh public.shipment;
  v_unpacked text;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.mark_shipped',
    jsonb_build_object('shipment_id', p_shipment_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_sh := app.lock_shipment(v_org, p_shipment_id);
  if v_sh.state <> 'label_bought' then
    raise exception '% is %; only a shipment with a bought label can be marked shipped',
      v_sh.number, v_sh.state using errcode = '55000';
  end if;
  select string_agg(b.number, ', ' order by b.number) into v_unpacked
  from public.box_plan b where b.shipment_id = v_sh.id and b.fulfillment_state = 'planned';
  if v_unpacked is not null then
    raise exception 'release % at boxing before shipping', v_unpacked using errcode = '55000';
  end if;

  perform app.ship_shipment(v_sh, 'manual');
  v_result := app.shipment_json(v_sh.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Cancel. Without a label anyone at the desk may; a bought label needs a manager (the label
-- must also be refunded in Shippo — v1 records that as a note, it does not call Shippo). A
-- shipped shipment is not cancelled here. The boxes go back to the unassigned ship-box queue.
create or replace function public.cancel_shipment(
  p_client_action_id text, p_shipment_id uuid, p_reason text, p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_sh public.shipment;
  v_manager uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'shipping.cancel', jsonb_build_object(
    'shipment_id', p_shipment_id, 'reason', p_reason));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'give a reason to cancel' using errcode = '22023';
  end if;
  v_sh := app.lock_shipment(v_org, p_shipment_id);
  if v_sh.state in ('shipped', 'cancelled') then
    raise exception '% is already %', v_sh.number, v_sh.state using errcode = '55000';
  end if;
  if v_sh.buy_claimed_at > now() - interval '5 minutes' then
    raise exception 'a label purchase for % is in progress', v_sh.number using errcode = '55006';
  end if;
  if v_sh.state = 'label_bought' or v_sh.buy_outstanding_rate_id is not null then
    v_manager := app.require_elevation(p_elevation_token);
  end if;

  update public.shipment set state = 'cancelled', buy_outstanding_rate_id = null where id = v_sh.id;
  if v_sh.buy_outstanding_rate_id is not null then
    perform app.shipment_note(v_sh.id, 'Cancelled with an unrecorded purchase on rate '
      || v_sh.buy_outstanding_rate_id || ': check Shippo and refund any label bought for it');
  end if;
  update public.box_plan set shipment_id = null where shipment_id = v_sh.id;
  perform app.shipment_note(v_sh.id, 'Cancelled: ' || btrim(p_reason)
    || case when v_sh.state = 'label_bought'
            then ' — label ' || coalesce(v_sh.tracking_number, '') || ' must be refunded in Shippo'
            else '' end);

  v_result := app.shipment_json(v_sh.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- One shipment, as the screen and the route handlers read it.
create or replace function public.shipment_detail(p_shipment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if not exists (select 1 from public.shipment where id = p_shipment_id and org_id = app.org_id()) then
    raise exception 'shipment not found' using errcode = 'P0002';
  end if;
  v_result := app.shipment_json(p_shipment_id);
  return v_result;
end;
$$;

-- The shipping queue: every open shipment (draft / held / label_bought) plus shipped and
-- cancelled ones from the last p_days, each with its live gate; and the ship boxes not yet in
-- a shipment, grouped by angler. The screen filters this set.
create or replace function public.shipping_queue(p_days int default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  return jsonb_build_object(
    'today', app.org_today(v_org),
    'shipments', coalesce((
      select jsonb_agg(app.shipment_json(sh.id) order by sh.ship_date nulls first, sh.number)
      from public.shipment sh
      where sh.org_id = v_org
        and (sh.state in ('draft', 'held', 'label_bought')
             or sh.updated_at > now() - make_interval(days => greatest(coalesce(p_days, 14), 0)))
    ), '[]'::jsonb),
    'unassigned', coalesce((
      select jsonb_agg(g order by g ->> 'session_number', g ->> 'settlement_number')
      from (
        select jsonb_build_object(
          'settlement_id', st.id, 'settlement_number', st.number, 'angler_name', st.angler_name,
          'customer_id', st.customer_id, 'customer_name', c.name,
          'session_number', s.number,
          'boxes', jsonb_agg(jsonb_build_object(
            'box_plan_id', b.id, 'number', b.number, 'state', b.fulfillment_state,
            'weight_lb', b.weight_lb, 'box_size', bs.name, 'dims', coalesce(bs.dims, '{}'::jsonb))
            order by b.number)) as g
        from public.box_plan b
        join public.settlement st on st.id = b.settlement_id
        join public.allocation_session s on s.id = b.session_id
        left join public.customer c on c.id = st.customer_id
        left join public.box_size bs on bs.id = b.box_size_id
        where b.org_id = v_org and b.method = 'ship' and b.shipment_id is null
          and b.fulfillment_state in ('planned', 'packed') and s.state <> 'cancelled'
        group by st.id, st.number, st.angler_name, st.customer_id, c.name, s.number
      ) x
    ), '[]'::jsonb));
end;
$$;

-- Manager: where a site's shipments ship from.
create or replace function public.admin_set_ship_from(
  p_client_action_id text, p_site_id uuid, p_address jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_addr jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'site.ship_from', jsonb_build_object(
    'site_id', p_site_id, 'address', p_address));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_addr := case when p_address is null then null else app.clean_address(p_address) end;
  if v_addr is not null and exists (
    select 1 from unnest(array['name', 'street1', 'city', 'state', 'zip']) k where not v_addr ? k
  ) then
    raise exception 'ship-from needs a name, street, city, state and ZIP' using errcode = '22023';
  end if;
  update public.site set ship_from = v_addr where id = p_site_id and org_id = v_org;
  if not found then
    raise exception 'site not found' using errcode = 'P0002';
  end if;

  v_result := jsonb_build_object('site_id', p_site_id, 'ship_from', v_addr);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Box sizes: cold-chain weights per size (docs/07 §4 — packaging + dry ice weight added per box
-- size). Same function as WP-14 with two more dims keys, packaging_lb and dry_ice_lb (≥ 0).
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
    where d.key not in ('length_in', 'width_in', 'height_in', 'packaging_lb', 'dry_ice_lb')
       or jsonb_typeof(d.value) <> 'number'
       or (d.key in ('length_in', 'width_in', 'height_in') and (d.value #>> '{}')::numeric <= 0)
       or (d.value #>> '{}')::numeric < 0
  ) then
    raise exception 'dims are length_in / width_in / height_in (more than 0) and packaging_lb / dry_ice_lb (0 or more)'
      using errcode = '22023';
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

-- Provider results (service_role only: the /api/shipping route handlers) ------------------------

-- The org's Shippo API key, from Vault (secret name `shippo_api_key:<org id>`). Null = shipping
-- not configured. Never stored in a table, an event or a log.
create or replace function public.shipping_api_key(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  where s.name = 'shippo_api_key:' || p_org_id::text
  limit 1
$$;

-- Address check result for the address that was checked (p_checked). If the address changed
-- since, the result is stale and ignored.
create or replace function public.shipping_record_address(
  p_org_id uuid, p_shipment_id uuid, p_checked jsonb, p_valid boolean, p_normalized jsonb,
  p_messages jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sh public.shipment;
  v_normalized jsonb;
begin
  v_sh := app.lock_shipment(p_org_id, p_shipment_id);
  if v_sh.state not in ('draft', 'held') or v_sh.ship_to is distinct from p_checked then
    return jsonb_build_object('stale', true, 'shipment', app.shipment_json(v_sh.id));
  end if;
  if app.shipment_rate_lock(v_sh) is not null then
    return jsonb_build_object('stale', true, 'reason', app.shipment_rate_lock(v_sh),
      'shipment', app.shipment_json(v_sh.id));
  end if;
  v_normalized := case when p_valid and jsonb_typeof(p_normalized) = 'object'
                       then app.clean_address(p_normalized) else v_sh.ship_to end;
  if p_valid then
    update public.shipment
    set ship_to = v_normalized,
        blockers = app.blockers_with(blockers, '{}', '{address_unverified,bad_address}')
    where id = v_sh.id;
  else
    update public.shipment
    set blockers = app.blockers_with(blockers, '{bad_address}', '{address_unverified}')
    where id = v_sh.id;
  end if;
  update public.shipment
  set address_check = jsonb_build_object('valid', p_valid, 'at', now(),
        'messages', case when jsonb_typeof(p_messages) = 'array' then p_messages else '[]'::jsonb end)
  where id = v_sh.id;
  -- A normalised address is what was rated against from now on.
  if v_normalized is distinct from v_sh.ship_to then
    update public.shipment
    set rate_shop = null, shippo_shipment_id = null, shippo_rate_id = null,
        carrier = null, service = null, rate_amount = null
    where id = v_sh.id;
  end if;
  return jsonb_build_object('stale', false, 'shipment', app.shipment_json(v_sh.id));
end;
$$;

-- A rate shop for the address that was shopped (p_checked). Keeps the chosen rate only if it is
-- still among the new rates.
create or replace function public.shipping_record_rates(
  p_org_id uuid, p_shipment_id uuid, p_checked jsonb, p_shop jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sh public.shipment;
begin
  v_sh := app.lock_shipment(p_org_id, p_shipment_id);
  if v_sh.state not in ('draft', 'held') or v_sh.ship_to is distinct from p_checked then
    return jsonb_build_object('stale', true, 'shipment', app.shipment_json(v_sh.id));
  end if;
  -- A rate shop already in flight when a purchase started must not replace or clear its rate.
  perform app.require_rate_unlocked(v_sh);
  if jsonb_typeof(p_shop) <> 'object' or jsonb_typeof(p_shop -> 'rates') <> 'array' then
    raise exception 'rate shop must be an object with rates' using errcode = '22023';
  end if;
  update public.shipment
  set rate_shop = p_shop || jsonb_build_object('at', now()),
      shippo_shipment_id = p_shop ->> 'shippoShipmentId'
  where id = v_sh.id;
  if not exists (select 1 from jsonb_array_elements(p_shop -> 'rates') r
                 where r ->> 'rateId' = v_sh.shippo_rate_id) then
    update public.shipment
    set shippo_rate_id = null, carrier = null, service = null, rate_amount = null
    where id = v_sh.id;
  end if;
  return jsonb_build_object('stale', false, 'shipment', app.shipment_json(v_sh.id));
end;
$$;

-- The labels Shippo sold for the claimed rate: one per parcel, in parcel order. The money is
-- spent, so this records them whatever the gate says now. Idempotent for the same labels.
create or replace function public.shipping_record_labels(
  p_org_id uuid, p_shipment_id uuid, p_claim_id uuid, p_rate_id text, p_labels jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sh public.shipment;
  v_parcels int;
  v_first jsonb;
begin
  v_sh := app.lock_shipment(p_org_id, p_shipment_id);
  if jsonb_typeof(p_labels) <> 'array' or jsonb_array_length(p_labels) = 0 then
    raise exception 'labels must be a non-empty array' using errcode = '22023';
  end if;

  if v_sh.state in ('label_bought', 'shipped') then
    if v_sh.shippo_transaction_id = (p_labels -> 0 ->> 'transactionId') then
      return app.shipment_json(v_sh.id); -- the same purchase recorded twice
    end if;
    raise exception '% already has a different label', v_sh.number using errcode = '55000';
  end if;
  if v_sh.state = 'cancelled' then
    perform app.shipment_note(v_sh.id, 'Labels bought after cancel (' || (p_labels -> 0 ->> 'trackingNumber')
      || '): refund them in Shippo');
    return app.shipment_json(v_sh.id);
  end if;
  -- Only the purchase this claim started may record; a stale or replayed handler may not.
  if v_sh.buy_claim_id is distinct from p_claim_id or v_sh.buy_purchase_started_at is null then
    raise exception 'the purchase claim for % is no longer current; press Buy again to fetch the labels',
      v_sh.number using errcode = '55000';
  end if;
  if v_sh.shippo_rate_id is distinct from p_rate_id then
    raise exception 'labels are for rate %, but % is set to rate %', p_rate_id, v_sh.number,
      v_sh.shippo_rate_id using errcode = '55000';
  end if;
  select count(*) into v_parcels from public.shipment_parcel where shipment_id = v_sh.id;
  if jsonb_array_length(p_labels) <> v_parcels then
    raise exception '% has % parcels; every parcel needs its label', v_sh.number, v_parcels
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_labels) l
             where coalesce(l ->> 'transactionId', '') = '' or coalesce(l ->> 'trackingNumber', '') = ''
                or coalesce(l ->> 'zpl', '') = '') then
    raise exception 'every label needs a transaction, a tracking number and its ZPL' using errcode = '22023';
  end if;

  update public.shipment_parcel p
  set shippo_transaction_id = l ->> 'transactionId', tracking_number = l ->> 'trackingNumber',
      label_url = l ->> 'labelUrl', label_zpl = l ->> 'zpl'
  from jsonb_array_elements(p_labels) l
  where p.shipment_id = v_sh.id and p.seq = (l ->> 'parcelIndex')::int;

  v_first := p_labels -> 0;
  update public.shipment
  set state = 'label_bought', shippo_transaction_id = v_first ->> 'transactionId',
      tracking_number = v_first ->> 'trackingNumber', label_url = v_first ->> 'labelUrl',
      buy_claim_id = null, buy_claimed_at = null, buy_claim_forced = false,
      buy_purchase_started_at = null, buy_outstanding_rate_id = null, buy_error = null
  where id = v_sh.id;
  return app.shipment_json(v_sh.id);
end;
$$;

-- A buy that did not finish, reported by the handler that holds the claim (a stale or replayed
-- handler's report is ignored, so it cannot clear a live claim). Clears the claim and keeps the
-- reason. p_charged is what the handler found at Shippo afterwards for the rate: false = no
-- transaction exists (nothing was bought) → the rate is unpinned; true or null (unknown) → the
-- rate stays pinned and the desk is told, so the next Buy adopts the paid labels — never buys a
-- different rate on top of them.
create or replace function public.shipping_buy_failed(
  p_org_id uuid, p_shipment_id uuid, p_claim_id uuid, p_error text, p_charged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sh public.shipment;
  v_unpin boolean;
begin
  v_sh := app.lock_shipment(p_org_id, p_shipment_id);
  if v_sh.buy_claim_id is distinct from p_claim_id then
    return app.shipment_json(v_sh.id);
  end if;
  v_unpin := p_charged is not distinct from false;
  update public.shipment
  set buy_claim_id = null, buy_claimed_at = null, buy_claim_forced = false,
      buy_purchase_started_at = null, buy_error = left(coalesce(p_error, 'failed'), 500),
      buy_outstanding_rate_id = case when v_unpin then null else buy_outstanding_rate_id end
  where id = v_sh.id;
  if not v_unpin and v_sh.buy_outstanding_rate_id is not null then
    perform app.shipment_note(v_sh.id, 'Label purchase for rate ' || v_sh.buy_outstanding_rate_id
      || case when p_charged then ' was charged by Shippo' else ' may have been charged by Shippo' end
      || ' but not recorded (' || left(coalesce(p_error, 'failed'), 200)
      || '): the rate stays fixed — press Buy to fetch the labels, or a manager cancels and refunds them');
  end if;
  return app.shipment_json(v_sh.id);
end;
$$;

-- Step 2 of a buy: permission to call Shippo. Consumes the claim exactly once under the row
-- lock and re-validates against the shipment as it is NOW — same claim, not expired, not yet
-- started, still draft / held, a rate chosen, and the gate (with the claim's Buy Now flag)
-- still says buy. A replayed or concurrent duplicate request, or a claim overtaken by a
-- failure, cancel or edit, is refused here before any money moves.
create or replace function public.shipping_start_purchase(
  p_org_id uuid, p_shipment_id uuid, p_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sh public.shipment;
  v_parcels int;
begin
  v_sh := app.lock_shipment(p_org_id, p_shipment_id);
  if p_claim_id is null or v_sh.buy_claim_id is distinct from p_claim_id then
    raise exception 'the purchase claim for % is no longer current; press Buy again', v_sh.number
      using errcode = '55000';
  end if;
  if v_sh.buy_purchase_started_at is not null then
    raise exception 'the label purchase for % has already started', v_sh.number using errcode = '55006';
  end if;
  if v_sh.buy_claimed_at <= now() - interval '5 minutes' then
    raise exception 'the purchase claim for % expired; press Buy again', v_sh.number using errcode = '55000';
  end if;
  if v_sh.state not in ('draft', 'held') or v_sh.shippo_rate_id is null
     or not (app.shipment_gate(v_sh, v_sh.buy_claim_forced) ->> 'can_buy')::boolean then
    raise exception '% can no longer be bought (%)', v_sh.number, v_sh.state using errcode = '55000';
  end if;
  select count(*) into v_parcels from public.shipment_parcel where shipment_id = v_sh.id;
  update public.shipment
  set buy_purchase_started_at = now(), buy_outstanding_rate_id = v_sh.shippo_rate_id
  where id = v_sh.id;
  return jsonb_build_object('shipment_id', v_sh.id, 'number', v_sh.number, 'claim_id', p_claim_id,
    'rate_id', v_sh.shippo_rate_id, 'shippo_shipment_id', v_sh.shippo_shipment_id,
    'parcel_count', v_parcels);
end;
$$;

-- Shippo track_updated → parcel / shipment tracking status. When the carrier has it
-- (p_in_carrier_hands: TRANSIT or DELIVERED — packages/shipping isInCarrierHands) a
-- label_bought shipment becomes shipped. Unknown tracking numbers are acknowledged, not errors.
create or replace function public.shipping_apply_tracking(
  p_transaction_id text, p_tracking_number text, p_status text, p_in_carrier_hands boolean,
  p_details text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parcel public.shipment_parcel;
  v_sh public.shipment;
  v_unpacked text;
begin
  select * into v_parcel from public.shipment_parcel
  where (p_transaction_id is not null and shippo_transaction_id = p_transaction_id)
     or (tracking_number = p_tracking_number)
  order by (shippo_transaction_id = p_transaction_id) desc nulls last
  limit 1;
  if not found then
    return jsonb_build_object('matched', false);
  end if;
  v_sh := app.lock_shipment(v_parcel.org_id, v_parcel.shipment_id);

  update public.shipment_parcel set tracking_status = p_status where id = v_parcel.id;
  update public.shipment set tracking_status = p_status where id = v_sh.id;

  if coalesce(p_in_carrier_hands, false) and v_sh.state = 'label_bought' then
    select string_agg(b.number, ', ' order by b.number) into v_unpacked
    from public.box_plan b where b.shipment_id = v_sh.id and b.fulfillment_state = 'planned';
    perform app.ship_shipment(v_sh, 'tracking');
    if v_unpacked is not null then
      -- The carrier scanned boxes boxing never released: loud, never silently fixed (S6).
      perform app.shipment_note(v_sh.id, 'Carrier scanned ' || v_sh.number || ' but ' || v_unpacked
        || ' was never released at boxing');
    end if;
  elsif p_status in ('RETURNED', 'FAILURE') then
    perform app.shipment_note(v_sh.id, 'Carrier ' || lower(p_status) || ': '
      || coalesce(p_details, p_tracking_number));
  end if;

  return jsonb_build_object('matched', true, 'shipment_id', v_sh.id,
    'state', (select state from public.shipment where id = v_sh.id));
end;
$$;

-- Grants ---------------------------------------------------------------------------------------

revoke all on function
  app.clean_address(jsonb),
  app.blockers_with(jsonb, text[], text[]),
  app.caller_site(),
  app.shipment_note(uuid, text),
  app.lock_shipment(uuid, uuid),
  app.shipment_rate_lock(public.shipment),
  app.require_rate_unlocked(public.shipment),
  app.shipment_sync_hold(uuid),
  app.shipment_parcels(uuid),
  app.shipment_json(uuid),
  app.ship_shipment(public.shipment, text)
from public;

revoke all on function
  public.create_shipment(text, uuid[], jsonb, date),
  public.create_walkin_shipment(text, uuid, jsonb, date, jsonb),
  public.update_shipment(text, uuid, jsonb, date),
  public.select_shipment_rate(text, uuid, text),
  public.begin_label_buy(text, uuid, boolean, text),
  public.print_shipment_labels(text, uuid),
  public.mark_shipment_shipped(text, uuid),
  public.cancel_shipment(text, uuid, text, text),
  public.shipment_detail(uuid),
  public.shipping_queue(int),
  public.admin_set_ship_from(text, uuid, jsonb),
  public.admin_save_box_size(text, uuid, text, numeric, numeric, jsonb, boolean)
from public, anon, authenticated;

grant execute on function
  public.create_shipment(text, uuid[], jsonb, date),
  public.create_walkin_shipment(text, uuid, jsonb, date, jsonb),
  public.update_shipment(text, uuid, jsonb, date),
  public.select_shipment_rate(text, uuid, text),
  public.begin_label_buy(text, uuid, boolean, text),
  public.print_shipment_labels(text, uuid),
  public.mark_shipment_shipped(text, uuid),
  public.cancel_shipment(text, uuid, text, text),
  public.shipment_detail(uuid),
  public.shipping_queue(int),
  public.admin_set_ship_from(text, uuid, jsonb),
  public.admin_save_box_size(text, uuid, text, numeric, numeric, jsonb, boolean)
to authenticated;

-- Provider results and the Vault key: the route handlers' service role only.
revoke all on function
  public.shipping_api_key(uuid),
  public.shipping_record_address(uuid, uuid, jsonb, boolean, jsonb, jsonb),
  public.shipping_record_rates(uuid, uuid, jsonb, jsonb),
  public.shipping_record_labels(uuid, uuid, uuid, text, jsonb),
  public.shipping_buy_failed(uuid, uuid, uuid, text, boolean),
  public.shipping_start_purchase(uuid, uuid, uuid),
  public.shipping_apply_tracking(text, text, text, boolean, text)
from public, anon, authenticated;

grant execute on function
  public.shipping_api_key(uuid),
  public.shipping_record_address(uuid, uuid, jsonb, boolean, jsonb, jsonb),
  public.shipping_record_rates(uuid, uuid, jsonb, jsonb),
  public.shipping_record_labels(uuid, uuid, uuid, text, jsonb),
  public.shipping_buy_failed(uuid, uuid, uuid, text, boolean),
  public.shipping_start_purchase(uuid, uuid, uuid),
  public.shipping_apply_tracking(text, text, text, boolean, text)
to service_role;
