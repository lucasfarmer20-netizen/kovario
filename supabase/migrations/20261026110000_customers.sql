-- Customers (docs/02-DOMAIN-MODEL.md §2): lodge, customer.
-- Domain tables are read-only for clients (write_roles => '{}'): every mutation is a SQL
-- function that claims its client_action_id in action_log (AGENTS.md hard rule 3).
create extension if not exists pg_trgm with schema extensions;

-- lodge --------------------------------------------------------------------------------
create table if not exists public.lodge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- per-lb cap applied to lodge guests (lodge_cappable methods only); null = no cap.
  pricing_cap numeric(12,2) check (pricing_cap >= 0),
  contact jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

select app.track_updated_at('public.lodge');
select app.enable_org_rls('public.lodge', write_roles => '{}');

-- customer -----------------------------------------------------------------------------
create table if not exists public.customer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- E.164
  phone text check (phone ~ '^\+[1-9][0-9]{1,14}$'),
  -- digits only, for prefix/contains search after >= 3 digits
  phone_digits text generated always as (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) stored,
  email text,
  address jsonb not null default '{}'::jsonb,
  is_lodge_guest boolean not null default false,
  lodge_id uuid references public.lodge (id) on delete set null,
  notes text,
  last_visit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_org_phone on public.customer (org_id, phone);
create index if not exists customer_phone_digits_prefix on public.customer (org_id, phone_digits text_pattern_ops);
create index if not exists customer_phone_digits_trgm on public.customer
  using gin (phone_digits extensions.gin_trgm_ops);
create index if not exists customer_lodge_id on public.customer (lodge_id) where lodge_id is not null;

select app.track_updated_at('public.customer');
select app.enable_org_rls('public.customer', write_roles => '{}');
