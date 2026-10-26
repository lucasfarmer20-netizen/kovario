-- Freezer locations (docs/02-DOMAIN-MODEL.md §7): location, location_placement.
-- * Archived locations (is_active = false) cannot be bound: app.check_location_is_live().
-- * Capacity is display-only — nothing here (or anywhere) gates on it (DECISION-14).
-- * location_placement is append-only; vessel.location_id mirrors the latest placement.

do $$ begin
  create type public.location_kind as enum ('rack', 'pallet');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.location_depth as enum ('F', 'R');
exception when duplicate_object then null; end $$;

-- Append-only guard shared by history tables (location_placement, release_audit,
-- payment_event). Deletes are allowed only as a cascade from a parent (trigger depth > 1),
-- e.g. removing an org.
create or replace function app.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

revoke all on function app.append_only() from public;

-- location -----------------------------------------------------------------------------
create table if not exists public.location (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  zone text not null check (zone ~ '^[A-Z0-9]+$'),
  kind public.location_kind not null,
  "row" text,
  bay int check (bay >= 0),
  level int check (level >= 0),
  depth public.location_depth,
  -- IF-A-01-1-F or IF-PALLET-01 (pallet/quarantine codes are non-grid)
  code text not null check (code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
  -- KV:LOC:<org_slug>:<code>, produced only by packages/rules/src/qr.ts
  qr text not null,
  is_active boolean not null default true,
  -- display only: NEVER gate on capacity
  capacity int check (capacity >= 0),
  -- boxing pick-list walk path: zone → racks before pallets → row → bay → level → F before R
  sort_key text generated always as (
    zone || '|' || case kind when 'rack' then '0' else '1' end
    || '|' || coalesce("row", '')
    || '|' || lpad(coalesce(bay, 0)::text, 4, '0')
    || '|' || lpad(coalesce(level, 0)::text, 3, '0')
    || '|' || case depth when 'F' then '0' when 'R' then '1' else '' end
    || '|' || code
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, qr),
  check (
    (kind = 'pallet' and depth is null)
    or (kind = 'rack' and "row" is not null and bay is not null and level is not null and depth is not null)
  )
);

create index if not exists location_org_sort on public.location (org_id, sort_key) where is_active;

select app.track_updated_at('public.location');
select app.enable_org_rls('public.location', write_roles => '{}');

-- Raises unless the location exists and is live. A scanned code is never evidence the
-- shelf exists (docs/10-LESSONS-FROM-CSP.md §1).
create or replace function app.check_location_is_live(p_location_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_active boolean;
  v_code text;
begin
  select is_active, code into v_active, v_code from public.location where id = p_location_id;
  if not found then
    raise exception 'location % does not exist', p_location_id using errcode = '23503';
  end if;
  if not v_active then
    raise exception 'location % is archived and cannot be bound', v_code using errcode = '23514';
  end if;
end;
$$;

-- Trigger form: TG_ARGV[0] names the location column being bound. Fires on insert and
-- when the column changes, so rows already on a location that is later archived stay put.
create or replace function app.location_is_live_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_location uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
begin
  if v_location is not null
     and (tg_op = 'INSERT' or v_location is distinct from (to_jsonb(old) ->> tg_argv[0])::uuid) then
    perform app.check_location_is_live(v_location);
  end if;
  return new;
end;
$$;

revoke all on function app.check_location_is_live(uuid), app.location_is_live_trigger() from public;
grant execute on function app.check_location_is_live(uuid) to authenticated, service_role;

-- vessel / scan_log location FKs ------------------------------------------------------
do $$ begin
  alter table public.vessel
    add constraint vessel_location_id_fkey foreign key (location_id) references public.location (id);
exception when duplicate_object then null; end $$;

create index if not exists vessel_location_id on public.vessel (location_id) where location_id is not null;

drop trigger if exists location_is_live on public.vessel;
create trigger location_is_live before insert or update of location_id on public.vessel
  for each row execute function app.location_is_live_trigger('location_id');

do $$ begin
  alter table public.scan_log
    add constraint scan_log_location_id_fkey foreign key (location_id)
    references public.location (id) on delete set null;
exception when duplicate_object then null; end $$;

-- location_placement -------------------------------------------------------------------
-- Append-only. Only the Locate station writes placements.
create table if not exists public.location_placement (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  vessel_id uuid not null references public.vessel (id) on delete cascade,
  location_id uuid not null references public.location (id),
  placed_at timestamptz not null default now(),
  operator_id uuid references public.org_member (id) on delete set null,
  station public.device_station not null default 'locate',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists location_placement_vessel on public.location_placement (vessel_id, placed_at desc);
create index if not exists location_placement_location on public.location_placement (location_id);

select app.track_updated_at('public.location_placement');
select app.enable_org_rls('public.location_placement', write_roles => '{}');

drop trigger if exists append_only on public.location_placement;
create trigger append_only before update or delete on public.location_placement
  for each row execute function app.append_only();

drop trigger if exists location_is_live on public.location_placement;
create trigger location_is_live before insert on public.location_placement
  for each row execute function app.location_is_live_trigger('location_id');

-- vessel.location_id mirrors the latest placement. Pulling a vessel clears location_id
-- without a placement row, so the mirror runs on placement insert only.
create or replace function app.location_placement_mirror()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.vessel v
  set location_id = latest.location_id
  from (
    select p.location_id from public.location_placement p
    where p.vessel_id = new.vessel_id
    order by p.placed_at desc, p.created_at desc, p.id desc
    limit 1
  ) latest
  where v.id = new.vessel_id and v.location_id is distinct from latest.location_id;
  return null;
end;
$$;

revoke all on function app.location_placement_mirror() from public;

drop trigger if exists location_placement_mirror on public.location_placement;
create trigger location_placement_mirror after insert on public.location_placement
  for each row execute function app.location_placement_mirror();
