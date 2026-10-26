-- Tenancy tables (docs/02-DOMAIN-MODEL.md §1): org, site, org_member, device.
create extension if not exists pgcrypto with schema extensions;

-- org ----------------------------------------------------------------------------------
-- The tenant root has no org_id column: its own id is the tenant, so it gets bespoke
-- policies instead of app.enable_org_rls.
create table if not exists public.org (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  timezone text not null,
  plan text,
  stripe_customer_id text,
  settings jsonb not null default '{
    "hold_hours": 48,
    "estimated_pickup_days": 3,
    "wave_target_lb": 4000,
    "wave_tolerance_lb": 250,
    "receipt_footer": "",
    "status_page_enabled": true,
    "tax": { "mode": "exclusive", "rate": 0.06, "cap_amount": 30.00 },
    "shipping": { "carrier_allowlist": "*", "buy_window_days": 1 },
    "scanner": { "tag_digits": 3 }
  }'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select app.track_updated_at('public.org');

alter table public.org enable row level security;
revoke all on public.org from anon, authenticated;
grant select on public.org to authenticated;
grant update (name, timezone, settings) on public.org to authenticated;
grant all on public.org to service_role;

drop policy if exists org_select on public.org;
create policy org_select on public.org for select to authenticated
  using (id = (select app.org_id()));

drop policy if exists org_update on public.org;
create policy org_update on public.org for update to authenticated
  using (id = (select app.org_id()) and (select app.role()) in ('owner', 'manager'))
  with check (id = (select app.org_id()) and (select app.role()) in ('owner', 'manager'));

-- site ---------------------------------------------------------------------------------
create table if not exists public.site (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create unique index if not exists site_one_default_per_org on public.site (org_id) where is_default;

select app.track_updated_at('public.site');
-- Read-only for clients; writes go through the admin_* functions, each in one
-- transaction with its action_log entry (AGENTS.md hard rule 3).
select app.enable_org_rls('public.site', write_roles => '{}');

-- org_member ---------------------------------------------------------------------------
do $$ begin
  create type public.org_member_role as enum ('owner', 'manager', 'staff', 'cashier');
exception when duplicate_object then null; end $$;

create table if not exists public.org_member (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_member_role not null,
  -- bcrypt hash of the 4–6 digit operator PIN; never readable by clients.
  pin_hash text,
  display_name text not null check (length(trim(display_name)) > 0),
  -- The org the access token hook stamps for a user in several orgs.
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create unique index if not exists org_member_one_default_per_user on public.org_member (user_id) where is_default;
create index if not exists org_member_user_id on public.org_member (user_id);

select app.track_updated_at('public.org_member');
-- Read-only for clients; role/PIN/invite writes go through the admin_* functions.
select app.enable_org_rls('public.org_member', write_roles => '{}');
revoke select on public.org_member from authenticated;
grant select (id, org_id, user_id, role, display_name, is_default, created_at, updated_at)
  on public.org_member to authenticated;

-- device -------------------------------------------------------------------------------
do $$ begin
  create type public.device_station as enum (
    'intake', 'storage', 'wave', 'rollstock', 'reconcile', 'blast', 'locate', 'allocate',
    'boxing', 'register', 'shipping'
  );
exception when duplicate_object then null; end $$;

-- printer_label_id / printer_receipt_id / terminal_id / scale_id (docs §1) reference
-- tables created by WP-03 and are added there.
create table if not exists public.device (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  station public.device_station not null,
  site_id uuid references public.site (id) on delete set null,
  -- sha256 of the outstanding one-time pairing code; cleared when redeemed.
  token_hash text unique,
  -- HMAC key deriving pairing codes from the issuing client_action_id (replays recompute the
  -- same code without storing it). Never granted to clients.
  pairing_key bytea not null default extensions.gen_random_bytes(32),
  pairing_expires_at timestamptz,
  -- The per-device auth.users row (device-<id>@devices.kovario.internal).
  auth_user_id uuid unique references auth.users (id) on delete set null,
  paired_at timestamptz,
  last_seen_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists device_org_id on public.device (org_id);

select app.track_updated_at('public.device');
-- Read-only for clients; create/pair/heartbeat go through functions.
select app.enable_org_rls('public.device', write_roles => '{}');
revoke select on public.device from authenticated;
grant select (id, org_id, name, station, site_id, pairing_expires_at, auth_user_id, paired_at,
  last_seen_at, is_active, created_at, updated_at)
  on public.device to authenticated;
