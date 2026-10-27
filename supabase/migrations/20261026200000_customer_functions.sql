-- Customers: phone-first search, inline create, lodge-guest flip, lodges and customer
-- admin (docs/02-DOMAIN-MODEL.md §2, docs/06-STATIONS-UX.md Intake, docs/04-BUSINESS-RULES.md §2).
-- `customer.phone_digits` and its prefix + trigram indexes ship with the schema
-- (20261026110000_customers.sql). Phones arrive here already E.164: typed input is
-- normalised by packages/rules/src/phone.ts; the table's check constraint validates.

-- Name fallback for searches without 3 digits (ilike '%…%' uses the trigram index).
create index if not exists customer_name_trgm on public.customer
  using gin (name extensions.gin_trgm_ops);

-- Customers are written rarely and searched on every intake: skip the GIN pending list so
-- fresh rows never make a search scan an unsorted backlog.
alter index public.customer_name_trgm set (fastupdate = off);
alter index public.customer_phone_digits_trgm set (fastupdate = off);

-- Search ------------------------------------------------------------------------------

-- Live dropdown search. Phone-first: once `p_q` has >= 3 digits (packages/rules
-- MIN_SEARCH_DIGITS) it matches anywhere in `phone_digits`, whatever the formatting
-- (`(907) 555-`, `907555`, `+1907…`); exact numbers first, then prefixes of the number
-- with or without its country code, then the most recent visit. Without 3 digits, a query
-- with >= 3 letters matches names. Anything else returns no rows: partial input never raises.
-- An end-user session only ever searches its own org: another `p_org_id` returns no rows.
-- security definer because under RLS the planner may not push the (non-leakproof) LIKE
-- into the trigram indexes and seq-scans every search; the org filter above stands in for
-- the policy (org_select: org_id = app.org_id()). The queries run through EXECUTE so each
-- call is planned for its actual pattern: a cached generic plan cannot tell a selective
-- pattern (index) from a broad one (scan).
-- Phones match with strpos(), deliberately not LIKE: digit trigrams are unselective (one
-- area code puts `190`/`907` in nearly every row), so the trigram index can be ~30x slower
-- than scanning the org's rows, and whether the planner picks it depends on the sample
-- ANALYZE drew. The org's rows are scanned instead (customer_org_phone): ~10 ms per 50k.
create or replace function public.search_customers(p_org_id uuid, p_q text, p_limit int default 10)
returns table (
  id uuid,
  name text,
  phone text,
  last_visit_at timestamptz,
  is_lodge_guest boolean,
  lodge_id uuid,
  lodge_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := btrim(left(coalesce(p_q, ''), 100));
  v_digits text := regexp_replace(v_q, '[^0-9]', '', 'g');
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_like text;
begin
  if p_org_id is null or (app.is_end_user() and p_org_id is distinct from app.org_id()) then
    return;
  end if;
  if length(v_digits) >= 3 then
    return query execute $sql$
      select c.id, c.name, c.phone, c.last_visit_at, c.is_lodge_guest, c.lodge_id, l.name
      from public.customer c
      left join public.lodge l on l.id = c.lodge_id
      where c.org_id = $1
        and strpos(c.phone_digits, $2) > 0
      order by
        (c.phone_digits = $2 or c.phone_digits = '1' || $2) desc,
        (c.phone_digits like $2 || '%' or c.phone_digits like '1' || $2 || '%') desc,
        c.last_visit_at desc nulls last,
        c.name,
        c.id
      limit $3
    $sql$ using p_org_id, v_digits, v_limit;
  elsif length(regexp_replace(v_q, '[^[:alpha:]]', '', 'g')) >= 3 then
    v_like := replace(replace(replace(v_q, '\', '\'), '%', '\%'), '_', '\_');
    return query execute $sql$
      select c.id, c.name, c.phone, c.last_visit_at, c.is_lodge_guest, c.lodge_id, l.name
      from public.customer c
      left join public.lodge l on l.id = c.lodge_id
      where c.org_id = $1
        and c.name ilike '%' || $2 || '%'
      order by
        (c.name ilike $2 || '%') desc,
        c.last_visit_at desc nulls last,
        c.name,
        c.id
      limit $3
    $sql$ using p_org_id, v_like, v_limit;
  end if;
end;
$$;

-- Station mutations (intake desk / register) ------------------------------------------

-- Inline create from the search dropdown. Shared numbers are allowed (households share a
-- phone); real duplicates are merged in /admin/customers.
create or replace function public.create_customer(
  p_client_action_id text, p_name text, p_phone text, p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_id uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'customer.create',
    jsonb_build_object('name', p_name, 'phone', p_phone));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  insert into public.customer (org_id, name, phone, email)
  values (app.org_id(), btrim(p_name), nullif(btrim(p_phone), ''), nullif(btrim(p_email), ''))
  returning id into v_id;

  v_result := jsonb_build_object('customer_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- The lodge-guest flip (docs/04-BUSINESS-RULES.md §2). Writes, in the same transaction, a
-- `customer_lodge_flag_changed` domain_event that WP-07's reprice consumes: it reprices the
-- customer's open, unpaid, non-Fast-Pass processing charges. The event fires whenever the
-- customer's (is_lodge_guest, lodge_id) changes, since the lodge decides the cap. Turning
-- the flag off clears the lodge; turning it on without `p_lodge_id` keeps the current lodge.
create or replace function public.set_lodge_guest(
  p_client_action_id text, p_customer_id uuid, p_is_lodge_guest boolean, p_lodge_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_customer public.customer;
  v_lodge uuid;
  v_event uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'customer.set_lodge_guest',
    jsonb_build_object('customer_id', p_customer_id, 'is_lodge_guest', p_is_lodge_guest,
      'lodge_id', p_lodge_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if p_is_lodge_guest is null then
    raise exception 'is_lodge_guest is required' using errcode = '22004';
  end if;
  if p_lodge_id is not null and not p_is_lodge_guest then
    raise exception 'only a lodge guest has a lodge' using errcode = '22023';
  end if;

  select * into v_customer from public.customer
  where id = p_customer_id and org_id = v_org
  for update;
  if not found then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;

  v_lodge := case when p_is_lodge_guest then coalesce(p_lodge_id, v_customer.lodge_id) end;
  if v_lodge is not null and not exists (
    select 1 from public.lodge where id = v_lodge and org_id = v_org
  ) then
    raise exception 'lodge not found' using errcode = 'P0002';
  end if;

  if (v_customer.is_lodge_guest, v_customer.lodge_id) is distinct from (p_is_lodge_guest, v_lodge) then
    update public.customer
    set is_lodge_guest = p_is_lodge_guest, lodge_id = v_lodge
    where id = p_customer_id;
    v_event := app.emit_event(v_org, 'customer_lodge_flag_changed', p_customer_id,
      jsonb_build_object(
        'is_lodge_guest', p_is_lodge_guest,
        'lodge_id', v_lodge,
        'previous_is_lodge_guest', v_customer.is_lodge_guest,
        'previous_lodge_id', v_customer.lodge_id
      ));
  end if;

  v_result := jsonb_build_object('customer_id', p_customer_id, 'is_lodge_guest', p_is_lodge_guest,
    'lodge_id', v_lodge, 'event_id', v_event);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Customers admin (owner/manager) -----------------------------------------------------

-- Contact details. The lodge flag goes through set_lodge_guest so the reprice hook fires.
create or replace function public.admin_update_customer(
  p_client_action_id text, p_customer_id uuid, p_name text, p_phone text, p_email text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'customer.update',
    jsonb_build_object('customer_id', p_customer_id, 'name', p_name, 'phone', p_phone));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  update public.customer
  set name = btrim(p_name),
      phone = nullif(btrim(p_phone), ''),
      email = nullif(btrim(p_email), ''),
      notes = nullif(btrim(p_notes), '')
  where id = p_customer_id and org_id = app.org_id();
  if not found then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;

  v_result := jsonb_build_object('customer_id', p_customer_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Customers sharing a phone number, for the merge-duplicates view.
create or replace function public.admin_customer_duplicates(p_limit int default 50)
returns table (phone text, customers jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager}');
  return query
    select c.phone,
           jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'email', c.email, 'last_visit_at', c.last_visit_at,
             'is_lodge_guest', c.is_lodge_guest, 'lodge_id', c.lodge_id,
             'intake_count', (select count(*) from public.intake i where i.customer_id = c.id),
             'created_at', c.created_at
           ) order by c.created_at, c.id)
    from public.customer c
    where c.org_id = app.org_id() and c.phone is not null
    group by c.phone
    having count(*) > 1
    order by c.phone
    limit least(greatest(coalesce(p_limit, 50), 1), 500);
end;
$$;

-- Merges `p_merge_id` into `p_keep_id` and deletes it: every row referencing the merged
-- customer (intakes, charges, storage, allocation, payments, … — discovered from the FK
-- catalog, so later tables are covered) moves to the kept one. Refused when both have a
-- phone and they differ, or when their lodge status differs (flip one with set_lodge_guest
-- first, so the reprice hook sees the change rather than a merge silently moving charges
-- between pricing tiers).
create or replace function public.admin_merge_customers(
  p_client_action_id text, p_keep_id uuid, p_merge_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_keep public.customer;
  v_merge public.customer;
  v_fk record;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'customer.merge',
    jsonb_build_object('keep_id', p_keep_id, 'merge_id', p_merge_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if p_keep_id is not distinct from p_merge_id then
    raise exception 'cannot merge a customer into itself' using errcode = '22023';
  end if;

  -- Lock both rows in id order so concurrent merges of the same pair cannot deadlock.
  perform 1 from public.customer
  where id in (p_keep_id, p_merge_id) and org_id = v_org
  order by id
  for update;
  select * into v_keep from public.customer where id = p_keep_id and org_id = v_org;
  select * into v_merge from public.customer where id = p_merge_id and org_id = v_org;
  if v_keep.id is null or v_merge.id is null then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if v_keep.phone is not null and v_merge.phone is not null and v_keep.phone <> v_merge.phone then
    raise exception 'customers have different phone numbers' using errcode = '22023';
  end if;
  if (v_keep.is_lodge_guest, v_keep.lodge_id) is distinct from (v_merge.is_lodge_guest, v_merge.lodge_id) then
    raise exception 'customers have different lodge status; set it the same on both first'
      using errcode = '22023';
  end if;

  for v_fk in
    select con.conrelid::regclass as tbl, att.attname as col
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'public.customer'::regclass
      and cardinality(con.conkey) = 1
    order by con.conrelid::regclass::text, att.attname
  loop
    execute format('update %s set %I = $1 where %I = $2 and org_id = $3', v_fk.tbl, v_fk.col, v_fk.col)
    using p_keep_id, p_merge_id, v_org;
  end loop;

  -- Pending customer events (e.g. a lodge flip not yet repriced) follow the customer.
  update public.domain_event
  set subject_id = p_keep_id
  where org_id = v_org and subject_id = p_merge_id and processed_at is null
    and kind like 'customer\_%';

  delete from public.customer where id = p_merge_id;

  update public.customer
  set phone = coalesce(v_keep.phone, v_merge.phone),
      email = coalesce(v_keep.email, v_merge.email),
      notes = case
        when v_merge.notes is null or v_merge.notes = v_keep.notes then v_keep.notes
        when v_keep.notes is null then v_merge.notes
        else v_keep.notes || E'\n' || v_merge.notes
      end,
      address = case when v_keep.address = '{}'::jsonb then v_merge.address else v_keep.address end,
      last_visit_at = greatest(v_keep.last_visit_at, v_merge.last_visit_at)
  where id = p_keep_id;

  perform app.emit_event(v_org, 'customer_merged', p_keep_id,
    jsonb_build_object('merged_customer_id', p_merge_id, 'merged_name', v_merge.name));

  v_result := jsonb_build_object('customer_id', p_keep_id, 'merged_customer_id', p_merge_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Lodges admin (owner/manager) --------------------------------------------------------

-- `p_pricing_cap` is the per-lb cap for the lodge's guests (null = no cap);
-- `p_contact` is {name, phone, email}.
create or replace function public.admin_create_lodge(
  p_client_action_id text, p_name text, p_pricing_cap numeric, p_contact jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_id uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'lodge.create',
    jsonb_build_object('name', p_name, 'pricing_cap', p_pricing_cap));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if exists (select 1 from public.lodge where org_id = app.org_id() and name = btrim(p_name)) then
    raise exception 'a lodge named % already exists', btrim(p_name) using errcode = '23505';
  end if;
  insert into public.lodge (org_id, name, pricing_cap, contact)
  values (app.org_id(), btrim(p_name), p_pricing_cap, coalesce(p_contact, '{}'::jsonb))
  returning id into v_id;

  v_result := jsonb_build_object('lodge_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.admin_update_lodge(
  p_client_action_id text, p_lodge_id uuid, p_name text, p_pricing_cap numeric,
  p_contact jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'lodge.update',
    jsonb_build_object('lodge_id', p_lodge_id, 'name', p_name, 'pricing_cap', p_pricing_cap));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if exists (
    select 1 from public.lodge
    where org_id = app.org_id() and name = btrim(p_name) and id <> p_lodge_id
  ) then
    raise exception 'a lodge named % already exists', btrim(p_name) using errcode = '23505';
  end if;
  update public.lodge
  set name = btrim(p_name), pricing_cap = p_pricing_cap, contact = coalesce(p_contact, '{}'::jsonb)
  where id = p_lodge_id and org_id = app.org_id();
  if not found then
    raise exception 'lodge not found' using errcode = 'P0002';
  end if;

  v_result := jsonb_build_object('lodge_id', p_lodge_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Grants ------------------------------------------------------------------------------

revoke all on function
  public.search_customers(uuid, text, int),
  public.create_customer(text, text, text, text),
  public.set_lodge_guest(text, uuid, boolean, uuid),
  public.admin_update_customer(text, uuid, text, text, text, text),
  public.admin_customer_duplicates(int),
  public.admin_merge_customers(text, uuid, uuid),
  public.admin_create_lodge(text, text, numeric, jsonb),
  public.admin_update_lodge(text, uuid, text, numeric, jsonb)
from public, anon, authenticated;

grant execute on function
  public.search_customers(uuid, text, int),
  public.create_customer(text, text, text, text),
  public.set_lodge_guest(text, uuid, boolean, uuid),
  public.admin_update_customer(text, uuid, text, text, text, text),
  public.admin_customer_duplicates(int),
  public.admin_merge_customers(text, uuid, uuid),
  public.admin_create_lodge(text, text, numeric, jsonb),
  public.admin_update_lodge(text, uuid, text, numeric, jsonb)
to authenticated;

grant execute on function public.search_customers(uuid, text, int) to service_role;
