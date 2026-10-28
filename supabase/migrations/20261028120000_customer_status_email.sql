-- WP-20: constrained anonymous projection and transactional email outbox.
create table public.status_lookup_limit (
  org_id uuid primary key references public.org(id) on delete cascade,
  window_at timestamptz not null,
  attempts integer not null
);
select app.enable_org_rls('public.status_lookup_limit', write_roles => '{}');
revoke all on public.status_lookup_limit from anon, authenticated;
grant select(org_id) on public.status_lookup_limit to authenticated;

create or replace function public.customer_status(p_slug text, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.org;
  n integer;
  v_phone text;
  orders jsonb;
begin
  select * into o from public.org where slug = p_slug and is_active
    and settings ->> 'status_page_enabled' = 'true';
  if not found then return jsonb_build_object('error', 'unavailable'); end if;
  -- Atomic, bounded one-row-per-org limiter. All callers, including direct anon RPCs,
  -- share 60 attempts/minute. No IP/phone identifiers are stored.
  insert into public.status_lookup_limit values (o.id, date_trunc('minute', clock_timestamp()), 1)
  on conflict (org_id) do update set
    attempts = case when status_lookup_limit.window_at = excluded.window_at
      then least(status_lookup_limit.attempts + 1, 61) else 1 end,
    window_at = excluded.window_at
  returning attempts into n;
  if n > 60 then return jsonb_build_object('error', 'rate_limited'); end if;
  v_phone := regexp_replace(left(coalesce(p_phone, ''), 80), '[^0-9]', '', 'g');
  if left(trim(p_phone),1) <> '+' and length(v_phone) = 10 then v_phone := '1' || v_phone; end if;
  if v_phone !~ '^[1-9][0-9]{7,14}$' then
    return jsonb_build_object('error', 'invalid_phone');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'number', i.number, 'state', i.state, 'estimated_pickup_at', coalesce(i.estimated_pickup_at,
      i.intake_at + make_interval(days => coalesce((o.settings ->> 'estimated_pickup_days')::integer, 3))),
    'amount_due', coalesce((select sum(c.amount) from public.charge c
      where c.org_id = o.id and c.customer_id = i.customer_id
        and c.source_type = 'intake' and c.source_id = i.id and c.state = 'open'), 0)
    ) order by i.intake_at desc), '[]'::jsonb) into orders
  from public.intake i join public.customer c on c.id = i.customer_id and c.org_id = o.id
  where i.org_id = o.id and c.phone_digits = v_phone
    and i.state not in ('draft', 'done', 'cancelled');
  return jsonb_build_object('org_name', o.name, 'timezone', o.timezone,
    'pickup_hours', coalesce(o.settings ->> 'pickup_hours', ''),
    'rates_notice', coalesce(o.settings ->> 'rates_notice', o.settings ->> 'receipt_footer', ''),
    'intakes', orders);
end $$;
revoke all on function public.customer_status(text,text) from public;
grant execute on function public.customer_status(text,text) to anon, authenticated;

-- Optional settings preserve compatibility with existing orgs and strict validation.
alter function app.org_settings_problem(jsonb) rename to org_settings_problem_pre_wp20;
create function app.org_settings_problem(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  foreach k in array array['pickup_hours','rates_notice'] loop
    if p ? k and (jsonb_typeof(p -> k) <> 'string' or length(p ->> k) > 500) then
      return k || ' must be text of at most 500 characters';
    end if;
  end loop;
  return app.org_settings_problem_pre_wp20(p - 'pickup_hours' - 'rates_notice');
end $$;
revoke all on function app.org_settings_problem(jsonb) from public;

create table public.customer_email (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  customer_id uuid not null references public.customer(id) on delete cascade,
  kind text not null check (kind in ('intake_confirmation','ready_for_pickup','shipped')),
  event_key text not null,
  reference text not null,
  tracking text,
  delivery_payload jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  lease_until timestamptz,
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  last_error text,
  unique(org_id, event_key)
);
select app.enable_org_rls('public.customer_email', write_roles => '{}');
revoke all on public.customer_email from authenticated, anon;
grant select(org_id) on public.customer_email to authenticated;
grant all on public.customer_email to service_role;

create function app.queue_customer_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text;
begin
  if tg_table_name = 'intake' then
    if new.state = 'holding' and (tg_op = 'INSERT' or old.state = 'draft') then
      kind := 'intake_confirmation';
    elsif new.state = 'stored' and (tg_op = 'INSERT' or old.state is distinct from new.state) then
      kind := 'ready_for_pickup';
    end if;
  elsif new.state = 'shipped' and (tg_op = 'INSERT' or old.state is distinct from new.state) then
    kind := 'shipped';
  end if;
  if kind is not null and exists (select 1 from public.customer c
      where c.id = new.customer_id and c.org_id = new.org_id and nullif(trim(c.email),'') is not null) then
    insert into public.customer_email(org_id, customer_id, kind, event_key, reference, tracking)
    values(new.org_id, new.customer_id, kind, kind || ':' || new.id, new.number,
      case when tg_table_name = 'shipment' then to_jsonb(new) ->> 'tracking_number' end)
    on conflict(org_id,event_key) do nothing;
  end if;
  return null;
end $$;
revoke all on function app.queue_customer_email() from public;
create trigger customer_intake_email after insert or update of state on public.intake
  for each row execute function app.queue_customer_email();
create trigger customer_shipped_email after insert or update of state on public.shipment
  for each row execute function app.queue_customer_email();

create function public.customer_notify_ready(p_client_action_id text, p_intake_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; i public.intake; result jsonb;
begin
  perform app.require_role('{owner,manager}');
  a := app.action_begin(p_client_action_id, 'customer.notify_ready', jsonb_build_object('intake_id',p_intake_id));
  if a ->> 'status' = 'done' then return a -> 'result'; end if;
  select * into i from public.intake where id = p_intake_id and org_id = app.org_id();
  if not found or i.state in ('draft','done','cancelled') then raise exception 'Intake unavailable'; end if;
  if not exists (select 1 from public.customer where id = i.customer_id and org_id = i.org_id
    and nullif(trim(email),'') is not null) then raise exception 'Customer has no email address'; end if;
  insert into public.customer_email(org_id,customer_id,kind,event_key,reference)
  values(i.org_id,i.customer_id,'ready_for_pickup','manager:' || p_client_action_id,i.number);
  result := jsonb_build_object('queued',true);
  perform app.action_complete(p_client_action_id,result);
  return result;
end $$;
revoke all on function public.customer_notify_ready(text,uuid) from public;
grant execute on function public.customer_notify_ready(text,uuid) to authenticated;

-- Only the dispatcher can claim deliveries. Lease + stable Resend idempotency key
-- protect against concurrent runs and a crash after provider acceptance.
create function public.customer_email_claim() returns setof public.customer_email
language sql security definer set search_path = '' as $$
  update public.customer_email set lease_until = now() + interval '5 minutes', attempts = attempts + 1,
    first_attempt_at = coalesce(first_attempt_at, now())
  where id in (select id from public.customer_email where sent_at is null
    and (lease_until is null or lease_until < now()) and attempts < 10
    and (first_attempt_at is null or first_attempt_at > now() - interval '23 hours')
    order by created_at for update skip locked limit 20)
  returning *;
$$;
revoke all on function public.customer_email_claim() from public, anon, authenticated;
grant execute on function public.customer_email_claim() to service_role;
