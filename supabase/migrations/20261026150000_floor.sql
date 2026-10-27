-- Processing floor (docs/02-DOMAIN-MODEL.md §6): wave, wave_intake, wave_scan, scan_log,
-- asset_tag, vessel, reconcile_line, scale_reading; view reconcile_variance.
-- Occupancy is read ONLY from vessel.lifecycle_state, never from asset_tag_id.

do $$ begin
  create type public.wave_state as enum ('draft', 'verifying', 'done', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.scan_log_result as enum ('ok', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.asset_tag_state as enum ('available', 'in_use', 'retired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.vessel_lifecycle_state as enum ('occupied', 'emptied', 'void');
exception when duplicate_object then null; end $$;

-- wave ---------------------------------------------------------------------------------
create table if not exists public.wave (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null,
  state public.wave_state not null default 'draft',
  target_lb numeric(10,2) not null default 4000 check (target_lb > 0),
  tolerance_lb numeric(10,2) not null default 250 check (tolerance_lb >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);

create index if not exists wave_org_state on public.wave (org_id, state);

select app.track_updated_at('public.wave');
select app.enable_org_rls('public.wave', write_roles => '{}');
select app.guard_state('public.wave', 'wave', 'state', array['verifying:started_at', 'done:completed_at']);

do $$ begin
  alter table public.intake
    add constraint intake_wave_id_fkey foreign key (wave_id) references public.wave (id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists intake_wave_id on public.intake (wave_id) where wave_id is not null;

-- wave_intake --------------------------------------------------------------------------
create table if not exists public.wave_intake (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  wave_id uuid not null references public.wave (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wave_id, intake_id)
);

create index if not exists wave_intake_intake_id on public.wave_intake (intake_id);

select app.track_updated_at('public.wave_intake');
select app.enable_org_rls('public.wave_intake', write_roles => '{}');

-- wave_scan ----------------------------------------------------------------------------
-- One row per verified tote; a re-scan of the same tote is an error, not a second row.
create table if not exists public.wave_scan (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  wave_id uuid not null references public.wave (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  tote_no int not null check (tote_no >= 1),
  scanned_at timestamptz not null default now(),
  operator_id uuid references public.org_member (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wave_id, intake_id, tote_no)
);

create index if not exists wave_scan_intake_id on public.wave_scan (intake_id);

select app.track_updated_at('public.wave_scan');
select app.enable_org_rls('public.wave_scan', write_roles => '{}');

-- asset_tag ----------------------------------------------------------------------------
create table if not exists public.asset_tag (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  -- canonical zero-padded digits (qr.ts normalizeTagCode): 42 / 042 / 0042 → 042
  code text not null check (code ~ '^[0-9]{3,}$'),
  -- KV:TAG:<org_slug>:<code>, produced only by packages/rules/src/qr.ts
  qr text not null,
  state public.asset_tag_state not null default 'available',
  -- FK to public.vessel added below
  current_vessel_id uuid,
  retired_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, qr),
  -- in_use ⇔ bound to a vessel; freeing the vessel must free the tag first
  check ((state = 'in_use') = (current_vessel_id is not null)),
  check (state <> 'retired' or length(trim(retired_reason)) > 0)
);

select app.track_updated_at('public.asset_tag');
select app.enable_org_rls('public.asset_tag', write_roles => '{}');
select app.guard_state('public.asset_tag', 'asset_tag');

-- vessel -------------------------------------------------------------------------------
create table if not exists public.vessel (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id),
  -- tag identity/reuse only — never an occupancy signal
  asset_tag_id uuid references public.asset_tag (id) on delete set null,
  -- smoked-exchange baskets are never tagged
  is_exchange boolean not null default false,
  weight_lb numeric(10,2) not null default 0 check (weight_lb >= 0),
  species_summary text,
  -- THE occupancy source
  lifecycle_state public.vessel_lifecycle_state not null default 'occupied',
  -- current placement, mirrored from location_placement (FK added by the locations
  -- migration); cleared on pull
  location_id uuid,
  blast_in_at timestamptz,
  blast_out_at timestamptz,
  stored_at timestamptz,
  emptied_at timestamptz,
  emptied_by uuid references public.org_member (id) on delete set null,
  -- weight/location at release, for restore
  release_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_exchange or asset_tag_id is null)
);

-- A tag sits on at most one occupied vessel.
create unique index if not exists vessel_tag_bound on public.vessel (asset_tag_id)
  where asset_tag_id is not null and lifecycle_state = 'occupied';
create index if not exists vessel_intake_id on public.vessel (intake_id);
create index if not exists vessel_org_lifecycle on public.vessel (org_id, lifecycle_state);

select app.track_updated_at('public.vessel');
select app.enable_org_rls('public.vessel', write_roles => '{}');
select app.guard_state('public.vessel', 'vessel', 'lifecycle_state', array['emptied:emptied_at']);

do $$ begin
  alter table public.asset_tag
    add constraint asset_tag_current_vessel_id_fkey
    foreign key (current_vessel_id) references public.vessel (id) on delete set null;
exception when duplicate_object then null; end $$;

create unique index if not exists asset_tag_current_vessel on public.asset_tag (current_vessel_id)
  where current_vessel_id is not null;

-- scan_log -----------------------------------------------------------------------------
-- Written for EVERY scan, hit or miss.
create table if not exists public.scan_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  station public.device_station not null,
  device_id uuid references public.device (id) on delete set null,
  operator_id uuid references public.org_member (id) on delete set null,
  raw text not null,
  parsed jsonb,
  result public.scan_log_result not null,
  reason text,
  intake_id uuid references public.intake (id) on delete set null,
  vessel_id uuid references public.vessel (id) on delete set null,
  -- FK to public.location added by the locations migration
  location_id uuid,
  scanned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scan_log_org_scanned_at on public.scan_log (org_id, scanned_at desc);
create index if not exists scan_log_intake_id on public.scan_log (intake_id) where intake_id is not null;

select app.track_updated_at('public.scan_log');
select app.enable_org_rls('public.scan_log', write_roles => '{}');

-- reconcile_line -----------------------------------------------------------------------
create table if not exists public.reconcile_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  intake_line_id uuid not null references public.intake_line (id) on delete cascade,
  expected_lb numeric(10,2) not null default 0 check (expected_lb >= 0),
  -- sum of the vessels the reconcile operator attributes to this line
  actual_lb numeric(10,2) not null default 0 check (actual_lb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_line_id)
);

create index if not exists reconcile_line_intake_id on public.reconcile_line (intake_id);

select app.track_updated_at('public.reconcile_line');
select app.enable_org_rls('public.reconcile_line', write_roles => '{}');

-- Variance at reconcile = (actual − expected) / expected × 100 (docs/04-BUSINESS-RULES.md §1);
-- null when nothing was expected.
create or replace view public.reconcile_variance with (security_invoker = true) as
  select
    rl.id as reconcile_line_id,
    rl.org_id,
    rl.intake_id,
    rl.intake_line_id,
    rl.expected_lb,
    rl.actual_lb,
    case when rl.expected_lb > 0
      then round((rl.actual_lb - rl.expected_lb) / rl.expected_lb * 100, 2)
    end as variance_pct
  from public.reconcile_line rl;

revoke all on public.reconcile_variance from public, anon, authenticated;
grant select on public.reconcile_variance to authenticated, service_role;

-- scale_reading ------------------------------------------------------------------------
create table if not exists public.scale_reading (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  scale_id uuid not null references public.scale (id) on delete cascade,
  -- raw reading; may be negative around tare
  weight_lb numeric(10,2) not null,
  stable boolean not null default false,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "latest stable reading for this device's scale"
create index if not exists scale_reading_latest_stable on public.scale_reading (scale_id, read_at desc)
  where stable;

select app.track_updated_at('public.scale_reading');
select app.enable_org_rls('public.scale_reading', write_roles => '{}');
