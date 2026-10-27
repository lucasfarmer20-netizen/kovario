-- Cold storage (docs/02-DOMAIN-MODEL.md §5): storage_intake, storage_box,
-- storage_pickup_batch; view storage_box_days.
-- * storage_intake.box_count / active_box_count are recomputed from the boxes by a BEFORE
--   trigger on every storage_intake write; box writes touch their storage_intake.
-- * days stored = max(1, days(end − start)) in the org's timezone, computed in ONE function
--   (app.storage_days, S4) that the view, wizard, receipt and batch snapshot all use.

do $$ begin
  create type public.storage_intake_state as enum ('draft', 'stored', 'partial', 'released', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.storage_box_state as enum ('stored', 'released');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.storage_pickup_batch_state as enum ('pending', 'released', 'void');
exception when duplicate_object then null; end $$;

-- storage_intake -----------------------------------------------------------------------
create table if not exists public.storage_intake (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null check (number ~ '^STG-[0-9]{4,}$'),
  customer_id uuid not null references public.customer (id),
  site_id uuid references public.site (id) on delete set null,
  state public.storage_intake_state not null default 'draft',
  intake_at timestamptz not null default now(),
  location_id uuid references public.location (id),
  notes text,
  -- trigger-maintained from storage_box
  box_count int not null default 0,
  active_box_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);

create index if not exists storage_intake_org_state on public.storage_intake (org_id, state);
create index if not exists storage_intake_customer_id on public.storage_intake (customer_id);

drop trigger if exists location_is_live on public.storage_intake;
create trigger location_is_live before insert or update of location_id on public.storage_intake
  for each row execute function app.location_is_live_trigger('location_id');

-- storage_pickup_batch -----------------------------------------------------------------
-- Invariants S1–S12 live in the release functions (WP-09/WP-15); this is the record.
create table if not exists public.storage_pickup_batch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null,
  storage_intake_id uuid not null references public.storage_intake (id),
  state public.storage_pickup_batch_state not null default 'pending',
  -- the exact box set this batch releases
  box_ids uuid[] not null check (cardinality(box_ids) >= 1),
  -- snapshots (untaxed)
  rate_per_box_day numeric(12,2) not null check (rate_per_box_day >= 0),
  amount numeric(12,2) not null check (amount >= 0),
  charge_id uuid references public.charge (id),
  -- FK to public.payment added by the payments migration
  payment_id uuid,
  payment_ref text,
  paid_at timestamptz,
  released_at timestamptz,
  release_failed boolean not null default false,
  -- append-only via function
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  check (state <> 'released' or released_at is not null)
);

create index if not exists storage_pickup_batch_intake on public.storage_pickup_batch (storage_intake_id);

select app.track_updated_at('public.storage_pickup_batch');
select app.enable_org_rls('public.storage_pickup_batch', write_roles => '{}');
select app.guard_state('public.storage_pickup_batch', 'storage_pickup_batch', 'state',
  array['released:released_at']);

-- storage_box --------------------------------------------------------------------------
create table if not exists public.storage_box (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  storage_intake_id uuid not null references public.storage_intake (id) on delete cascade,
  box_no int not null check (box_no >= 1),
  -- "Box 1" (defaults from box_no)
  label text not null,
  weight_lb numeric(10,2) check (weight_lb >= 0),
  description text,
  state public.storage_box_state not null default 'stored',
  released_at timestamptz,
  released_by uuid references public.org_member (id) on delete set null,
  batch_id uuid references public.storage_pickup_batch (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_intake_id, box_no),
  check ((state = 'released') = (released_at is not null))
);

create index if not exists storage_box_batch_id on public.storage_box (batch_id) where batch_id is not null;

create or replace function app.storage_box_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label := coalesce(nullif(trim(new.label), ''), 'Box ' || new.box_no);
  return new;
end;
$$;

drop trigger if exists storage_box_defaults on public.storage_box;
create trigger storage_box_defaults before insert on public.storage_box
  for each row execute function app.storage_box_defaults();

select app.track_updated_at('public.storage_box');
select app.enable_org_rls('public.storage_box', write_roles => '{}');
select app.guard_state('public.storage_box', 'storage_box', 'state', array['released:released_at']);

-- box counts ---------------------------------------------------------------------------
create or replace function app.storage_intake_denormals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select count(*), count(*) filter (where b.state = 'stored')
  into new.box_count, new.active_box_count
  from public.storage_box b
  where b.storage_intake_id = new.id;
  return new;
end;
$$;

drop trigger if exists storage_intake_denormals on public.storage_intake;
create trigger storage_intake_denormals before insert or update on public.storage_intake
  for each row execute function app.storage_intake_denormals();

create or replace function app.storage_box_touch_intake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    update public.storage_intake set updated_at = now() where id = old.storage_intake_id;
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.storage_intake_id is distinct from old.storage_intake_id
                             or new.state is distinct from old.state) then
    update public.storage_intake set updated_at = now() where id = new.storage_intake_id;
  end if;
  return null;
end;
$$;

drop trigger if exists storage_box_touch_intake on public.storage_box;
create trigger storage_box_touch_intake after insert or update or delete on public.storage_box
  for each row execute function app.storage_box_touch_intake();

revoke all on function app.storage_box_defaults(), app.storage_intake_denormals(),
  app.storage_box_touch_intake() from public;

select app.track_updated_at('public.storage_intake');
select app.enable_org_rls('public.storage_intake', write_roles => '{}');
select app.guard_state('public.storage_intake', 'storage_intake');

-- days stored (S4) ---------------------------------------------------------------------
-- Calendar days between start and end in the org's timezone; same day = 1.
create or replace function app.storage_days(p_start timestamptz, p_end timestamptz, p_timezone text)
returns int
language sql
stable
set search_path = ''
as $$
  select greatest(1, ((p_end at time zone p_timezone)::date - (p_start at time zone p_timezone)::date))
$$;

revoke all on function app.storage_days(timestamptz, timestamptz, text) from public;
grant execute on function app.storage_days(timestamptz, timestamptz, text) to authenticated, service_role;

create or replace view public.storage_box_days with (security_invoker = true) as
  select
    b.id as storage_box_id,
    b.org_id,
    b.storage_intake_id,
    b.box_no,
    b.label,
    b.state,
    si.intake_at,
    b.released_at,
    app.storage_days(si.intake_at, coalesce(b.released_at, now()), o.timezone) as days_stored
  from public.storage_box b
  join public.storage_intake si on si.id = b.storage_intake_id
  join public.org o on o.id = b.org_id;

revoke all on public.storage_box_days from public, anon, authenticated;
grant select on public.storage_box_days to authenticated, service_role;
