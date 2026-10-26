-- Allocation, boxing, release (docs/02-DOMAIN-MODEL.md §8): allocation_session,
-- allocation_intake, settlement, settlement_species, box_size, shipment, box_plan,
-- release_audit; view allocation_session_fulfillment.
-- Founding rule: there is NO data link between box_plan and vessel.

do $$ begin
  create type public.allocation_session_state as enum ('draft', 'priced', 'done', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.allocation_session_split_method as enum ('weight', 'even');
exception when duplicate_object then null; end $$;

-- Rollup computed by the allocation_session_fulfillment view (not stored).
do $$ begin
  create type public.allocation_session_fulfillment_status as enum ('none', 'pending', 'partial', 'released');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.settlement_state as enum ('draft', 'paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.box_plan_method as enum ('air', 'ship', 'willcall');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.box_plan_fulfillment_state as enum ('planned', 'packed', 'shipped', 'picked_up');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.shipment_state as enum ('draft', 'held', 'label_bought', 'shipped', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.release_audit_event_kind as enum ('moved', 'finalized', 'restored');
exception when duplicate_object then null; end $$;

-- allocation_session -------------------------------------------------------------------
create table if not exists public.allocation_session (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null,
  party_customer_id uuid references public.customer (id) on delete set null,
  state public.allocation_session_state not null default 'draft',
  split_method public.allocation_session_split_method not null default 'weight',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);

create index if not exists allocation_session_org_state on public.allocation_session (org_id, state);

select app.track_updated_at('public.allocation_session');
select app.enable_org_rls('public.allocation_session', write_roles => '{}');
select app.guard_state('public.allocation_session', 'allocation_session');

-- allocation_intake (m2m: an intake can be pooled into several sessions) ---------------
create table if not exists public.allocation_intake (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  session_id uuid not null references public.allocation_session (id) on delete cascade,
  intake_id uuid not null references public.intake (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, intake_id)
);

create index if not exists allocation_intake_intake_id on public.allocation_intake (intake_id);

select app.track_updated_at('public.allocation_intake');
select app.enable_org_rls('public.allocation_intake', write_roles => '{}');

-- settlement ---------------------------------------------------------------------------
-- Per-angler bill; state is the payment axis only.
create table if not exists public.settlement (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  -- STL-… (docs/01-ARCHITECTURE.md §3)
  number text not null,
  session_id uuid not null references public.allocation_session (id),
  angler_name text not null check (length(trim(angler_name)) > 0),
  customer_id uuid references public.customer (id) on delete set null,
  processing_share numeric(12,2) not null default 0,
  box_fee_total numeric(12,2) not null default 0 check (box_fee_total >= 0),
  freight_total numeric(12,2) not null default 0 check (freight_total >= 0),
  retail_note text,
  amount_total numeric(12,2) not null default 0,
  weight_total_lb numeric(10,2) not null default 0 check (weight_total_lb >= 0),
  state public.settlement_state not null default 'draft',
  -- FK to public.payment added by the payments migration
  paid_payment_id uuid,
  -- QR on the receipt (KV:BOX:<token>) opens boxing for this angler
  boxing_token text not null default encode(extensions.gen_random_bytes(16), 'hex')
    check (boxing_token ~ '^[A-Za-z0-9_-]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  unique (boxing_token),
  -- target of box_plan's (settlement_id, session_id) FK
  unique (id, session_id),
  check (state <> 'paid' or paid_payment_id is not null)
);

create index if not exists settlement_session_id on public.settlement (session_id);

select app.track_updated_at('public.settlement');
select app.enable_org_rls('public.settlement', write_roles => '{}');
select app.guard_state('public.settlement', 'settlement');

-- settlement_species -------------------------------------------------------------------
create table if not exists public.settlement_species (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  settlement_id uuid not null references public.settlement (id) on delete cascade,
  species_code text not null,
  method_code text not null,
  lb numeric(10,2) not null default 0 check (lb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (settlement_id, species_code, method_code),
  foreign key (org_id, species_code) references public.species (org_id, code),
  foreign key (org_id, method_code) references public.processing_method (org_id, code)
);

select app.track_updated_at('public.settlement_species');
select app.enable_org_rls('public.settlement_species', write_roles => '{}');

-- box_size -----------------------------------------------------------------------------
create table if not exists public.box_size (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  max_lb numeric(10,2) not null check (max_lb > 0),
  fee numeric(12,2) not null default 0 check (fee >= 0),
  dims jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

select app.track_updated_at('public.box_size');
select app.enable_org_rls('public.box_size', write_roles => '{}');

-- shipment -----------------------------------------------------------------------------
create table if not exists public.shipment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null,
  box_plan_ids uuid[] not null default '{}',
  customer_id uuid references public.customer (id) on delete set null,
  ship_to jsonb not null default '{}'::jsonb,
  ship_date date,
  state public.shipment_state not null default 'draft',
  carrier text,
  service text,
  rate_amount numeric(12,2) check (rate_amount >= 0),
  shippo_shipment_id text,
  shippo_transaction_id text,
  tracking_number text,
  label_url text,
  is_walkin boolean not null default false,
  -- reported alongside `held` (I13b): held and blocked are orthogonal
  blockers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);

create index if not exists shipment_org_state on public.shipment (org_id, state);

select app.track_updated_at('public.shipment');
select app.enable_org_rls('public.shipment', write_roles => '{}');
select app.guard_state('public.shipment', 'shipment');

-- box_plan -----------------------------------------------------------------------------
create table if not exists public.box_plan (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  -- BOX-… (docs/01-ARCHITECTURE.md §3)
  number text not null,
  settlement_id uuid not null,
  session_id uuid not null references public.allocation_session (id),
  method public.box_plan_method not null,
  box_size_id uuid references public.box_size (id),
  weight_lb numeric(10,2) not null default 0 check (weight_lb >= 0),
  heavy_allowed boolean not null default false,
  fulfillment_state public.box_plan_fulfillment_state not null default 'planned',
  shipment_id uuid references public.shipment (id) on delete set null,
  retail_to_box boolean not null default false,
  label_printed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  -- the box's session is its settlement's session
  foreign key (settlement_id, session_id) references public.settlement (id, session_id),
  -- 70-lb heavy check
  check (weight_lb <= 70 or heavy_allowed),
  -- ship: planned → packed → shipped; air / will-call: planned → picked_up
  check (
    (method = 'ship' and fulfillment_state <> 'picked_up')
    or (method <> 'ship' and fulfillment_state in ('planned', 'picked_up'))
  )
);

create index if not exists box_plan_session_state on public.box_plan (session_id, fulfillment_state);
create index if not exists box_plan_settlement_id on public.box_plan (settlement_id);
create index if not exists box_plan_shipment_id on public.box_plan (shipment_id) where shipment_id is not null;

select app.track_updated_at('public.box_plan');
select app.enable_org_rls('public.box_plan', write_roles => '{}');
-- Not forceable: terminal fulfillment states never roll back, not even by a manager
-- (docs/02 §8, docs/03); a forced edge could return a released box to `planned`.
select app.guard_state('public.box_plan', 'box_plan', 'fulfillment_state', p_forceable => false);

-- release_audit (D3) -------------------------------------------------------------------
-- Append-only. Restore writes a new 'restored' row; nothing is edited.
create table if not exists public.release_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id),
  -- null for manager Release-by-Tag (no session)
  session_id uuid references public.allocation_session (id),
  event_kind public.release_audit_event_kind not null,
  released_by uuid references public.org_member (id) on delete set null,
  released_at timestamptz not null default now(),
  payment_ref text,
  vessel_id uuid references public.vessel (id),
  box_plan_id uuid references public.box_plan (id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists release_audit_intake on public.release_audit (intake_id, released_at);
create index if not exists release_audit_session on public.release_audit (session_id) where session_id is not null;

select app.track_updated_at('public.release_audit');
select app.enable_org_rls('public.release_audit', write_roles => '{}');

drop trigger if exists append_only on public.release_audit;
create trigger append_only before update or delete on public.release_audit
  for each row execute function app.append_only();

-- allocation_session_fulfillment -------------------------------------------------------
-- Rollup over the session's boxes. Release moves boxes out of `planned` (to packed or
-- picked_up), so: no boxes → none; all planned → pending; none planned → released;
-- otherwise partial. A session is `done` when this reads `released`.
create or replace view public.allocation_session_fulfillment with (security_invoker = true) as
  select
    s.id as session_id,
    s.org_id,
    count(b.id)::int as box_count,
    (count(b.id) filter (where b.fulfillment_state = 'planned'))::int as planned_count,
    case
      when count(b.id) = 0 then 'none'
      when count(b.id) filter (where b.fulfillment_state = 'planned') = count(b.id) then 'pending'
      when count(b.id) filter (where b.fulfillment_state = 'planned') = 0 then 'released'
      else 'partial'
    end::public.allocation_session_fulfillment_status as fulfillment_status
  from public.allocation_session s
  left join public.box_plan b on b.session_id = s.id
  group by s.id, s.org_id;

revoke all on public.allocation_session_fulfillment from public, anon, authenticated;
grant select on public.allocation_session_fulfillment to authenticated, service_role;
