-- Payments (docs/02-DOMAIN-MODEL.md §9): payment_terminal, payment, payment_event,
-- register_order, register_order_line; plus the payment FKs of device, charge,
-- storage_pickup_batch and settlement. Secrets are stored by NAME only (secret_ref).

do $$ begin
  create type public.payment_terminal_provider as enum ('manual', 'dejavoo_spin', 'stripe_terminal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_state as enum (
    'pending', 'approved', 'declined', 'cancelled', 'indeterminate', 'voided', 'refunded', 'error'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_entry_mode as enum ('chip', 'contactless', 'swipe', 'manual', 'keyed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_event_kind as enum (
    'sale_requested', 'sale_result', 'status_check', 'abort', 'reverse_requested', 'reverse_result',
    'refund_requested', 'refund_result', 'error'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.register_order_state as enum ('open', 'paid', 'void');
exception when duplicate_object then null; end $$;

-- payment_terminal ---------------------------------------------------------------------
create table if not exists public.payment_terminal (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  site_id uuid references public.site (id) on delete set null,
  provider public.payment_terminal_provider not null,
  -- non-secret: endpoint_url, tpn, register_id, stripe_reader_id
  config jsonb not null default '{}'::jsonb,
  -- name of the Vault secret holding the auth key — never the key
  secret_ref text check (length(secret_ref) between 1 and 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select app.track_updated_at('public.payment_terminal');
select app.enable_org_rls('public.payment_terminal', write_roles => '{}');

alter table public.device
  add column if not exists terminal_id uuid references public.payment_terminal (id) on delete set null;
grant select (terminal_id) on public.device to authenticated;

-- payment ------------------------------------------------------------------------------
create table if not exists public.payment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null,
  customer_id uuid references public.customer (id) on delete set null,
  terminal_id uuid references public.payment_terminal (id) on delete set null,
  provider public.payment_terminal_provider not null,
  amount numeric(12,2) not null check (amount >= 0),
  tip numeric(12,2) not null default 0 check (tip >= 0),
  state public.payment_state not null default 'pending',
  -- ReferenceId / PaymentIntent id; a retry uses a new one (never collides)
  provider_ref text,
  -- TransNum
  provider_txn text,
  auth_code text,
  card_brand text,
  card_last4 text check (card_last4 ~ '^[0-9]{4}$'),
  entry_mode public.payment_entry_mode,
  host_response_code text,
  decline_reason text,
  -- receipts render from this stored data, never re-fetched (DECISION-13)
  receipt jsonb,
  attempt int not null default 1 check (attempt >= 1),
  idempotency_key text unique,
  settled_charge_ids uuid[] not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);

create unique index if not exists payment_provider_ref on public.payment (org_id, provider, provider_ref)
  where provider_ref is not null;
create index if not exists payment_customer_id on public.payment (customer_id);
create index if not exists payment_org_state on public.payment (org_id, state);

select app.track_updated_at('public.payment');
select app.enable_org_rls('public.payment', write_roles => '{}');
select app.guard_state('public.payment', 'payment');

-- payment_event ------------------------------------------------------------------------
-- Append-only; payload is scrubbed by the adapter before it is written.
create table if not exists public.payment_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  payment_id uuid not null references public.payment (id),
  kind public.payment_event_kind not null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_event_payment on public.payment_event (payment_id, at);

select app.track_updated_at('public.payment_event');
select app.enable_org_rls('public.payment_event', write_roles => '{}');

drop trigger if exists append_only on public.payment_event;
create trigger append_only before update or delete on public.payment_event
  for each row execute function app.append_only();

-- register_order -----------------------------------------------------------------------
-- Paid hooks (WP-16) must fire on insert-as-paid (cash) as well as on open → paid.
create table if not exists public.register_order (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  customer_id uuid references public.customer (id) on delete set null,
  state public.register_order_state not null default 'open',
  payment_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists register_order_customer on public.register_order (customer_id);

select app.track_updated_at('public.register_order');
select app.enable_org_rls('public.register_order', write_roles => '{}');
select app.guard_state('public.register_order', 'register_order');

-- register_order_line ------------------------------------------------------------------
-- A cart line is a charge (processing, storage batch, settlement fees…) or a retail item.
create table if not exists public.register_order_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  register_order_id uuid not null references public.register_order (id) on delete cascade,
  charge_id uuid references public.charge (id),
  -- retail catalogue is not modelled in v1 schema; no FK
  retail_product_id uuid,
  qty numeric(10,2) not null default 1 check (qty >= 0),
  unit_price numeric(12,2) not null,
  amount numeric(12,2) generated always as (round(qty * unit_price, 2)) stored,
  batch_id uuid references public.storage_pickup_batch (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(charge_id, retail_product_id) = 1)
);

create index if not exists register_order_line_order on public.register_order_line (register_order_id);
create index if not exists register_order_line_charge on public.register_order_line (charge_id) where charge_id is not null;

select app.track_updated_at('public.register_order_line');
select app.enable_org_rls('public.register_order_line', write_roles => '{}');

-- payment FKs on earlier tables --------------------------------------------------------
do $$ begin
  alter table public.charge
    add constraint charge_settled_payment_id_fkey foreign key (settled_payment_id) references public.payment (id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.storage_pickup_batch
    add constraint storage_pickup_batch_payment_id_fkey foreign key (payment_id) references public.payment (id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.settlement
    add constraint settlement_paid_payment_id_fkey foreign key (paid_payment_id) references public.payment (id);
exception when duplicate_object then null; end $$;
