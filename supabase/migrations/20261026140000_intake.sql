-- Sport intake (docs/02-DOMAIN-MODEL.md §4): intake, intake_line, charge, tote_tag.
-- Derived values are never app-maintained (docs/10-LESSONS-FROM-CSP.md §1):
--   * intake_line.ribbing, est_yield_lb and charge.amount are generated columns;
--   * intake.total_incoming_lb, total_est_yield_lb, ribbing are recomputed from the lines
--     by a BEFORE trigger on every intake write, and line writes touch their intake, so a
--     direct write to the totals can never stick;
--   * intake.hold_until defaults to intake_at + org.settings.hold_hours (a guideline only).

do $$ begin
  create type public.intake_state as enum (
    'draft', 'holding', 'processing', 'rollstock', 'reconcile', 'blast_freezer', 'stored', 'done',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.charge_kind as enum (
    'processing', 'ribbing', 'storage', 'box_fee', 'freight', 'retail', 'adjustment'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.charge_source_type as enum ('intake', 'storage_batch', 'settlement', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.charge_state as enum ('open', 'settled', 'voided', 'comped');
exception when duplicate_object then null; end $$;

-- intake -------------------------------------------------------------------------------
create table if not exists public.intake (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null check (number ~ '^INT-[0-9]{4,}$'),
  customer_id uuid not null references public.customer (id),
  site_id uuid references public.site (id) on delete set null,
  state public.intake_state not null default 'draft',
  intake_at timestamptz not null default now(),
  hold_until timestamptz,
  estimated_pickup_at timestamptz,
  tote_count int not null default 1 check (tote_count >= 0),
  dirty_fish boolean not null default false,
  dirty_notes text,
  cut_notes text,
  processing_notes text,
  cooler_location text,
  fast_pass boolean not null default false,
  -- snapshots taken at intake
  is_lodge_guest boolean not null default false,
  rate_card_id uuid references public.rate_card (id),
  -- trigger-maintained from intake_line
  total_incoming_lb numeric(10,2) not null default 0,
  total_est_yield_lb numeric(10,2) not null default 0,
  ribbing boolean not null default false,
  -- true after save & print; edits need a manager unlock
  locked boolean not null default false,
  pulled_at timestamptz,
  rollstock_at timestamptz,
  rollstock_done_at timestamptz,
  reconcile_at timestamptz,
  blast_at timestamptz,
  stored_at timestamptz,
  done_at timestamptz,
  cancelled_at timestamptz,
  -- reserved (DECISION-12: split intake is not in v1)
  split_from_id uuid references public.intake (id) on delete set null,
  -- FK to public.wave added by the floor migration
  wave_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);

create index if not exists intake_org_state on public.intake (org_id, state, intake_at);
create index if not exists intake_customer_id on public.intake (customer_id);

-- intake_line --------------------------------------------------------------------------
create table if not exists public.intake_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  sort int not null default 0,
  species_code text not null,
  condition_code text not null,
  method_code text not null,
  lb numeric(10,2) not null default 0 check (lb >= 0),
  -- salmon + fresh only; portions = 100 − fillets
  fillets_pct numeric(5,2) check (fillets_pct between 0 and 100),
  skin_off boolean not null default false,
  ribbing boolean generated always as (condition_code = 'filleted_ribs') stored,
  -- snapshot from the rules engine at save (skin-off multiplier already applied)
  yield_factor numeric check (yield_factor > 0 and yield_factor <= 1),
  est_yield_lb numeric(10,2) generated always as (round(lb * yield_factor, 2)) stored,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fillets_pct is null or method_code = 'fresh'),
  foreign key (org_id, species_code) references public.species (org_id, code),
  foreign key (org_id, condition_code) references public.incoming_condition (org_id, code),
  foreign key (org_id, method_code) references public.processing_method (org_id, code)
);

create index if not exists intake_line_intake_id on public.intake_line (intake_id, sort);

select app.track_updated_at('public.intake_line');
select app.enable_org_rls('public.intake_line', write_roles => '{}');

-- intake denormals ---------------------------------------------------------------------
create or replace function app.intake_denormals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold_hours int;
begin
  select coalesce(sum(l.lb), 0), coalesce(sum(l.est_yield_lb), 0), coalesce(bool_or(l.ribbing), false)
  into new.total_incoming_lb, new.total_est_yield_lb, new.ribbing
  from public.intake_line l
  where l.intake_id = new.id;

  if new.hold_until is null
     or (tg_op = 'UPDATE' and new.intake_at is distinct from old.intake_at
         and new.hold_until is not distinct from old.hold_until) then
    select coalesce((o.settings ->> 'hold_hours')::int, 48) into v_hold_hours
    from public.org o where o.id = new.org_id;
    new.hold_until := new.intake_at + make_interval(hours => coalesce(v_hold_hours, 48));
  end if;
  return new;
end;
$$;

drop trigger if exists intake_denormals on public.intake;
create trigger intake_denormals before insert or update on public.intake
  for each row execute function app.intake_denormals();

-- A line write touches its intake(s); the intake trigger above recomputes the totals.
create or replace function app.intake_line_touch_intake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    update public.intake set updated_at = now() where id = old.intake_id;
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.intake_id is distinct from old.intake_id
                             or new.lb is distinct from old.lb
                             or new.yield_factor is distinct from old.yield_factor
                             or new.condition_code is distinct from old.condition_code) then
    update public.intake set updated_at = now() where id = new.intake_id;
  end if;
  return null;
end;
$$;

drop trigger if exists intake_line_touch_intake on public.intake_line;
create trigger intake_line_touch_intake after insert or update or delete on public.intake_line
  for each row execute function app.intake_line_touch_intake();

revoke all on function app.intake_denormals(), app.intake_line_touch_intake() from public;

select app.track_updated_at('public.intake');
select app.enable_org_rls('public.intake', write_roles => '{}');
select app.guard_state('public.intake', 'intake', 'state', array[
  'processing:pulled_at',
  'rollstock:rollstock_at',
  'reconcile:rollstock_done_at',
  'reconcile:reconcile_at',
  'blast_freezer:blast_at',
  'stored:stored_at',
  'done:done_at',
  'cancelled:cancelled_at'
]);

-- charge -------------------------------------------------------------------------------
-- A priced thing the customer owes. Re-priced only via the pricing rule, never by hand.
create table if not exists public.charge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  number text not null,
  customer_id uuid not null references public.customer (id),
  kind public.charge_kind not null,
  source_type public.charge_source_type not null,
  source_id uuid,
  description text,
  qty numeric(10,2) not null check (qty >= 0),
  unit text not null check (unit in ('lb', 'day', 'each')),
  unit_price numeric(12,2) not null,
  amount numeric(12,2) generated always as (round(qty * unit_price, 2)) stored,
  tax_code text,
  state public.charge_state not null default 'open',
  -- FK to public.payment added by the payments migration
  settled_payment_id uuid,
  comp_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  check (source_type = 'manual' or source_id is not null),
  check (unit_price >= 0 or kind = 'adjustment'),
  check (state <> 'settled' or settled_payment_id is not null),
  check (state <> 'comped' or length(trim(comp_reason)) > 0)
);

create index if not exists charge_customer_open on public.charge (customer_id) where state = 'open';
create index if not exists charge_source on public.charge (source_type, source_id);

select app.track_updated_at('public.charge');
select app.enable_org_rls('public.charge', write_roles => '{}');

-- tote_tag -----------------------------------------------------------------------------
create table if not exists public.tote_tag (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  tote_no int not null check (tote_no >= 1),
  of_count int not null check (of_count >= 1),
  -- KV:TOTE:<intake_number>:<tote_no>, produced only by packages/rules/src/qr.ts
  qr text not null,
  printed_at timestamptz,
  print_job_id uuid references public.print_job (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_id, tote_no),
  unique (org_id, qr),
  check (tote_no <= of_count)
);

select app.track_updated_at('public.tote_tag');
select app.enable_org_rls('public.tote_tag', write_roles => '{}');
