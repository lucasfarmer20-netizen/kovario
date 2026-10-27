-- WP-22: tenant onboarding, org settings, rate cards, species admin and Stripe Billing state
-- (docs/02-DOMAIN-MODEL.md §1, §3, §12; docs/07-INTEGRATIONS.md §5; DECISION-06).
--
-- * public.create_org — self-serve signup: org + owner membership + first site + reference
--   data (species, conditions, methods, matrices, yield) + default rate card, in ONE
--   transaction. The reference rows come from packages/rules referenceSeed() (built from
--   docs/seed/processing-rules.json) so SQL never restates them.
-- * Org settings, rate cards, species/methods: admin_* functions, each one idempotent action.
-- * Stripe Billing: billing-* Edge Functions (service role) call billing_link_customer and
--   billing_apply_subscription; org.plan is written nowhere else. Plan limits/feature gates
--   are read by apps/web requirePlan() from packages/payments (DECISION-06 default tiers).

-- org billing columns -------------------------------------------------------------------
alter table public.org add column if not exists stripe_subscription_id text;
alter table public.org add column if not exists subscription_status text;
-- created time of the Stripe event that last set the plan (out-of-order deliveries).
alter table public.org add column if not exists plan_changed_at timestamptz;

create unique index if not exists org_stripe_customer_id on public.org (stripe_customer_id)
  where stripe_customer_id is not null;

-- Org writes go through admin_update_org (validated settings + action_log), never a direct
-- UPDATE; plan and Stripe columns only through the billing_* functions.
revoke update (name, timezone, settings) on public.org from authenticated;
revoke update on public.org from authenticated;
drop policy if exists org_update on public.org;

-- billing_event: one row per Stripe event delivered (dedupe + audit) ---------------------
create table if not exists public.billing_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  stripe_event_id text not null unique,
  kind text not null,
  subscription_id text,
  status text,
  plan text,
  event_created_at timestamptz not null,
  applied boolean not null default false,
  -- why an event was not applied: stale | other_subscription
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_event_org on public.billing_event (org_id, event_created_at desc);

select app.track_updated_at('public.billing_event');
select app.enable_org_rls('public.billing_event', write_roles => '{}');

-- helpers --------------------------------------------------------------------------------

create or replace function app.valid_timezone(p_tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz)
$$;

create or replace function app.json_int_between(p jsonb, p_min numeric, p_max numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'number'
    and (p #>> '{}')::numeric = trunc((p #>> '{}')::numeric)
    and (p #>> '{}')::numeric between p_min and p_max, false)
$$;

create or replace function app.json_num_between(p jsonb, p_min numeric, p_max numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'number' and (p #>> '{}')::numeric between p_min and p_max, false)
$$;

create or replace function app.json_keys(p jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p) k
$$;

-- Validates a complete org.settings object (docs/02-DOMAIN-MODEL.md §12). Returns null when
-- valid, else the first problem. Money rates are NOT settings — they live on the rate card.
create or replace function app.org_settings_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'settings must be an object';
  end if;
  if app.json_keys(p) <> array['estimated_pickup_days', 'hold_hours', 'receipt_footer', 'scanner',
      'shipping', 'status_page_enabled', 'tax', 'wave_target_lb', 'wave_tolerance_lb'] then
    return 'settings has missing or unknown keys';
  end if;
  if not app.json_int_between(p -> 'hold_hours', 1, 720) then
    return 'hold_hours must be a whole number of hours between 1 and 720';
  end if;
  if not app.json_int_between(p -> 'estimated_pickup_days', 0, 60) then
    return 'estimated_pickup_days must be a whole number between 0 and 60';
  end if;
  if not app.json_num_between(p -> 'wave_target_lb', 1, 100000) then
    return 'wave_target_lb must be between 1 and 100000';
  end if;
  if not app.json_num_between(p -> 'wave_tolerance_lb', 0, (p ->> 'wave_target_lb')::numeric) then
    return 'wave_tolerance_lb must be between 0 and the wave target';
  end if;
  if jsonb_typeof(p -> 'receipt_footer') <> 'string' or length(p ->> 'receipt_footer') > 500 then
    return 'receipt_footer must be text of at most 500 characters';
  end if;
  if jsonb_typeof(p -> 'status_page_enabled') <> 'boolean' then
    return 'status_page_enabled must be true or false';
  end if;

  if jsonb_typeof(p -> 'tax') <> 'object'
     or app.json_keys(p -> 'tax') <> array['cap_amount', 'mode', 'rate'] then
    return 'tax must have mode, rate and cap_amount';
  end if;
  -- DECISION-07 default: computed, exclusive, optional cap.
  if p #>> '{tax,mode}' is distinct from 'exclusive' then
    return 'tax.mode must be exclusive';
  end if;
  if not app.json_num_between(p #> '{tax,rate}', 0, 0.5) then
    return 'tax.rate must be a fraction between 0 and 0.5 (6% = 0.06)';
  end if;
  if jsonb_typeof(p #> '{tax,cap_amount}') <> 'null'
     and not app.json_num_between(p #> '{tax,cap_amount}', 0, 100000) then
    return 'tax.cap_amount must be empty or an amount of at least 0';
  end if;

  if jsonb_typeof(p -> 'shipping') <> 'object'
     or app.json_keys(p -> 'shipping') <> array['buy_window_days', 'carrier_allowlist'] then
    return 'shipping must have carrier_allowlist and buy_window_days';
  end if;
  if not (p #> '{shipping,carrier_allowlist}' = '"*"'::jsonb
          or (jsonb_typeof(p #> '{shipping,carrier_allowlist}') = 'array'
              and jsonb_array_length(p #> '{shipping,carrier_allowlist}') > 0
              and not exists (
                select 1 from jsonb_array_elements(p #> '{shipping,carrier_allowlist}') c
                where jsonb_typeof(c) <> 'string' or c #>> '{}' !~ '^[a-z0-9_]{2,40}$'))) then
    return 'shipping.carrier_allowlist must be "*" or a list of carrier tokens';
  end if;
  if not app.json_int_between(p #> '{shipping,buy_window_days}', 0, 30) then
    return 'shipping.buy_window_days must be a whole number between 0 and 30';
  end if;

  if jsonb_typeof(p -> 'scanner') <> 'object' or app.json_keys(p -> 'scanner') <> array['tag_digits']
     or not app.json_int_between(p #> '{scanner,tag_digits}', 3, 6) then
    return 'scanner.tag_digits must be between 3 and 6';
  end if;
  return null;
end;
$$;

-- Inserts the reference rows of `p_ref` (packages/rules referenceSeed() shape) that the org
-- does not have yet. Never updates existing rows: an org's own edits survive a re-seed.
-- Returns the number of rows inserted per table.
create or replace function app.seed_org_reference(p_org_id uuid, p_ref jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_species int;
  v_conditions int;
  v_methods int;
  v_cond_matrix int;
  v_proc_matrix int;
  v_yield int;
begin
  foreach v_key in array array['species', 'conditions', 'methods', 'condition_matrix',
                               'processing_matrix', 'yield_factors'] loop
    if jsonb_typeof(p_ref -> v_key) is distinct from 'array' then
      raise exception 'reference seed: % must be an array', v_key using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(p_ref -> 'species') = 0 or jsonb_array_length(p_ref -> 'conditions') = 0
     or jsonb_array_length(p_ref -> 'methods') = 0 then
    raise exception 'reference seed: species, conditions and methods cannot be empty'
      using errcode = '22023';
  end if;

  insert into public.species (org_id, code, name, "group", shorthand, skin_off_allowed,
                              skin_off_multiplier, sort, is_active)
  select p_org_id, r.code, r.name, r."group"::public.species_group, r.shorthand,
         coalesce(r.skin_off_allowed, false), coalesce(r.skin_off_multiplier, 0.85),
         coalesce(r.sort, 0), coalesce(r.is_active, true)
  from jsonb_to_recordset(p_ref -> 'species') as r (code text, name text, "group" text,
    shorthand text, skin_off_allowed boolean, skin_off_multiplier numeric, sort int, is_active boolean)
  on conflict (org_id, code) do nothing;
  get diagnostics v_species = row_count;

  insert into public.incoming_condition (org_id, code, name, sort, is_active)
  select p_org_id, r.code, r.name, coalesce(r.sort, 0), coalesce(r.is_active, true)
  from jsonb_to_recordset(p_ref -> 'conditions') as r (code text, name text, sort int, is_active boolean)
  on conflict (org_id, code) do nothing;
  get diagnostics v_conditions = row_count;

  insert into public.processing_method (org_id, code, name, shorthand, kind, is_exchange,
                                        lodge_cappable, sort, is_active)
  select p_org_id, r.code, r.name, r.shorthand, r.kind::public.processing_method_kind,
         coalesce(r.is_exchange, false), coalesce(r.lodge_cappable, true), coalesce(r.sort, 0),
         coalesce(r.is_active, true)
  from jsonb_to_recordset(p_ref -> 'methods') as r (code text, name text, shorthand text,
    kind text, is_exchange boolean, lodge_cappable boolean, sort int, is_active boolean)
  on conflict (org_id, code) do nothing;
  get diagnostics v_methods = row_count;

  insert into public.condition_matrix (org_id, matrix_key, condition_code)
  select p_org_id, r.matrix_key, r.condition_code
  from jsonb_to_recordset(p_ref -> 'condition_matrix') as r (matrix_key text, condition_code text)
  on conflict (org_id, matrix_key, condition_code) do nothing;
  get diagnostics v_cond_matrix = row_count;

  insert into public.processing_matrix (org_id, matrix_key, condition_code, method_code)
  select p_org_id, r.matrix_key, r.condition_code, r.method_code
  from jsonb_to_recordset(p_ref -> 'processing_matrix')
    as r (matrix_key text, condition_code text, method_code text)
  on conflict (org_id, matrix_key, condition_code, method_code) do nothing;
  get diagnostics v_proc_matrix = row_count;

  insert into public.yield_factor (org_id, species_code, condition_code, method_code, factor)
  select p_org_id, r.species_code, r.condition_code, r.method_code, r.factor
  from jsonb_to_recordset(p_ref -> 'yield_factors')
    as r (species_code text, condition_code text, method_code text, factor numeric)
  on conflict (org_id, species_code, condition_code, method_code) do nothing;
  get diagnostics v_yield = row_count;

  return jsonb_build_object('species', v_species, 'conditions', v_conditions,
    'methods', v_methods, 'condition_matrix', v_cond_matrix,
    'processing_matrix', v_proc_matrix, 'yield_factors', v_yield);
end;
$$;

-- Rate-card keys: a service method code of the org, or one of the three named rates
-- (docs/02-DOMAIN-MODEL.md §3 rate_card; packages/rules RATE_CARD_EXTRA_KEYS).
create or replace function app.rate_card_keys(p_org_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select code from public.processing_method where org_id = p_org_id and kind = 'service'
  union
  select unnest(array['ribbing_per_lb', 'fast_pass_per_lb', 'storage_per_box_day'])
$$;

-- Adds a $0.00 line for every rate-card key the card lacks (onboarding asks for the
-- amounts; docs give none, so nothing is priced until the owner enters rates).
create or replace function app.fill_rate_card_lines(p_org_id uuid, p_card_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.rate_card_line (org_id, rate_card_id, key, amount)
  select p_org_id, p_card_id, k, 0 from app.rate_card_keys(p_org_id) k
  on conflict (rate_card_id, key) do nothing
$$;

-- The org's single default rate card (applies on dates no dated card covers); created once.
create or replace function app.ensure_default_rate_card(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card uuid;
begin
  select id into v_card from public.rate_card where org_id = p_org_id and is_default;
  if v_card is null then
    insert into public.rate_card (org_id, name, is_default)
    values (p_org_id, 'Default rates', true)
    returning id into v_card;
  end if;
  perform app.fill_rate_card_lines(p_org_id, v_card);
  return v_card;
end;
$$;

revoke all on function app.valid_timezone(text), app.json_int_between(jsonb, numeric, numeric),
  app.json_num_between(jsonb, numeric, numeric), app.json_keys(jsonb),
  app.org_settings_problem(jsonb), app.seed_org_reference(uuid, jsonb),
  app.rate_card_keys(uuid), app.fill_rate_card_lines(uuid, uuid),
  app.ensure_default_rate_card(uuid)
from public;

-- create_org: self-serve signup ------------------------------------------------------------
-- Called by a signed-in user (who may not belong to any org yet, so there is no org claim and
-- app.action_begin cannot be used). Idempotency is kept the same way: the action_log row is
-- written in this transaction, keyed by client_action_id, and a retry by the same user
-- returns the stored result. An advisory lock serialises concurrent retries of one id.
-- The caller becomes the owner and this org becomes their default; they refresh the session
-- so the access token hook stamps the new org.
create or replace function public.create_org(
  p_client_action_id text,
  p_name text,
  p_slug text,
  p_timezone text,
  p_display_name text,
  p_reference jsonb,
  p_site_name text default 'Main'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := app.user_id();
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_display text := trim(coalesce(p_display_name, ''));
  v_site_name text := trim(coalesce(p_site_name, ''));
  v_input jsonb;
  v_prior public.action_log;
  v_org uuid;
  v_site uuid;
  v_card uuid;
  v_seeded jsonb;
  v_result jsonb;
begin
  if not app.is_end_user() or v_user is null
     or coalesce(app.claims() ->> 'role', '') <> 'authenticated' then
    raise exception 'create_org: sign in first' using errcode = '42501';
  end if;
  if exists (select 1 from public.device where auth_user_id = v_user) then
    raise exception 'create_org: station devices cannot create organisations' using errcode = '42501';
  end if;
  if p_client_action_id is null or length(p_client_action_id) not between 8 and 200 then
    raise exception 'create_org: client_action_id is required' using errcode = '22023';
  end if;

  v_input := jsonb_build_object('name', v_name, 'slug', v_slug, 'timezone', p_timezone,
    'site_name', v_site_name);

  perform pg_advisory_xact_lock(hashtextextended('org.create:' || p_client_action_id, 0));
  select * into v_prior from public.action_log where client_action_id = p_client_action_id;
  if found then
    if v_prior.action = 'org.create' and v_prior.user_id = v_user and v_prior.completed_at is not null then
      return v_prior.result;
    end if;
    raise exception 'create_org: client_action_id already used for another action'
      using errcode = '23505';
  end if;

  if length(v_name) not between 1 and 120 then
    raise exception 'Enter the business name (up to 120 characters).' using errcode = '22023';
  end if;
  if length(v_display) not between 1 and 80 then
    raise exception 'Enter your name (up to 80 characters).' using errcode = '22023';
  end if;
  if length(v_site_name) not between 1 and 80 then
    raise exception 'Enter a name for the first site.' using errcode = '22023';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) not between 3 and 40 then
    raise exception 'The short name must be 3–40 lowercase letters, digits and dashes.'
      using errcode = '22023';
  end if;
  if not app.valid_timezone(p_timezone) then
    raise exception 'Unknown time zone %.', p_timezone using errcode = '22023';
  end if;

  begin
    insert into public.org (slug, name, timezone)
    values (v_slug, v_name, p_timezone)
    returning id into v_org;
  exception when unique_violation then
    raise exception 'The short name "%" is already taken.', v_slug using errcode = '23505';
  end;

  update public.org_member set is_default = false where user_id = v_user and is_default;
  insert into public.org_member (org_id, user_id, role, display_name, is_default)
  values (v_org, v_user, 'owner', v_display, true);

  insert into public.site (org_id, name, is_default)
  values (v_org, v_site_name, true)
  returning id into v_site;

  v_seeded := app.seed_org_reference(v_org, p_reference);
  v_card := app.ensure_default_rate_card(v_org);

  v_result := jsonb_build_object('org_id', v_org, 'slug', v_slug, 'site_id', v_site,
    'rate_card_id', v_card, 'seeded', v_seeded);

  insert into public.action_log (org_id, client_action_id, user_id, action, input, result, completed_at)
  values (v_org, p_client_action_id, v_user, 'org.create', v_input, v_result, now());

  -- app.emit_event pins events to the session's org claim, which this session does not have yet.
  insert into public.domain_event (org_id, kind, subject_id, payload)
  values (v_org, 'org_created', v_org, jsonb_build_object('slug', v_slug, 'owner_user_id', v_user));

  return v_result;
end;
$$;

-- Org settings ----------------------------------------------------------------------------
create or replace function public.admin_update_org(
  p_client_action_id text, p_name text, p_timezone text, p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_problem text;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'org.update',
    jsonb_build_object('name', p_name, 'timezone', p_timezone, 'settings', p_settings));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Enter the business name (up to 120 characters).' using errcode = '22023';
  end if;
  if not app.valid_timezone(p_timezone) then
    raise exception 'Unknown time zone %.', p_timezone using errcode = '22023';
  end if;
  v_problem := app.org_settings_problem(p_settings);
  if v_problem is not null then
    raise exception 'Invalid settings: %', v_problem using errcode = '22023';
  end if;

  update public.org
  set name = trim(p_name), timezone = p_timezone, settings = p_settings
  where id = app.org_id();

  v_result := jsonb_build_object('org_id', app.org_id());
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Rate cards ------------------------------------------------------------------------------
create or replace function public.admin_create_rate_card(
  p_client_action_id text, p_name text, p_starts_on date, p_ends_on date,
  p_copy_from uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_source uuid;
  v_card uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'rate_card.create',
    jsonb_build_object('name', p_name, 'starts_on', p_starts_on, 'ends_on', p_ends_on,
      'copy_from', p_copy_from));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Enter a rate card name.' using errcode = '22023';
  end if;
  if p_starts_on is null then
    raise exception 'A season rate card needs a start date.' using errcode = '22023';
  end if;
  if p_ends_on is not null and p_ends_on < p_starts_on then
    raise exception 'The end date is before the start date.' using errcode = '22023';
  end if;

  if p_copy_from is not null then
    select id into v_source from public.rate_card where id = p_copy_from and org_id = v_org;
    if v_source is null then
      raise exception 'rate card to copy not found' using errcode = 'P0002';
    end if;
  else
    select id into v_source from public.rate_card where org_id = v_org and is_default;
  end if;

  begin
    insert into public.rate_card (org_id, name, starts_on, ends_on)
    values (v_org, trim(p_name), p_starts_on, p_ends_on)
    returning id into v_card;
  exception
    when exclusion_violation then
      raise exception 'Those dates overlap another rate card; only one card can be active per date.'
        using errcode = '23P01';
    when unique_violation then
      raise exception 'A rate card named "%" already exists.', trim(p_name) using errcode = '23505';
  end;

  insert into public.rate_card_line (org_id, rate_card_id, key, amount)
  select v_org, v_card, l.key, l.amount
  from public.rate_card_line l
  where l.rate_card_id = v_source
    and l.key in (select k from app.rate_card_keys(v_org) k);
  perform app.fill_rate_card_lines(v_org, v_card);

  v_result := jsonb_build_object('rate_card_id', v_card);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.admin_update_rate_card(
  p_client_action_id text, p_rate_card_id uuid, p_name text, p_starts_on date, p_ends_on date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_card public.rate_card;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'rate_card.update',
    jsonb_build_object('rate_card_id', p_rate_card_id, 'name', p_name, 'starts_on', p_starts_on,
      'ends_on', p_ends_on));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_card from public.rate_card where id = p_rate_card_id and org_id = v_org for update;
  if v_card.id is null then
    raise exception 'rate card not found' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Enter a rate card name.' using errcode = '22023';
  end if;
  if v_card.is_default and (p_starts_on is not null or p_ends_on is not null) then
    raise exception 'The default rate card has no dates; it applies whenever no season card does.'
      using errcode = '22023';
  end if;
  if not v_card.is_default and p_starts_on is null then
    raise exception 'A season rate card needs a start date.' using errcode = '22023';
  end if;
  if p_ends_on is not null and p_starts_on is not null and p_ends_on < p_starts_on then
    raise exception 'The end date is before the start date.' using errcode = '22023';
  end if;

  begin
    update public.rate_card
    set name = trim(p_name), starts_on = p_starts_on, ends_on = p_ends_on
    where id = v_card.id;
  exception
    when exclusion_violation then
      raise exception 'Those dates overlap another rate card; only one card can be active per date.'
        using errcode = '23P01';
    when unique_violation then
      raise exception 'A rate card named "%" already exists.', trim(p_name) using errcode = '23505';
  end;

  v_result := jsonb_build_object('rate_card_id', v_card.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- p_lines: [{"key": "fillets", "amount": 1.95}, …]; upserts the given keys only.
create or replace function public.admin_set_rate_card_lines(
  p_client_action_id text, p_rate_card_id uuid, p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_bad text;
  v_count int;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'rate_card.set_lines',
    jsonb_build_object('rate_card_id', p_rate_card_id, 'lines', p_lines));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  perform 1 from public.rate_card where id = p_rate_card_id and org_id = v_org for update;
  if not found then
    raise exception 'rate card not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'lines must be an array' using errcode = '22023';
  end if;

  select coalesce(l ->> 'key', '?') into v_bad
  from jsonb_array_elements(p_lines) l
  where l ->> 'key' is null
     or l ->> 'key' not in (select k from app.rate_card_keys(v_org) k)
     or not app.json_num_between(l -> 'amount', 0, 99999)
  limit 1;
  if v_bad is not null then
    raise exception 'Invalid rate for %: amounts are dollars of at least 0 and keys must be a rate of this plant.',
      v_bad using errcode = '22023';
  end if;
  if (select count(distinct l ->> 'key') <> count(*) from jsonb_array_elements(p_lines) l) then
    raise exception 'A rate is listed twice.' using errcode = '22023';
  end if;

  insert into public.rate_card_line (org_id, rate_card_id, key, amount)
  select v_org, p_rate_card_id, l ->> 'key', round((l ->> 'amount')::numeric, 2)
  from jsonb_array_elements(p_lines) l
  on conflict (rate_card_id, key) do update set amount = excluded.amount;
  get diagnostics v_count = row_count;

  v_result := jsonb_build_object('rate_card_id', p_rate_card_id, 'lines', v_count);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.admin_delete_rate_card(p_client_action_id text, p_rate_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_card public.rate_card;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'rate_card.delete',
    jsonb_build_object('rate_card_id', p_rate_card_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_card from public.rate_card where id = p_rate_card_id and org_id = v_org for update;
  if v_card.id is null then
    raise exception 'rate card not found' using errcode = 'P0002';
  end if;
  if v_card.is_default then
    raise exception 'The default rate card cannot be deleted.' using errcode = '23514';
  end if;
  -- Intakes snapshot their rate card; a used card is end-dated, never deleted.
  if exists (select 1 from public.intake where rate_card_id = v_card.id) then
    raise exception 'Intakes were priced with this rate card; set an end date instead of deleting it.'
      using errcode = '23503';
  end if;

  delete from public.rate_card where id = v_card.id;

  v_result := jsonb_build_object('rate_card_id', v_card.id, 'deleted', true);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Species / methods admin (docs/06-STATIONS-UX.md "species/methods toggles") -------------
create or replace function public.admin_update_species(
  p_client_action_id text, p_species_id uuid, p_name text, p_shorthand text, p_sort int,
  p_is_active boolean
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
  v_action := app.action_begin(p_client_action_id, 'species.update',
    jsonb_build_object('species_id', p_species_id, 'name', p_name, 'shorthand', p_shorthand,
      'sort', p_sort, 'is_active', p_is_active));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Enter a species name.' using errcode = '22023';
  end if;
  if p_shorthand is not null and trim(p_shorthand) !~ '^[A-Z0-9/-]{1,6}$' then
    raise exception 'Shorthand is up to 6 capital letters or digits (printed on tote tags).'
      using errcode = '22023';
  end if;

  update public.species
  set name = trim(p_name), shorthand = nullif(trim(p_shorthand), ''),
      sort = coalesce(p_sort, sort), is_active = coalesce(p_is_active, is_active)
  where id = p_species_id and org_id = app.org_id();
  if not found then
    raise exception 'species not found' using errcode = 'P0002';
  end if;

  v_result := jsonb_build_object('species_id', p_species_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.admin_update_processing_method(
  p_client_action_id text, p_method_id uuid, p_name text, p_is_active boolean,
  p_lodge_cappable boolean
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
  v_action := app.action_begin(p_client_action_id, 'processing_method.update',
    jsonb_build_object('method_id', p_method_id, 'name', p_name, 'is_active', p_is_active,
      'lodge_cappable', p_lodge_cappable));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Enter a method name.' using errcode = '22023';
  end if;

  update public.processing_method
  set name = trim(p_name), is_active = coalesce(p_is_active, is_active),
      lodge_cappable = coalesce(p_lodge_cappable, lodge_cappable)
  where id = p_method_id and org_id = app.org_id();
  if not found then
    raise exception 'processing method not found' using errcode = 'P0002';
  end if;

  v_result := jsonb_build_object('method_id', p_method_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Adds missing reference rows (and the default rate card) to the caller's org — for orgs
-- created before WP-22 or after a processing-rules update. Existing rows are untouched.
create or replace function public.admin_seed_reference(p_client_action_id text, p_reference jsonb)
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
  v_action := app.action_begin(p_client_action_id, 'reference.seed', '{}'::jsonb);
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_result := jsonb_build_object(
    'seeded', app.seed_org_reference(app.org_id(), p_reference),
    'rate_card_id', app.ensure_default_rate_card(app.org_id()));
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- service_role only (scripts/seed-demo-org.ts): same as admin_seed_reference for any org.
create or replace function public.seed_org_reference(p_org_id uuid, p_reference jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.org where id = p_org_id) then
    raise exception 'org not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'seeded', app.seed_org_reference(p_org_id, p_reference),
    'rate_card_id', app.ensure_default_rate_card(p_org_id));
end;
$$;

-- Stripe Billing (service_role only: billing-* Edge Functions) ---------------------------

-- Records the org's Stripe customer once; returns the customer the org ends up with (a
-- concurrent checkout that created a second customer gets the first one back).
create or replace function public.billing_link_customer(p_org_id uuid, p_customer_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer text;
begin
  update public.org set stripe_customer_id = p_customer_id
  where id = p_org_id and stripe_customer_id is null;
  select stripe_customer_id into v_customer from public.org where id = p_org_id;
  if not found then
    raise exception 'org not found' using errcode = 'P0002';
  end if;
  return v_customer;
end;
$$;

-- Applies one customer.subscription.* webhook event to org.plan. Idempotent per Stripe event
-- id; an event older than the one that last set the plan is recorded but not applied (Stripe
-- does not guarantee delivery order); an inactive event of a superseded subscription never
-- clears the plan of the current one. p_plan is null when the subscription entitles no plan.
create or replace function public.billing_apply_subscription(
  p_event_id text,
  p_event_created timestamptz,
  p_kind text,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_plan text,
  p_org_hint uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.org;
  v_event uuid;
  v_reason text;
begin
  select * into v_org from public.org where stripe_customer_id = p_customer_id for update;
  if v_org.id is null and p_org_hint is not null then
    select * into v_org from public.org
    where id = p_org_hint and stripe_customer_id is null
    for update;
    if v_org.id is not null then
      update public.org set stripe_customer_id = p_customer_id where id = v_org.id;
    end if;
  end if;
  if v_org.id is null then
    return jsonb_build_object('applied', false, 'reason', 'unknown_customer');
  end if;

  insert into public.billing_event (org_id, stripe_event_id, kind, subscription_id, status, plan,
                                    event_created_at)
  values (v_org.id, p_event_id, p_kind, p_subscription_id, p_status, p_plan, p_event_created)
  on conflict (stripe_event_id) do nothing
  returning id into v_event;
  if v_event is null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate', 'org_id', v_org.id);
  end if;

  if v_org.plan_changed_at is not null and p_event_created < v_org.plan_changed_at then
    v_reason := 'stale';
  elsif p_plan is null and v_org.stripe_subscription_id is not null
        and v_org.stripe_subscription_id <> p_subscription_id then
    v_reason := 'other_subscription';
  end if;

  if v_reason is not null then
    update public.billing_event set reason = v_reason where id = v_event;
    return jsonb_build_object('applied', false, 'reason', v_reason, 'org_id', v_org.id);
  end if;

  update public.org
  set plan = p_plan, stripe_subscription_id = p_subscription_id, subscription_status = p_status,
      plan_changed_at = p_event_created
  where id = v_org.id;
  update public.billing_event set applied = true where id = v_event;

  if v_org.plan is distinct from p_plan then
    perform app.emit_event(v_org.id, 'org_plan_changed', v_org.id, jsonb_build_object(
      'plan', p_plan, 'previous_plan', v_org.plan, 'status', p_status));
  end if;

  return jsonb_build_object('applied', true, 'org_id', v_org.id, 'plan', p_plan);
end;
$$;

-- grants ---------------------------------------------------------------------------------
revoke all on function
  public.create_org(text, text, text, text, text, jsonb, text),
  public.admin_update_org(text, text, text, jsonb),
  public.admin_create_rate_card(text, text, date, date, uuid),
  public.admin_update_rate_card(text, uuid, text, date, date),
  public.admin_set_rate_card_lines(text, uuid, jsonb),
  public.admin_delete_rate_card(text, uuid),
  public.admin_update_species(text, uuid, text, text, int, boolean),
  public.admin_update_processing_method(text, uuid, text, boolean, boolean),
  public.admin_seed_reference(text, jsonb),
  public.seed_org_reference(uuid, jsonb),
  public.billing_link_customer(uuid, text),
  public.billing_apply_subscription(text, timestamptz, text, text, text, text, text, uuid)
from public, anon, authenticated;

grant execute on function
  public.create_org(text, text, text, text, text, jsonb, text),
  public.admin_update_org(text, text, text, jsonb),
  public.admin_create_rate_card(text, text, date, date, uuid),
  public.admin_update_rate_card(text, uuid, text, date, date),
  public.admin_set_rate_card_lines(text, uuid, jsonb),
  public.admin_delete_rate_card(text, uuid),
  public.admin_update_species(text, uuid, text, text, int, boolean),
  public.admin_update_processing_method(text, uuid, text, boolean, boolean),
  public.admin_seed_reference(text, jsonb)
to authenticated;

grant execute on function
  public.seed_org_reference(uuid, jsonb),
  public.billing_link_customer(uuid, text),
  public.billing_apply_subscription(text, timestamptz, text, text, text, text, text, uuid)
to service_role;
