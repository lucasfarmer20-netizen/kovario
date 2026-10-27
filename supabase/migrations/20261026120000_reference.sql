-- Reference data, per org (docs/02-DOMAIN-MODEL.md §3): species, incoming_condition,
-- processing_method, condition_matrix, processing_matrix, yield_factor, rate_card,
-- rate_card_line. Rows are seeded per org from docs/seed/processing-rules.json by the
-- onboarding flow; the rules engine (packages/rules) owns lookups and fallbacks — these
-- tables hold data only. Codes are the stable keys, so lines reference (org_id, code).
create extension if not exists btree_gist with schema extensions;

do $$ begin
  create type public.species_group as enum ('salmon', 'whitefish', 'other', 'byproduct');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.processing_method_kind as enum ('service', 'virtual');
exception when duplicate_object then null; end $$;

-- species ------------------------------------------------------------------------------
create table if not exists public.species (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9_]+$'),
  name text not null check (length(trim(name)) > 0),
  "group" public.species_group not null,
  shorthand text,
  skin_off_allowed boolean not null default false,
  skin_off_multiplier numeric(5,3) not null default 0.85
    check (skin_off_multiplier > 0 and skin_off_multiplier <= 1),
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

select app.track_updated_at('public.species');
select app.enable_org_rls('public.species', write_roles => '{}');

-- incoming_condition -------------------------------------------------------------------
create table if not exists public.incoming_condition (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9_]+$'),
  name text not null check (length(trim(name)) > 0),
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

select app.track_updated_at('public.incoming_condition');
select app.enable_org_rls('public.incoming_condition', write_roles => '{}');

-- processing_method --------------------------------------------------------------------
create table if not exists public.processing_method (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9_]+$'),
  name text not null check (length(trim(name)) > 0),
  shorthand text,
  kind public.processing_method_kind not null default 'service',
  is_exchange boolean not null default false,
  lodge_cappable boolean not null default true,
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

select app.track_updated_at('public.processing_method');
select app.enable_org_rls('public.processing_method', write_roles => '{}');

-- condition_matrix ---------------------------------------------------------------------
-- matrix_key is a species group or a species code that overrides its group.
create table if not exists public.condition_matrix (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  matrix_key text not null check (matrix_key ~ '^[a-z0-9_]+$'),
  condition_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, matrix_key, condition_code),
  foreign key (org_id, condition_code) references public.incoming_condition (org_id, code)
);

select app.track_updated_at('public.condition_matrix');
select app.enable_org_rls('public.condition_matrix', write_roles => '{}');

-- processing_matrix --------------------------------------------------------------------
create table if not exists public.processing_matrix (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  matrix_key text not null check (matrix_key ~ '^[a-z0-9_]+$'),
  condition_code text not null,
  method_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, matrix_key, condition_code, method_code),
  foreign key (org_id, condition_code) references public.incoming_condition (org_id, code),
  foreign key (org_id, method_code) references public.processing_method (org_id, code)
);

select app.track_updated_at('public.processing_matrix');
select app.enable_org_rls('public.processing_matrix', write_roles => '{}');

-- yield_factor -------------------------------------------------------------------------
create table if not exists public.yield_factor (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  species_code text not null,
  condition_code text not null,
  method_code text not null,
  factor numeric(5,3) not null check (factor > 0 and factor <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, species_code, condition_code, method_code),
  foreign key (org_id, species_code) references public.species (org_id, code),
  foreign key (org_id, condition_code) references public.incoming_condition (org_id, code),
  foreign key (org_id, method_code) references public.processing_method (org_id, code)
);

select app.track_updated_at('public.yield_factor');
select app.enable_org_rls('public.yield_factor', write_roles => '{}');

-- rate_card ----------------------------------------------------------------------------
-- The only source of money rates. Dated cards never overlap ("one active per date"); the
-- org's single is_default card applies on dates no dated card covers. ends_on null = open.
create table if not exists public.rate_card (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  starts_on date,
  ends_on date,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  check (is_default or starts_on is not null),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint rate_card_one_active_per_date exclude using gist (
    org_id with =, daterange(starts_on, ends_on, '[]') with &&
  ) where (not is_default)
);

create unique index if not exists rate_card_one_default_per_org on public.rate_card (org_id) where is_default;

select app.track_updated_at('public.rate_card');
select app.enable_org_rls('public.rate_card', write_roles => '{}');

-- rate_card_line -----------------------------------------------------------------------
-- key: a method code (price per lb) or ribbing_per_lb | fast_pass_per_lb | storage_per_box_day.
create table if not exists public.rate_card_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  rate_card_id uuid not null references public.rate_card (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]+$'),
  amount numeric(12,2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rate_card_id, key)
);

select app.track_updated_at('public.rate_card_line');
select app.enable_org_rls('public.rate_card_line', write_roles => '{}');
