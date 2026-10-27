-- WP-16 payments core + register (docs/05-PAYMENTS.md §1–§3, docs/04-BUSINESS-RULES.md §11–§12,
-- docs/10-LESSONS-FROM-CSP.md §1/§3):
--   * retail_product — the minimal retail catalogue (/admin/retail-products);
--   * register cart: register_load_outstanding (server-computed settlements, pending storage
--     batches re-quoted per batch savepoint, open charges; replaces every server line — S3),
--     retail lines, remove line, void; tax per org setting with cap (app.tax_amount, generated
--     from packages/rules tax.ts);
--   * payment flow for the /api/payments/* route handlers: payment_begin (pending row,
--     attempt n, provider_ref <order-hex-24>-<n>, sale_requested), payment_record_result
--     (service role only: approved / partial / declined / cancelled / indeterminate / error),
--     payment_resolve (manager marks an unresolved payment), payment_reverse_begin /
--     payment_reverse_record (manager void/refund with reason → provider reverse / refund);
--   * apply_paid_register_order(order, payment) — THE paid hook: settlements → paid (and the
--     session's billed charges settle when its last settlement is paid), open charges →
--     settled, storage batches released through app.release_pickup_batches (S5 intake row
--     first, S8 per-batch savepoints, S6 release_failed outside the savepoint), payment_event
--     + domain_event audit. Runs on insert-as-paid and on open → paid (a deferred constraint
--     trigger, so a cash order inserted as paid fires it once its lines exist); idempotent.
--     Refund orders never enter the release path (S11);
--   * receipts render from the payment's stored receipt snapshot (DECISION-13).
-- Terminal secrets: payment_terminal_runtime resolves secret_ref from Vault for the service
-- role only; no other function or table exposes it.

-- Retail catalogue -----------------------------------------------------------------------------

create table if not exists public.retail_product (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  sku text check (length(btrim(sku)) between 1 and 40),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

select app.track_updated_at('public.retail_product');
select app.enable_org_rls('public.retail_product', write_roles => '{}');

-- Register order ------------------------------------------------------------------------------

alter table public.register_order
  add column if not exists number text,
  add column if not exists kind public.register_order_kind not null default 'sale',
  -- refund orders (S11): the order and payment refunded, the amount and the manager's reason
  add column if not exists refund_of_id uuid references public.register_order (id),
  add column if not exists refund_payment_id uuid references public.payment (id),
  add column if not exists refund_amount numeric(12,2) check (refund_amount >= 0),
  add column if not exists reason text,
  -- org settings.tax as applied to this cart (refreshed on every load)
  add column if not exists tax jsonb not null default '{}'::jsonb,
  add column if not exists created_by uuid,
  add column if not exists paid_at timestamptz,
  add column if not exists voided_at timestamptz,
  -- the paid hook ran (idempotency) and what it did
  add column if not exists paid_hook_at timestamptz,
  add column if not exists paid_hook_result jsonb;

do $$ begin
  alter table public.register_order add constraint register_order_refund_shape check (
    kind <> 'refund' or (refund_payment_id is not null and length(btrim(reason)) > 0));
exception when duplicate_object then null; end $$;

create unique index if not exists register_order_number on public.register_order (org_id, number)
  where number is not null;
create index if not exists register_order_open on public.register_order (org_id, customer_id) where state = 'open';

-- Every order gets a REG- number and a tax snapshot, whoever inserts it (a cash order may be
-- inserted directly as paid).
create or replace function app.register_order_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.number is null then
    new.number := app.next_free_number(new.org_id, 'register_order', 'public.register_order');
  end if;
  new.tax := case when new.tax = '{}'::jsonb
                  then app.tax_setting((select o.settings -> 'tax' from public.org o where o.id = new.org_id))
                  else app.tax_setting(new.tax) end;
  return new;
end;
$$;

drop trigger if exists register_order_defaults on public.register_order;
create trigger register_order_defaults before insert on public.register_order
  for each row execute function app.register_order_defaults();

select app.guard_state('public.register_order', 'register_order', 'state', array['paid:paid_at', 'void:voided_at']);

-- Register order line --------------------------------------------------------------------------
-- A line is exactly one of: a charge (an open charge, or a storage batch's charge with
-- batch_id), a settlement, or a retail product. Lines carry the server ids (S3).

alter table public.register_order_line
  add column if not exists settlement_id uuid references public.settlement (id),
  add column if not exists description text not null default '';

alter table public.register_order_line drop constraint if exists register_order_line_check;
do $$ begin
  alter table public.register_order_line add constraint register_order_line_source
    check (num_nonnulls(charge_id, retail_product_id, settlement_id) = 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.register_order_line add constraint register_order_line_batch_charge
    check (batch_id is null or charge_id is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.register_order_line add constraint register_order_line_retail_product_id_fkey
    foreign key (retail_product_id) references public.retail_product (id);
exception when duplicate_object then null; end $$;

create unique index if not exists register_order_line_one_charge on public.register_order_line (register_order_id, charge_id)
  where charge_id is not null;
create unique index if not exists register_order_line_one_settlement on public.register_order_line (register_order_id, settlement_id)
  where settlement_id is not null;

-- Payment ------------------------------------------------------------------------------------

alter table public.payment
  add column if not exists register_order_id uuid references public.register_order (id),
  -- what the cashier asked for; amount is what was captured (partial approval: amount < requested)
  add column if not exists requested_amount numeric(12,2) check (requested_amount >= 0),
  add column if not exists tender public.payment_tender not null default 'card',
  add column if not exists tender_ref text,
  add column if not exists reason text,
  add column if not exists message text,
  add column if not exists approved_at timestamptz,
  add column if not exists reversed_at timestamptz,
  -- CUMULATIVE amount returned by voids / refunds. A partial refund keeps the payment approved
  -- for the rest (amount − reversed_amount is still captured); only when everything has gone
  -- back does the state become refunded / voided.
  add column if not exists reversed_amount numeric(12,2) check (reversed_amount >= 0),
  add column if not exists reverse_reason text,
  add column if not exists reverse_txn text,
  -- the void / refund in flight (payment_reverse_begin → payment_reverse_record): one at a time
  add column if not exists reverse_pending_at timestamptz,
  add column if not exists reverse_pending_kind text check (reverse_pending_kind in ('reverse', 'refund')),
  add column if not exists reverse_pending_amount numeric(12,2),
  add column if not exists reverse_pending_ref text,
  add column if not exists reverse_pending_reason text,
  -- the provider call threw: the money may or may not have gone back. Blocks every new void /
  -- refund until a manager establishes the outcome (payment_reverse_resolve).
  add column if not exists reverse_unresolved boolean not null default false;

do $$ begin
  alter table public.payment add constraint payment_reverse_pending_shape check (
    (reverse_pending_at is null) = (reverse_pending_kind is null)
    and (reverse_pending_at is null) = (reverse_pending_amount is null)
    and (reverse_pending_at is null) = (reverse_pending_ref is null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.payment add constraint payment_reverse_unresolved_pending check (
    not reverse_unresolved or reverse_pending_at is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.payment add constraint payment_reversed_within_amount
    check (coalesce(reversed_amount, 0) <= amount);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.payment add constraint payment_comp_reason check (tender <> 'comp' or length(btrim(reason)) > 0);
exception when duplicate_object then null; end $$;

create index if not exists payment_register_order on public.payment (register_order_id) where register_order_id is not null;

select app.guard_state('public.payment', 'payment', 'state',
  array['approved:approved_at', 'voided:reversed_at', 'refunded:reversed_at']);

-- Terminal runtime (service role only) -----------------------------------------------------------

-- TerminalConfig = payment_terminal.config + {secret}: the secret is read from Vault by the
-- terminal's secret_ref. Only the /api/payments/* route handlers (service role) call this;
-- the value is handed to the provider and never stored or returned to the browser.
create or replace function public.payment_terminal_runtime(p_terminal_id uuid, p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t public.payment_terminal;
  v_secret text := '';
begin
  select * into v_t from public.payment_terminal
  where id = p_terminal_id and org_id = p_org_id and is_active;
  if not found then
    raise exception 'payment terminal not found or inactive' using errcode = 'P0002';
  end if;
  if v_t.secret_ref is not null then
    select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = v_t.secret_ref limit 1;
    if v_secret is null then
      raise exception 'terminal % has no Vault secret named %', v_t.name, v_t.secret_ref using errcode = 'P0002';
    end if;
  end if;
  return jsonb_build_object('id', v_t.id, 'name', v_t.name, 'provider', v_t.provider,
                            'config', v_t.config, 'secret', v_secret);
end;
$$;

-- Cart -----------------------------------------------------------------------------------------

-- {subtotal, tax, total, paid, due}: lines summed, tax by the org setting snapshot (§12), paid =
-- the order's approved payments (a voided / refunded payment no longer counts).
create or replace function app.register_totals(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select o.tax,
           coalesce((select sum(l.amount) from public.register_order_line l where l.register_order_id = o.id), 0) as subtotal,
           -- net of partial refunds: what is still captured
           coalesce((select sum(p.amount - coalesce(p.reversed_amount, 0)) from public.payment p
                     where p.register_order_id = o.id and p.state = 'approved'), 0) as paid
    from public.register_order o where o.id = p_order_id
  )
  select jsonb_build_object(
    'subtotal', s.subtotal,
    'tax', app.tax_amount(s.tax, s.subtotal),
    'total', app.tax_total(s.tax, s.subtotal),
    'paid', s.paid,
    'due', app.tax_total(s.tax, s.subtotal) - s.paid)
  from s
$$;

create or replace function app.payment_json(p public.payment)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'number', p.number, 'state', p.state, 'provider', p.provider, 'terminal_id', p.terminal_id,
    'amount', p.amount, 'requested_amount', p.requested_amount, 'tender', p.tender, 'tender_ref', p.tender_ref,
    'attempt', p.attempt, 'provider_ref', p.provider_ref, 'card_brand', p.card_brand, 'card_last4', p.card_last4,
    'entry_mode', p.entry_mode, 'auth_code', p.auth_code, 'decline_reason', p.decline_reason,
    'message', p.message, 'approved_at', p.approved_at, 'reversed_amount', p.reversed_amount,
    'refundable', case when p.state = 'approved' then p.amount - coalesce(p.reversed_amount, 0) else 0 end,
    'reverse_pending_kind', p.reverse_pending_kind,
    'reverse_unresolved', p.reverse_unresolved or p.reverse_pending_at <= now() - interval '6 minutes',
    'created_at', p.created_at)
$$;

-- The cart as the register shows it.
create or replace function app.register_order_json(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'kind', o.kind, 'state', o.state, 'tax_setting', o.tax,
    'customer', (select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone)
                 from public.customer c where c.id = o.customer_id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id,
               'kind', case when l.settlement_id is not null then 'settlement'
                            when l.batch_id is not null then 'storage'
                            when l.charge_id is not null then 'charge' else 'retail' end,
               'charge_id', l.charge_id, 'settlement_id', l.settlement_id, 'batch_id', l.batch_id,
               'retail_product_id', l.retail_product_id, 'description', l.description,
               'qty', l.qty, 'unit_price', l.unit_price, 'amount', l.amount)
             order by case when l.settlement_id is not null then 1 when l.batch_id is not null then 2
                           when l.charge_id is not null then 3 else 4 end,
                      l.created_at, l.description, l.id)
      from public.register_order_line l where l.register_order_id = o.id), '[]'::jsonb),
    'totals', app.register_totals(o.id),
    'payments', coalesce((
      select jsonb_agg(app.payment_json(p) order by p.attempt, p.created_at)
      from public.payment p where p.register_order_id = o.id), '[]'::jsonb),
    -- docs/05 §2.4: an unresolved payment blocks the next charge until its status is known
    'blocking_payment_id', (select p.id from public.payment p
                            where p.register_order_id = o.id and p.state in ('pending', 'indeterminate')
                            order by p.created_at limit 1),
    -- a void / refund in flight or unresolved on this cart: no payment and no completion until
    -- it is settled (its money may already be back)
    'reversal_payment_id', (select p.id from public.payment p
                            where p.register_order_id = o.id and p.reverse_pending_at is not null
                            order by p.created_at limit 1),
    'paid_hook', o.paid_hook_result,
    'refund_of_id', o.refund_of_id, 'refund_amount', o.refund_amount, 'reason', o.reason,
    'paid_at', o.paid_at, 'created_at', o.created_at)
  from public.register_order o
  where o.id = p_order_id
$$;

-- Locks an open sale cart for a line change. A cart with a live payment (pending,
-- indeterminate, or approved — a partial approval) is frozen: finish collecting or reverse
-- the payment first, so the amount charged always matches the lines it pays for.
create or replace function app.register_lock_cart(p_order_id uuid)
returns public.register_order
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.register_order;
  v_pay public.payment;
begin
  select * into v_order from public.register_order where id = p_order_id and org_id = app.org_id() for update;
  if not found then
    raise exception 'register order not found' using errcode = 'P0002';
  end if;
  if v_order.kind <> 'sale' or v_order.state <> 'open' then
    raise exception '% is %; start a new cart', v_order.number, v_order.state using errcode = '55000';
  end if;
  select * into v_pay from public.payment
  where register_order_id = v_order.id and state in ('pending', 'indeterminate', 'approved')
  order by created_at limit 1;
  if found then
    raise exception '% has payment % (%) on it; collect the rest or reverse it before changing the cart',
      v_order.number, v_pay.number, v_pay.state using errcode = '55000';
  end if;
  return v_order;
end;
$$;

-- Load outstanding (docs/04 §11): the customer's server-computed items REPLACE every server
-- line of the cart (S3) — retail lines the cashier added stay. p_order_id null → a new cart.
--   * settlements: draft, of a priced/done session, the angler's or the party's;
--   * pending storage batches of the customer's storage intakes — re-quoted when the snapshot
--     is stale (a new batch supersedes it, S3/S4), each in its own savepoint so one broken
--     batch never blocks the others (S8); a paid-but-unreleased batch is refused (S6);
--   * open charges, except storage batch charges (loaded with their batch) and processing /
--     ribbing charges billed by an allocation session (loaded as settlements).
-- Returns the cart plus `notices` [{level, code, message, batch_id?}].
create or replace function public.register_load_outstanding(
  p_client_action_id text, p_customer_id uuid, p_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_order public.register_order;
  v_batch_id uuid;
  v_b public.storage_pickup_batch;
  v_snap jsonb;
  v_new jsonb;
  v_si public.storage_intake;
  v_msg text;
  v_notices jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'register.load_outstanding',
    jsonb_build_object('customer_id', p_customer_id, 'order_id', p_order_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if not exists (select 1 from public.customer where id = p_customer_id and org_id = v_org) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if p_order_id is null then
    insert into public.register_order (org_id, customer_id, created_by)
    values (v_org, p_customer_id, app.user_id())
    returning * into v_order;
  else
    v_order := app.register_lock_cart(p_order_id);
    update public.register_order
    set customer_id = p_customer_id,
        tax = app.tax_setting((select o.settings -> 'tax' from public.org o where o.id = v_org))
    where id = v_order.id;
  end if;

  delete from public.register_order_line where register_order_id = v_order.id and retail_product_id is null;

  -- Settlements (the party's or the angler's).
  insert into public.register_order_line (org_id, register_order_id, settlement_id, qty, unit_price, description)
  select v_org, v_order.id, st.id, 1, st.amount_total,
         format('%s — %s (%s)', st.number, st.angler_name, s.number)
  from public.settlement st
  join public.allocation_session s on s.id = st.session_id
  where st.org_id = v_org and st.state = 'draft' and s.state in ('priced', 'done')
    and (st.customer_id = p_customer_id or s.party_customer_id = p_customer_id)
  order by app.number_order(s.number), app.number_order(st.number);

  -- Pending storage batches, one savepoint each (S8).
  for v_batch_id in
    select pb.id from public.storage_pickup_batch pb
    join public.storage_intake si on si.id = pb.storage_intake_id
    where pb.org_id = v_org and si.customer_id = p_customer_id and pb.state = 'pending'
    order by app.number_order(pb.number)
  loop
    -- Re-read: an earlier re-quote in this loop may have superseded it.
    select * into v_b from public.storage_pickup_batch where id = v_batch_id;
    continue when v_b.state <> 'pending';
    if v_b.release_failed or v_b.payment_id is not null then
      v_notices := v_notices || jsonb_build_object('level', 'error', 'code', 'paid_not_released',
        'batch_id', v_b.id, 'message',
        format('%s was paid but not released — a manager must Force Release it; do not charge it again', v_b.number));
      continue;
    end if;
    begin
      v_snap := app.storage_snapshot(v_b.storage_intake_id, v_b.box_ids);
      if (v_snap ->> 'amount')::numeric <> v_b.amount
         or (select jsonb_object_agg(x ->> 'box_id', (x ->> 'days')::int) from jsonb_array_elements(v_snap -> 'boxes') x)
            <> v_b.box_days then
        v_new := public.create_pickup_batch(p_client_action_id || ':requote:' || v_b.id::text,
                                            v_b.storage_intake_id, v_b.box_ids);
        v_notices := v_notices || jsonb_build_object('level', 'info', 'code', 'requoted',
          'batch_id', (v_new ->> 'batch_id')::uuid,
          'message', format('%s re-quoted as %s: %s → %s', v_b.number, v_new ->> 'number', v_b.amount, v_new ->> 'amount'));
        select * into v_b from public.storage_pickup_batch where id = (v_new ->> 'batch_id')::uuid;
      end if;
      select * into v_si from public.storage_intake where id = v_b.storage_intake_id;
      insert into public.register_order_line (org_id, register_order_id, charge_id, batch_id, qty, unit_price, description)
      values (v_org, v_order.id, v_b.charge_id, v_b.id, 1, v_b.amount,
              format('Cold storage %s (%s, %s box%s)', v_b.number, v_si.number, cardinality(v_b.box_ids),
                     case when cardinality(v_b.box_ids) = 1 then '' else 'es' end));
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_notices := v_notices || jsonb_build_object('level', 'error', 'code', 'batch_load_failed',
        'batch_id', v_batch_id, 'message', format('%s could not be loaded: %s', v_b.number, v_msg));
    end;
  end loop;

  -- Open charges not billed through a settlement or a batch.
  insert into public.register_order_line (org_id, register_order_id, charge_id, qty, unit_price, description)
  select v_org, v_order.id, c.id, 1, c.amount, coalesce(nullif(btrim(c.description), ''), initcap(c.kind::text)) || ' ' || c.number
  from public.charge c
  where c.org_id = v_org and c.customer_id = p_customer_id and c.state = 'open'
    and c.source_type <> 'storage_batch'
    and not (c.source_type = 'intake' and c.kind in ('processing', 'ribbing')
             and app.intake_billing_session(c.source_id) is not null)
  order by app.number_order(c.number);

  v_result := app.register_order_json(v_order.id) || jsonb_build_object('notices', v_notices);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.register_add_retail(
  p_client_action_id text, p_order_id uuid, p_retail_product_id uuid, p_qty numeric default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_order public.register_order;
  v_p public.retail_product;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'register.add_retail', jsonb_build_object(
    'order_id', p_order_id, 'retail_product_id', p_retail_product_id, 'qty', p_qty));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  v_order := app.register_lock_cart(p_order_id);
  select * into v_p from public.retail_product where id = p_retail_product_id and org_id = v_order.org_id and is_active;
  if not found then
    raise exception 'retail product not found or inactive' using errcode = 'P0002';
  end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000 or p_qty * 100 <> trunc(p_qty * 100) then
    raise exception 'quantity must be more than 0 (at most 2 dp)' using errcode = '22023';
  end if;
  insert into public.register_order_line (org_id, register_order_id, retail_product_id, qty, unit_price, description)
  values (v_order.org_id, v_order.id, v_p.id, p_qty, v_p.unit_price, v_p.name);
  v_result := app.register_order_json(v_order.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Takes a line off the cart (e.g. another angler pays their own settlement later).
create or replace function public.register_remove_line(p_client_action_id text, p_order_id uuid, p_line_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_order public.register_order;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'register.remove_line',
    jsonb_build_object('order_id', p_order_id, 'line_id', p_line_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  v_order := app.register_lock_cart(p_order_id);
  delete from public.register_order_line where id = p_line_id and register_order_id = v_order.id;
  if not found then
    raise exception 'line not found on this cart' using errcode = 'P0002';
  end if;
  v_result := app.register_order_json(v_order.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- open → void (an abandoned cart). Never with a live payment on it.
create or replace function public.register_void_order(p_client_action_id text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_order public.register_order;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'register.void_order', jsonb_build_object('order_id', p_order_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  v_order := app.register_lock_cart(p_order_id);
  update public.register_order set state = 'void' where id = v_order.id;
  v_result := app.register_order_json(v_order.id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.register_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if not exists (select 1 from public.register_order where id = p_order_id and org_id = app.org_id()) then
    raise exception 'register order not found' using errcode = 'P0002';
  end if;
  return app.register_order_json(p_order_id);
end;
$$;

-- Payment flow -------------------------------------------------------------------------------

-- docs/05 §2.1: Charge → payment(pending, attempt n, provider_ref <order-hex-24>-<n>) +
-- sale_requested; a replayed id returns the stored payment with replayed = true so the route
-- never sends the sale again. Refused while another payment of the cart is pending or indeterminate
-- (never charge twice). Amount: more than 0 and at most the amount due (a $0 cart takes a
-- $0 manual tender). Card → the terminal's provider; cash / check / external / comp → manual.
-- COMP needs a manager (role or elevation) and a reason.
create or replace function public.payment_begin(
  p_client_action_id text,
  p_order_id uuid,
  p_amount numeric,
  p_terminal_id uuid default null,
  p_tender text default 'card',
  p_tender_ref text default null,
  p_reason text default null,
  p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_order public.register_order;
  v_open public.payment;
  v_t public.payment_terminal;
  v_tender public.payment_tender;
  v_totals jsonb;
  v_due numeric;
  v_attempt int;
  v_pay public.payment;
  v_manager uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'payment.begin', jsonb_build_object(
    'order_id', p_order_id, 'amount', p_amount, 'terminal_id', p_terminal_id, 'tender', p_tender,
    'tender_ref', p_tender_ref, 'reason', p_reason));
  -- A replay (double submit, retry after a lost response) must never reach the terminal again.
  if v_action ->> 'status' = 'done' then
    return (v_action -> 'result') || '{"replayed": true}'::jsonb;
  end if;

  if p_tender is null or p_tender not in ('card', 'cash', 'check', 'external', 'comp') then
    raise exception 'tender must be card, cash, check, external or comp' using errcode = '22023';
  end if;
  v_tender := p_tender::public.payment_tender;

  select * into v_order from public.register_order where id = p_order_id and org_id = v_org for update;
  if not found then
    raise exception 'register order not found' using errcode = 'P0002';
  end if;
  if v_order.kind <> 'sale' or v_order.state <> 'open' then
    raise exception '% is %', v_order.number, v_order.state using errcode = '55000';
  end if;
  select * into v_open from public.payment
  where register_order_id = v_order.id and state in ('pending', 'indeterminate')
  order by created_at limit 1;
  if found then
    raise exception '% is still %: check its status before charging again', v_open.number, v_open.state
      using errcode = '55000', hint = 'payment_unresolved';
  end if;
  select * into v_open from public.payment
  where register_order_id = v_order.id and reverse_pending_at is not null
  order by created_at limit 1;
  if found then
    raise exception '% has a % in progress or unconfirmed — its money may already be back. Settle it before taking another payment',
      v_open.number, v_open.reverse_pending_kind using errcode = '55000', hint = 'reversal_pending';
  end if;
  if not exists (select 1 from public.register_order_line where register_order_id = v_order.id) then
    raise exception 'the cart is empty' using errcode = '22023';
  end if;

  v_totals := app.register_totals(v_order.id);
  v_due := (v_totals ->> 'due')::numeric;
  if p_amount is null or p_amount < 0 or p_amount * 100 <> trunc(p_amount * 100) then
    raise exception 'amount must be 0 or more, in cents' using errcode = '22023';
  end if;
  if p_amount > v_due then
    raise exception 'amount % is more than the % due', p_amount, v_due using errcode = '22023';
  end if;
  if p_amount = 0 and (v_due <> 0 or v_tender = 'card') then
    raise exception 'nothing to charge' using errcode = '22023';
  end if;

  if v_tender = 'card' then
    select * into v_t from public.payment_terminal where id = p_terminal_id and org_id = v_org and is_active;
    if not found then
      raise exception 'choose an active card terminal' using errcode = '22023';
    end if;
    if v_t.provider = 'manual' then
      raise exception '% records cash, check or an external terminal ref — not a card', v_t.name using errcode = '22023';
    end if;
  else
    if p_terminal_id is not null then
      select * into v_t from public.payment_terminal
      where id = p_terminal_id and org_id = v_org and is_active and provider = 'manual';
    end if;
    if v_tender in ('check', 'external') and nullif(btrim(p_tender_ref), '') is null then
      raise exception 'a % payment needs its reference', v_tender using errcode = '22023';
    end if;
    if v_tender = 'comp' then
      if p_elevation_token is not null then
        v_manager := app.require_elevation(p_elevation_token);
      else
        perform app.require_role('{owner,manager}');
      end if;
      if nullif(btrim(p_reason), '') is null then
        raise exception 'a COMP needs a reason' using errcode = '22023';
      end if;
    end if;
  end if;

  select count(*) + 1 into v_attempt from public.payment where register_order_id = v_order.id;
  insert into public.payment (
    org_id, number, customer_id, terminal_id, provider, amount, requested_amount, state, provider_ref,
    attempt, idempotency_key, tender, tender_ref, reason, created_by, register_order_id
  ) values (
    v_org, app.next_free_number(v_org, 'payment', 'public.payment'), v_order.customer_id, v_t.id,
    case when v_tender = 'card' then v_t.provider else 'manual' end, p_amount, p_amount, 'pending',
    left(replace(v_order.id::text, '-', ''), 24) || '-' || v_attempt,
    v_attempt, p_client_action_id, v_tender, nullif(btrim(p_tender_ref), ''), nullif(btrim(p_reason), ''),
    app.user_id(), v_order.id
  ) returning * into v_pay;

  insert into public.payment_event (org_id, payment_id, kind, payload)
  values (v_org, v_pay.id, 'sale_requested', jsonb_build_object(
    'amount', p_amount, 'attempt', v_attempt, 'tender', v_tender, 'terminal_id', v_t.id,
    'order', v_order.number, 'approved_by', v_manager));

  v_result := app.payment_json(v_pay) || jsonb_build_object('org_id', v_org, 'order_id', v_order.id,
    'reason', v_pay.reason);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- What a route handler needs to talk to the provider about a payment the caller can see.
create or replace function public.payment_for_provider(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pay public.payment;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  select * into v_pay from public.payment where id = p_payment_id and org_id = app.org_id();
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  return app.payment_json(v_pay) || jsonb_build_object('org_id', v_pay.org_id, 'order_id', v_pay.register_order_id,
    'provider_txn', v_pay.provider_txn, 'reason', v_pay.reason);
end;
$$;

-- The receipt snapshot stored on an approved payment (DECISION-13: receipts render from stored
-- data, never re-fetched): the cart's lines and totals as charged, this payment's tender and
-- card meta, and the order's other approved payments.
create or replace function app.payment_receipt_data(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'org', jsonb_build_object('name', og.name, 'footer', coalesce(og.settings ->> 'receipt_footer', '')),
    'order_number', o.number,
    'customer', (select c.name from public.customer c where c.id = o.customer_id),
    'date', to_char(coalesce(p.approved_at, now()) at time zone coalesce(og.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI'),
    'lines', j -> 'lines',
    'subtotal', j -> 'totals' -> 'subtotal',
    'tax', j -> 'totals' -> 'tax',
    'tax_setting', o.tax,
    'total', j -> 'totals' -> 'total',
    'paid', j -> 'totals' -> 'paid',
    'due', j -> 'totals' -> 'due',
    'payment', jsonb_build_object(
      'number', p.number, 'amount', p.amount, 'requested_amount', p.requested_amount, 'tender', p.tender,
      'tender_ref', p.tender_ref, 'reason', p.reason, 'provider', p.provider, 'provider_ref', p.provider_ref,
      'provider_txn', p.provider_txn, 'card_brand', p.card_brand, 'card_last4', p.card_last4,
      'entry_mode', p.entry_mode, 'auth_code', p.auth_code, 'approved_at', p.approved_at),
    'other_payments', coalesce((
      select jsonb_agg(jsonb_build_object('number', q.number, 'amount', q.amount, 'tender', q.tender,
                                          'card_brand', q.card_brand, 'card_last4', q.card_last4)
                       order by q.attempt)
      from public.payment q
      where q.register_order_id = o.id and q.state = 'approved' and q.id <> p.id), '[]'::jsonb))
  from public.payment p
  join public.register_order o on o.id = p.register_order_id
  join public.org og on og.id = p.org_id
  cross join lateral (select app.register_order_json(o.id) as j) x
  where p.id = p_payment_id
$$;

-- Applies a provider (or manager) outcome to a payment. Locks the order, then the payment.
--   pending|indeterminate + approved      → approved (captured amount; partial approval keeps
--                                            requested_amount), receipt snapshot; the cart
--                                            turns paid when nothing is due → paid hook;
--   pending|indeterminate + declined      → declined (bank reason);
--   pending|indeterminate + cancelled     → cancelled;
--   pending + indeterminate               → indeterminate (blocks retry until resolved);
--   pending + error                       → error; an indeterminate payment stays indeterminate;
--   same outcome again                    → no-op (idempotent);
--   approved after cancelled/declined/error → the money WAS captured: recorded as approved
--                                            anyway, with a critical alert (never lose a capture).
-- Every call appends a payment_event of kind p_event with the (already scrubbed) result.
create or replace function app.payment_apply_result(p_payment_id uuid, p_event text, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payment;
  v_order public.register_order;
  v_outcome text := p_result ->> 'outcome';
  v_card jsonb := coalesce(p_result -> 'card', '{}'::jsonb);
  v_order_id uuid;
  v_amount numeric;
  v_to public.payment_state;
  v_status text;
  v_hook jsonb;
  v_totals jsonb;
begin
  if v_outcome is null or v_outcome not in ('approved', 'declined', 'cancelled', 'indeterminate', 'error') then
    raise exception 'unknown payment outcome %', coalesce(v_outcome, 'null') using errcode = '22023';
  end if;
  select register_order_id into v_order_id from public.payment where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_order_id is not null then
    select * into v_order from public.register_order where id = v_order_id for update;
  end if;
  select * into v_pay from public.payment where id = p_payment_id for update;

  insert into public.payment_event (org_id, payment_id, kind, payload)
  values (v_pay.org_id, v_pay.id, p_event::public.payment_event_kind, jsonb_strip_nulls(jsonb_build_object(
    'outcome', v_outcome, 'approved_amount', p_result -> 'approvedAmount', 'provider_txn', p_result -> 'providerTxn',
    'card', v_card, 'message', p_result -> 'message', 'raw', p_result -> 'raw', 'state_before', v_pay.state)));

  v_to := case v_outcome
            when 'approved' then 'approved'
            when 'declined' then 'declined'
            when 'cancelled' then 'cancelled'
            when 'indeterminate' then 'indeterminate'
            else 'error' end::public.payment_state;

  if v_pay.state in ('pending', 'indeterminate') then
    if v_to = 'error' and v_pay.state = 'indeterminate' then
      v_status := 'unchanged';
    elsif v_to = 'indeterminate' and v_pay.state = 'indeterminate' then
      v_status := 'unchanged';
    else
      v_status := 'applied';
    end if;
  elsif v_pay.state = v_to then
    v_status := 'noop';
  elsif v_to = 'approved' and v_pay.state in ('cancelled', 'declined', 'error') then
    v_status := 'late_approval';
    perform set_config('app.forced_transition', format('payment:%s:approved', v_pay.id), true);
    perform app.emit_event(v_pay.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
      'level', 'critical', 'code', 'late_approval', 'payment', v_pay.number,
      'message', format('%s was recorded %s but the terminal later approved it — check for a double charge',
                        v_pay.number, v_pay.state)));
    raise warning 'payment % late approval after %', v_pay.number, v_pay.state;
  else
    v_status := 'ignored';
  end if;

  if v_status in ('applied', 'late_approval') then
    v_amount := coalesce((p_result ->> 'approvedAmount')::numeric, v_pay.requested_amount, v_pay.amount);
    update public.payment
    set state = v_to,
        amount = case when v_to = 'approved' then round(v_amount, 2) else amount end,
        provider_txn = coalesce(p_result ->> 'providerTxn', provider_txn),
        card_brand = coalesce(v_card ->> 'brand', card_brand),
        card_last4 = coalesce(case when v_card ->> 'last4' ~ '^[0-9]{4}$' then v_card ->> 'last4' end, card_last4),
        entry_mode = coalesce(case when v_card ->> 'entryMode' in ('chip', 'contactless', 'swipe', 'manual', 'keyed')
                                   then (v_card ->> 'entryMode')::public.payment_entry_mode end, entry_mode),
        auth_code = coalesce(v_card ->> 'authCode', auth_code),
        host_response_code = coalesce(v_card ->> 'hostResponseCode', host_response_code),
        decline_reason = case when v_to = 'declined'
                              then coalesce(v_card ->> 'declineReason', p_result ->> 'message', decline_reason)
                              else decline_reason end,
        message = coalesce(p_result ->> 'message', message)
    where id = v_pay.id
    returning * into v_pay;
    perform set_config('app.forced_transition', '', true);

    if v_to = 'approved' then
      if v_pay.amount < coalesce(v_pay.requested_amount, v_pay.amount) then
        v_status := v_status || ':partial';
      end if;
      if v_order.id is not null then
        update public.register_order set payment_ids = array_append(payment_ids, v_pay.id)
        where id = v_order.id and not (v_pay.id = any (payment_ids));
        update public.payment set receipt = app.payment_receipt_data(v_pay.id) where id = v_pay.id
        returning * into v_pay;
        v_totals := app.register_totals(v_order.id);
        if v_order.state = 'open' and (v_totals ->> 'due')::numeric <= 0
           and not exists (select 1 from public.payment q
                           where q.register_order_id = v_order.id and q.reverse_pending_at is not null) then
          update public.register_order set state = 'paid' where id = v_order.id;
          v_hook := public.apply_paid_register_order(v_order.id, v_pay.id);
          -- the receipt shows the cart as paid in full
          update public.payment set receipt = app.payment_receipt_data(v_pay.id) where id = v_pay.id
          returning * into v_pay;
        elsif v_order.state <> 'open' then
          perform app.emit_event(v_pay.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
            'level', 'critical', 'code', 'paid_closed_order', 'payment', v_pay.number,
            'message', format('%s approved for %s, which is already %s — refund it at the register',
                              v_pay.number, v_order.number, v_order.state)));
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'payment', app.payment_json(v_pay),
    'paid_hook', v_hook,
    'order', case when v_order.id is not null then app.register_order_json(v_order.id) end);
end;
$$;

-- Service role only: the route handler records what the provider said (sale_result,
-- status_check). The browser can never mark a payment approved.
create or replace function public.payment_record_result(p_payment_id uuid, p_event text, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event is null or p_event not in ('sale_result', 'status_check') then
    raise exception 'event must be sale_result or status_check' using errcode = '22023';
  end if;
  return app.payment_apply_result(p_payment_id, p_event, p_result);
end;
$$;

-- Service role only: an abort / error the route handler logs against a payment.
create or replace function public.payment_log_event(p_payment_id uuid, p_kind text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('abort', 'error') then
    raise exception 'kind must be abort or error' using errcode = '22023';
  end if;
  insert into public.payment_event (org_id, payment_id, kind, payload)
  select p.org_id, p.id, p_kind::public.payment_event_kind, coalesce(p_payload, '{}'::jsonb)
  from public.payment p where p.id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
end;
$$;

-- docs/05 §2.4: a manager resolves a payment the terminal cannot answer for (status still
-- unknown) — approved, declined or cancelled, with a reason. Manager role or elevation.
create or replace function public.payment_resolve(
  p_client_action_id text, p_payment_id uuid, p_outcome text, p_reason text, p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
  v_action jsonb;
  v_pay public.payment;
  v_result jsonb;
begin
  if p_elevation_token is not null then
    v_manager := app.require_elevation(p_elevation_token);
  else
    perform app.require_role('{owner,manager}');
    select m.id into v_manager from public.org_member m where m.user_id = app.user_id() and m.org_id = app.org_id();
  end if;
  if p_outcome is null or p_outcome not in ('approved', 'declined', 'cancelled') then
    raise exception 'mark the payment approved, declined or cancelled' using errcode = '22023';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'payment.resolve', jsonb_build_object(
    'payment_id', p_payment_id, 'outcome', p_outcome, 'reason', btrim(p_reason), 'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  select * into v_pay from public.payment where id = p_payment_id and org_id = app.org_id();
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_pay.state not in ('pending', 'indeterminate') then
    raise exception '% is already %', v_pay.number, v_pay.state using errcode = '55000';
  end if;
  v_result := app.payment_apply_result(p_payment_id, 'manual_resolve', jsonb_build_object(
    'outcome', p_outcome,
    'message', format('Marked %s by a manager: %s', p_outcome, btrim(p_reason)),
    'card', case when p_outcome = 'declined' then jsonb_build_object('declineReason', btrim(p_reason)) end,
    'raw', jsonb_build_object('manual', true, 'reason', btrim(p_reason), 'approved_by', v_manager)));
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Paid hook ----------------------------------------------------------------------------------

-- THE paid hook (docs/05 §2, docs/04 §11). Settles what the paid cart carries, as payment
-- p_payment_id (null → the cart's latest approved payment):
--   1. settlements → paid; when a session's last settlement is paid, its billed processing
--      charges (app.session_billed_charges) settle. Lock order: org allocation billing lock,
--      sessions (sorted ids), settlements (sorted ids) — the same envelope as allocation writes;
--   2. open charge lines → settled;
--   3. storage batches → app.release_pickup_batches (S5 intake row first, S8 one savepoint per
--      batch, S6 release_failed stamped outside the savepoint, S2 never a second release);
--   4. payment.settled_charge_ids, register_order.paid_hook_*, payment_event 'paid_hook',
--      domain_event 'register_order_paid'.
-- Each settlement / charge runs in its own savepoint (S8): a failure is reported and alerted,
-- never blocks its siblings or the payment. Idempotent: a second call returns the stored
-- result. A refund order never enters the release path (S11).
-- Payment refs (S7): the terminal's provider_ref for card payments; the register order
-- number for cash / check / external; COMP for a COMP.
create or replace function public.apply_paid_register_order(p_order_id uuid, p_payment_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.register_order;
  v_pay public.payment;
  v_ref text;
  v_ids uuid[];
  v_settled uuid[] := '{}';
  v_line record;
  v_st public.settlement;
  v_c public.charge;
  v_status text;
  v_msg text;
  v_settlements jsonb := '[]'::jsonb;
  v_charges jsonb := '[]'::jsonb;
  v_batches jsonb := '[]'::jsonb;
  v_batch_ids uuid[];
  v_amounts jsonb;
  v_result jsonb;
begin
  select * into v_order from public.register_order where id = p_order_id for update;
  if not found then
    raise exception 'register order not found' using errcode = 'P0002';
  end if;
  if app.is_end_user() and v_order.org_id is distinct from app.org_id() then
    raise exception 'register order not found' using errcode = 'P0002';
  end if;
  if v_order.paid_hook_at is not null then
    return jsonb_build_object('status', 'noop', 'result', v_order.paid_hook_result);
  end if;

  -- S11: refunds are not payments; they never release, settle or stamp anything.
  if v_order.kind = 'refund' then
    v_result := jsonb_build_object('status', 'refund', 'order_id', v_order.id, 'released', '[]'::jsonb,
      'message', 'refund orders never enter the release path');
    update public.register_order set paid_hook_at = now(), paid_hook_result = v_result where id = v_order.id;
    insert into public.payment_event (org_id, payment_id, kind, payload)
    values (v_order.org_id, v_order.refund_payment_id, 'paid_hook', v_result);
    return v_result;
  end if;

  if v_order.state <> 'paid' then
    raise exception '% is %; only a paid order runs the paid hook', v_order.number, v_order.state
      using errcode = '55000';
  end if;
  if exists (select 1 from public.payment q
             where q.register_order_id = v_order.id and q.reverse_pending_at is not null) then
    raise exception '% has a void / refund in progress or unconfirmed; it cannot complete until that is settled',
      v_order.number using errcode = '55000', hint = 'reversal_pending';
  end if;
  if p_payment_id is null then
    select * into v_pay from public.payment
    where register_order_id = v_order.id and state = 'approved'
    order by approved_at desc nulls last, created_at desc limit 1;
  else
    select * into v_pay from public.payment where id = p_payment_id and org_id = v_order.org_id;
  end if;
  if v_pay.id is null then
    raise exception '% has no approved payment; a paid order needs one', v_order.number using errcode = '23514';
  end if;
  -- S11: only an approved sale settles or releases.
  if v_pay.state <> 'approved' then
    raise exception 'payment % is %; only an approved payment runs the paid hook', v_pay.number, v_pay.state
      using errcode = '22023';
  end if;
  if v_pay.register_order_id is distinct from v_order.id then
    raise exception 'payment % is not on %', v_pay.number, v_order.number using errcode = '22023';
  end if;
  v_ref := case when v_pay.tender = 'comp' then 'COMP'
                when v_pay.provider = 'manual' then v_order.number
                else coalesce(v_pay.provider_ref, v_order.number) end;
  v_ids := array(select p.id from public.payment p where p.register_order_id = v_order.id and p.state = 'approved');

  -- 1. Settlements: billing lock, sessions, settlements — sorted ids.
  if exists (select 1 from public.register_order_line where register_order_id = v_order.id and settlement_id is not null) then
    perform app.lock_allocation_billing(v_order.org_id);
    perform 1 from public.allocation_session s
    where s.id in (select st.session_id from public.register_order_line l
                   join public.settlement st on st.id = l.settlement_id where l.register_order_id = v_order.id)
    order by s.id for update;
    perform 1 from public.settlement st
    where st.id in (select l.settlement_id from public.register_order_line l where l.register_order_id = v_order.id)
    order by st.id for update;
  end if;
  for v_line in
    select l.* from public.register_order_line l
    where l.register_order_id = v_order.id and l.settlement_id is not null
    order by l.settlement_id
  loop
    begin
      select * into v_st from public.settlement where id = v_line.settlement_id;
      if v_st.state = 'paid' then
        if v_st.paid_payment_id = any (v_ids) then
          v_status := 'noop';
        else
          v_status := 'duplicate_payment';
          perform app.emit_event(v_order.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
            'level', 'critical', 'code', 'charged_twice', 'settlement', v_st.number, 'payment', v_pay.number,
            'message', format('%s was already paid; %s charged it again — refund at the register', v_st.number, v_pay.number)));
        end if;
      else
        update public.settlement set state = 'paid', paid_payment_id = v_pay.id where id = v_st.id;
        v_status := 'paid';
        if v_line.amount <> v_st.amount_total then
          perform app.emit_event(v_order.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
            'level', 'warning', 'code', 'amount_mismatch', 'settlement', v_st.number,
            'message', format('%s charged %s but the settlement is %s', v_st.number, v_line.amount, v_st.amount_total)));
        end if;
        -- The session's pooled processing charges are paid once every angler has paid.
        if not exists (select 1 from public.settlement where session_id = v_st.session_id and state <> 'paid') then
          with s as (
            update public.charge set state = 'settled', settled_payment_id = v_pay.id
            where id in (select b.charge_id from app.session_billed_charges(v_st.session_id) b) and state = 'open'
            returning id)
          select v_settled || coalesce(array_agg(s.id), '{}') into v_settled from s;
        end if;
      end if;
      v_settlements := v_settlements || jsonb_build_object('settlement_id', v_st.id, 'number', v_st.number, 'status', v_status);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_settlements := v_settlements || jsonb_build_object('settlement_id', v_line.settlement_id, 'status', 'failed', 'error', v_msg);
      perform app.emit_event(v_order.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
        'level', 'error', 'code', 'paid_hook_failed', 'settlement_id', v_line.settlement_id,
        'message', format('payment %s captured but settlement update failed: %s', v_pay.number, v_msg)));
    end;
  end loop;

  -- 2. Open charge lines (not storage batches).
  for v_line in
    select l.* from public.register_order_line l
    where l.register_order_id = v_order.id and l.charge_id is not null and l.batch_id is null
    order by l.charge_id
  loop
    begin
      select * into v_c from public.charge where id = v_line.charge_id for update;
      if v_c.state = 'open' then
        update public.charge set state = 'settled', settled_payment_id = v_pay.id where id = v_c.id;
        v_settled := v_settled || v_c.id;
        v_status := 'settled';
      elsif v_c.state = 'settled' and v_c.settled_payment_id = any (v_ids) then
        v_status := 'noop';
      else
        v_status := 'not_open';
        perform app.emit_event(v_order.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
          'level', 'critical', 'code', 'charge_not_open', 'charge', v_c.number, 'payment', v_pay.number,
          'message', format('%s is %s; %s charged it — refund at the register if it was paid twice',
                            v_c.number, v_c.state, v_pay.number)));
      end if;
      v_charges := v_charges || jsonb_build_object('charge_id', v_c.id, 'number', v_c.number, 'status', v_status);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_charges := v_charges || jsonb_build_object('charge_id', v_line.charge_id, 'status', 'failed', 'error', v_msg);
      perform app.emit_event(v_order.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
        'level', 'error', 'code', 'paid_hook_failed', 'charge_id', v_line.charge_id,
        'message', format('payment %s captured but charge update failed: %s', v_pay.number, v_msg)));
    end;
  end loop;

  -- 3. Storage batches (S1–S12 live in app.release_pickup_batch[es]); the untaxed line amount
  -- is compared with the batch amount (S12).
  select array_agg(l.batch_id order by l.batch_id),
         jsonb_object_agg(l.batch_id::text, l.amount)
  into v_batch_ids, v_amounts
  from public.register_order_line l
  where l.register_order_id = v_order.id and l.batch_id is not null;
  if v_batch_ids is not null then
    v_batches := app.release_pickup_batches(v_batch_ids, v_pay.id, v_ref, v_amounts);
    v_settled := v_settled || coalesce(array(
      select pb.charge_id from public.storage_pickup_batch pb
      join public.charge c on c.id = pb.charge_id
      where pb.id = any (v_batch_ids) and c.state = 'settled' and c.settled_payment_id = v_pay.id), '{}');
  end if;

  -- 4. Stamps and audit.
  update public.payment
  set settled_charge_ids = array(select distinct x from unnest(settled_charge_ids || v_settled) x order by x)
  where id = v_pay.id;
  v_result := jsonb_build_object(
    'status', 'applied', 'order_id', v_order.id, 'order_number', v_order.number, 'payment_id', v_pay.id,
    'payment_number', v_pay.number, 'payment_ref', v_ref, 'settlements', v_settlements, 'charges', v_charges,
    'batches', coalesce(v_batches, '[]'::jsonb),
    'retail_lines', (select count(*) from public.register_order_line
                     where register_order_id = v_order.id and retail_product_id is not null),
    'settled_charge_ids', to_jsonb(v_settled));
  update public.register_order set paid_hook_at = now(), paid_hook_result = v_result where id = v_order.id;
  insert into public.payment_event (org_id, payment_id, kind, payload)
  values (v_order.org_id, v_pay.id, 'paid_hook', v_result);
  perform app.emit_event(v_order.org_id, 'register_order_paid', v_order.id, v_result);
  return v_result;
end;
$$;

-- Insert-as-paid and open → paid both reach the hook (CSP lesson: cash orders are paid on
-- create). Deferred to commit, so a cash order inserted as paid fires once its lines and
-- payment exist; the hook is idempotent, so the register's own direct call makes this a no-op.
create or replace function app.register_order_paid_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.apply_paid_register_order(new.id, null);
  return null;
end;
$$;

drop trigger if exists register_order_paid_hook on public.register_order;
create constraint trigger register_order_paid_hook
  after insert or update on public.register_order
  deferrable initially deferred
  for each row
  when (new.state = 'paid' and new.paid_hook_at is null)
  execute function app.register_order_paid_trigger();

-- Void / refund ------------------------------------------------------------------------------

-- docs/04 §11: manager void/refund with a reason. 'reverse' sends the provider a reverse
-- intent for the whole payment — the provider decides void vs refund; 'refund' returns
-- p_amount (≤ the captured amount). Records reverse_requested / refund_requested and returns
-- what the route handler needs; payment_reverse_record stores the provider's answer.
-- ONE reversal at a time: begin reserves it on the payment row (kind, amount, provider ref)
-- under the row lock and commits before the provider is called; every other void / refund is
-- refused until the reservation is settled, so two managers (or a double click) can never
-- both reach the provider. A reversal whose outcome is unknown — the provider call threw
-- (reverse_unresolved), or its request died without recording (reservation older than the
-- route's maxDuration 300 s + margin) — is never retried automatically: a manager checks the
-- processor and settles it with payment_reverse_resolve. Never refund twice.
create or replace function public.payment_reverse_begin(
  p_client_action_id text, p_payment_id uuid, p_kind text, p_reason text,
  p_amount numeric default null, p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
  v_action jsonb;
  v_pay public.payment;
  v_amount numeric;
  v_n int;
  v_ref text;
  v_order_id uuid;
  v_order public.register_order;
  v_other public.payment;
  v_result jsonb;
begin
  if p_elevation_token is not null then
    v_manager := app.require_elevation(p_elevation_token);
  else
    perform app.require_role('{owner,manager}');
    select m.id into v_manager from public.org_member m where m.user_id = app.user_id() and m.org_id = app.org_id();
  end if;
  if p_kind is null or p_kind not in ('reverse', 'refund') then
    raise exception 'kind must be reverse or refund' using errcode = '22023';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'payment.' || p_kind, jsonb_build_object(
    'payment_id', p_payment_id, 'amount', p_amount, 'reason', btrim(p_reason), 'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then
    return (v_action -> 'result') || '{"replayed": true}'::jsonb;
  end if;

  -- Lock order: the cart row, then the payment (as payment_begin and the record functions do),
  -- so a reservation and a charge on the same cart serialize.
  select register_order_id into v_order_id from public.payment where id = p_payment_id and org_id = app.org_id();
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_order_id is not null then
    select * into v_order from public.register_order where id = v_order_id for update;
    select * into v_other from public.payment
    where register_order_id = v_order_id and state in ('pending', 'indeterminate')
    order by created_at limit 1;
    if v_order.state = 'open' and v_other.id is not null then
      raise exception '% is still % on %; wait for its outcome before a void or refund',
        v_other.number, v_other.state, v_order.number using errcode = '55000', hint = 'payment_unresolved';
    end if;
  end if;
  select * into v_pay from public.payment where id = p_payment_id for update;
  if v_pay.state <> 'approved' then
    raise exception '% is %; only an approved payment can be voided or refunded', v_pay.number, v_pay.state
      using errcode = '55000';
  end if;
  -- A void returns everything still captured; a refund at most that (earlier partial refunds
  -- already went back).
  v_amount := case when p_kind = 'reverse' then v_pay.amount - coalesce(v_pay.reversed_amount, 0) else p_amount end;
  if v_amount is null or v_amount <= 0 or v_amount > v_pay.amount - coalesce(v_pay.reversed_amount, 0)
     or v_amount * 100 <> trunc(v_amount * 100) then
    raise exception 'refund amount must be more than 0 and at most % (still captured on %)',
      v_pay.amount - coalesce(v_pay.reversed_amount, 0), v_pay.number using errcode = '22023';
  end if;
  if v_pay.reverse_pending_at is not null then
    if v_pay.reverse_unresolved or v_pay.reverse_pending_at <= now() - interval '6 minutes' then
      raise exception 'the % of % (%, ref %) has no confirmed outcome — the money may already be back. A manager must check the processor and resolve it before another void or refund',
        v_pay.reverse_pending_kind, v_pay.number, v_pay.reverse_pending_amount, v_pay.reverse_pending_ref
        using errcode = '55000', hint = 'reversal_unresolved';
    end if;
    raise exception 'a % of % (%) is already in progress; wait for its result', v_pay.reverse_pending_kind,
      v_pay.number, v_pay.reverse_pending_amount using errcode = '55000', hint = 'reversal_in_flight';
  end if;
  select count(*) + 1 into v_n from public.payment_event
  where payment_id = v_pay.id and kind in ('reverse_requested', 'refund_requested');
  v_ref := case when p_kind = 'reverse' then v_pay.provider_ref else v_pay.provider_ref || '-R' || v_n end;
  update public.payment
  set reverse_pending_at = now(), reverse_pending_kind = p_kind, reverse_pending_amount = v_amount,
      reverse_pending_ref = v_ref, reverse_pending_reason = btrim(p_reason), reverse_unresolved = false
  where id = v_pay.id
  returning * into v_pay;
  insert into public.payment_event (org_id, payment_id, kind, payload)
  values (v_pay.org_id, v_pay.id, (p_kind || '_requested')::public.payment_event_kind, jsonb_build_object(
    'amount', v_amount, 'reason', btrim(p_reason), 'approved_by', v_manager, 'ref', v_ref));
  v_result := app.payment_json(v_pay) || jsonb_build_object(
    'org_id', v_pay.org_id, 'kind', p_kind, 'reverse_amount', v_amount, 'reason', btrim(p_reason),
    'provider_txn', v_pay.provider_txn, 'refund_ref', v_ref, 'approved_by', v_manager);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Settles a reserved reversal with a definite outcome. The caller holds the order and payment
-- locks and has logged the event. Clears the reservation; voided | refunded → the amount is
-- added to reversed_amount (the payment becomes refunded / voided only once everything captured
-- has gone back; a partial refund keeps it approved for the rest), plus a refund register_order (kind refund, inserted as paid) recording amount and
-- reason — the paid hook sees a refund and never releases (S11); anything else leaves the
-- payment approved.
create or replace function app.payment_reverse_settle(p_payment_id uuid, p_outcome text, p_txn text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payment;
  v_amount numeric;
  v_reason text;
  v_total numeric;
  v_refund public.register_order;
  v_hook jsonb;
  v_order public.register_order;
  v_last uuid;
  v_order_hook jsonb;
begin
  select * into v_pay from public.payment where id = p_payment_id;
  v_amount := v_pay.reverse_pending_amount;
  v_reason := v_pay.reverse_pending_reason;
  update public.payment
  set reverse_pending_at = null, reverse_pending_kind = null, reverse_pending_amount = null,
      reverse_pending_ref = null, reverse_pending_reason = null, reverse_unresolved = false
  where id = v_pay.id
  returning * into v_pay;
  if p_outcome in ('voided', 'refunded') and v_pay.state = 'approved' then
    v_total := coalesce(v_pay.reversed_amount, 0) + v_amount;
    update public.payment
    set state = case when v_total >= amount then p_outcome::public.payment_state else state end,
        reversed_amount = v_total, reverse_reason = v_reason, reverse_txn = p_txn
    where id = v_pay.id
    returning * into v_pay;
    insert into public.register_order (org_id, customer_id, kind, state, refund_of_id, refund_payment_id,
                                       refund_amount, reason)
    values (v_pay.org_id, v_pay.customer_id, 'refund', 'paid', v_pay.register_order_id, v_pay.id, v_amount,
            v_reason)
    returning * into v_refund;
    v_hook := public.apply_paid_register_order(v_refund.id, null);
  end if;
  -- A cart held open by this reservation (e.g. a late approval arrived meanwhile) completes now
  -- if what is STILL captured covers it.
  select * into v_order from public.register_order where id = v_pay.register_order_id;
  if v_order.kind = 'sale' and v_order.state = 'open'
     and not exists (select 1 from public.payment q
                     where q.register_order_id = v_order.id and q.reverse_pending_at is not null)
     and (app.register_totals(v_order.id) ->> 'due')::numeric <= 0
     and (app.register_totals(v_order.id) ->> 'paid')::numeric > 0 then
    select q.id into v_last from public.payment q
    where q.register_order_id = v_order.id and q.state = 'approved'
    order by q.approved_at desc nulls last, q.created_at desc limit 1;
    update public.register_order set state = 'paid' where id = v_order.id;
    v_order_hook := public.apply_paid_register_order(v_order.id, v_last);
  end if;
  return jsonb_build_object('status', p_outcome, 'payment', app.payment_json(v_pay),
    'refund_order', case when v_refund.id is not null then app.register_order_json(v_refund.id) end,
    'paid_hook', v_hook, 'order_paid_hook', v_order_hook);
end;
$$;

-- Service role only: stores the provider's reverse / refund answer against the reservation
-- (kind and amount must match; amount and reason come from it).
--   voided | refunded | declined | error → settled (payment_reverse_settle);
--   indeterminate (the provider call threw, or the adapter could not tell) → the reservation is
--     KEPT with its original ref and marked unresolved, a critical payment_alert is raised, and
--     every new void / refund is refused until a manager resolves it.
-- Recording a finished reversal again is a no-op; a stray record is refused.
create or replace function public.payment_reverse_record(
  p_payment_id uuid, p_kind text, p_amount numeric, p_reason text, p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payment;
  v_order_id uuid;
  v_outcome text := p_result ->> 'outcome';
begin
  if p_kind is null or p_kind not in ('reverse', 'refund') then
    raise exception 'kind must be reverse or refund' using errcode = '22023';
  end if;
  if v_outcome is null or v_outcome not in ('voided', 'refunded', 'declined', 'error', 'indeterminate') then
    raise exception 'unknown reverse outcome %', coalesce(v_outcome, 'null') using errcode = '22023';
  end if;
  select register_order_id into v_order_id from public.payment where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_order_id is not null then
    perform 1 from public.register_order where id = v_order_id for update;
  end if;
  select * into v_pay from public.payment where id = p_payment_id for update;
  if v_pay.state in ('voided', 'refunded') and v_pay.reverse_pending_at is null then
    return jsonb_build_object('status', 'noop', 'payment', app.payment_json(v_pay));
  end if;
  if v_pay.reverse_pending_at is null or v_pay.reverse_pending_kind <> p_kind
     or v_pay.reverse_pending_amount <> p_amount then
    raise exception 'no matching % of % is in progress', p_kind, v_pay.number using errcode = '55000';
  end if;
  insert into public.payment_event (org_id, payment_id, kind, payload)
  values (v_pay.org_id, v_pay.id, (p_kind || '_result')::public.payment_event_kind, jsonb_strip_nulls(jsonb_build_object(
    'outcome', v_outcome, 'amount', v_pay.reverse_pending_amount, 'ref', v_pay.reverse_pending_ref,
    'provider_txn', p_result -> 'providerTxn', 'raw', p_result -> 'raw', 'state_before', v_pay.state)));

  if v_outcome = 'indeterminate' then
    update public.payment set reverse_unresolved = true where id = v_pay.id returning * into v_pay;
    perform app.emit_event(v_pay.org_id, 'payment_alert', v_pay.id, jsonb_build_object(
      'level', 'critical', 'code', 'reversal_unresolved', 'payment', v_pay.number,
      'message', format('the %s of %s (%s, ref %s) has no confirmed outcome — check the processor and resolve it',
                        v_pay.reverse_pending_kind, v_pay.number, v_pay.reverse_pending_amount, v_pay.reverse_pending_ref)));
    raise warning 'payment % reversal unresolved (ref %)', v_pay.number, v_pay.reverse_pending_ref;
    return jsonb_build_object('status', 'indeterminate', 'payment', app.payment_json(v_pay));
  end if;
  return app.payment_reverse_settle(v_pay.id, v_outcome, p_result ->> 'providerTxn');
end;
$$;

-- The manager remedy for a reversal with no confirmed outcome (the provider call threw, or its
-- request died): after checking the processor, a manager records what actually happened —
-- 'voided' / 'refunded' (the money went back: payment reversed + refund order) or
-- 'not_reversed' (it did not: the payment stays approved and may be voided / refunded again).
-- Manager role or elevation; a reason; refused while the reversal is still in flight.
create or replace function public.payment_reverse_resolve(
  p_client_action_id text, p_payment_id uuid, p_outcome text, p_reason text, p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
  v_action jsonb;
  v_order_id uuid;
  v_pay public.payment;
  v_result jsonb;
begin
  if p_elevation_token is not null then
    v_manager := app.require_elevation(p_elevation_token);
  else
    perform app.require_role('{owner,manager}');
    select m.id into v_manager from public.org_member m where m.user_id = app.user_id() and m.org_id = app.org_id();
  end if;
  if p_outcome is null or p_outcome not in ('voided', 'refunded', 'not_reversed') then
    raise exception 'resolve as voided, refunded or not_reversed' using errcode = '22023';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'payment.reverse_resolve', jsonb_build_object(
    'payment_id', p_payment_id, 'outcome', p_outcome, 'reason', btrim(p_reason), 'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select register_order_id into v_order_id from public.payment where id = p_payment_id and org_id = app.org_id();
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_order_id is not null then
    perform 1 from public.register_order where id = v_order_id for update;
  end if;
  select * into v_pay from public.payment where id = p_payment_id for update;
  if v_pay.reverse_pending_at is null then
    raise exception '% has no void or refund to resolve', v_pay.number using errcode = '55000';
  end if;
  if not v_pay.reverse_unresolved and v_pay.reverse_pending_at > now() - interval '6 minutes' then
    raise exception 'the % of % is still in progress; wait for its result', v_pay.reverse_pending_kind, v_pay.number
      using errcode = '55000', hint = 'reversal_in_flight';
  end if;
  insert into public.payment_event (org_id, payment_id, kind, payload)
  values (v_pay.org_id, v_pay.id, 'manual_resolve', jsonb_build_object(
    'reversal', v_pay.reverse_pending_kind, 'amount', v_pay.reverse_pending_amount, 'ref', v_pay.reverse_pending_ref,
    'outcome', p_outcome, 'reason', btrim(p_reason), 'approved_by', v_manager));
  v_result := app.payment_reverse_settle(v_pay.id, p_outcome, null);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Receipts -------------------------------------------------------------------------------------

-- The receipt as charged: the snapshot stored at approval (never re-rendered from live data),
-- with the payment's current state so a voided / refunded receipt says so.
create or replace function public.payment_receipt(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pay public.payment;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  select * into v_pay from public.payment where id = p_payment_id and org_id = app.org_id();
  if not found or v_pay.receipt is null then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;
  return v_pay.receipt || jsonb_build_object('payment_id', v_pay.id, 'state', v_pay.state,
    'reversed_amount', v_pay.reversed_amount, 'reverse_reason', v_pay.reverse_reason);
end;
$$;

-- Retail catalogue admin ---------------------------------------------------------------------

-- p_retail_product_id null → create.
create or replace function public.admin_save_retail_product(
  p_client_action_id text, p_retail_product_id uuid, p_name text, p_unit_price numeric,
  p_sku text default null, p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_id uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'retail_product.save', jsonb_build_object(
    'retail_product_id', p_retail_product_id, 'name', p_name, 'unit_price', p_unit_price, 'sku', p_sku,
    'is_active', p_is_active));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(btrim(coalesce(p_name, ''))) = 0 or length(btrim(p_name)) > 80 then
    raise exception 'product needs a name (at most 80 characters)' using errcode = '22023';
  end if;
  if p_unit_price is null or p_unit_price < 0 or p_unit_price * 100 <> trunc(p_unit_price * 100) then
    raise exception 'price must be 0 or more, in cents' using errcode = '22023';
  end if;
  if length(btrim(p_sku)) > 40 then
    raise exception 'SKU is at most 40 characters' using errcode = '22023';
  end if;
  if exists (select 1 from public.retail_product
             where org_id = v_org and name = btrim(p_name) and id is distinct from p_retail_product_id) then
    raise exception 'a product named % already exists', btrim(p_name) using errcode = '23505';
  end if;

  if p_retail_product_id is null then
    insert into public.retail_product (org_id, name, sku, unit_price, is_active)
    values (v_org, btrim(p_name), nullif(btrim(p_sku), ''), p_unit_price, coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.retail_product
    set name = btrim(p_name), sku = nullif(btrim(p_sku), ''), unit_price = p_unit_price,
        is_active = coalesce(p_is_active, true)
    where id = p_retail_product_id and org_id = v_org
    returning id into v_id;
    if v_id is null then
      raise exception 'retail product not found' using errcode = 'P0002';
    end if;
  end if;

  v_result := jsonb_build_object('retail_product_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Grants -------------------------------------------------------------------------------------

revoke all on function
  app.register_order_defaults(),
  app.register_totals(uuid),
  app.payment_json(public.payment),
  app.register_order_json(uuid),
  app.register_lock_cart(uuid),
  app.payment_receipt_data(uuid),
  app.payment_apply_result(uuid, text, jsonb),
  app.payment_reverse_settle(uuid, text, text),
  app.register_order_paid_trigger()
from public;

revoke all on function
  public.payment_terminal_runtime(uuid, uuid),
  public.register_load_outstanding(text, uuid, uuid),
  public.register_add_retail(text, uuid, uuid, numeric),
  public.register_remove_line(text, uuid, uuid),
  public.register_void_order(text, uuid),
  public.register_order(uuid),
  public.payment_begin(text, uuid, numeric, uuid, text, text, text, text),
  public.payment_for_provider(uuid),
  public.payment_record_result(uuid, text, jsonb),
  public.payment_log_event(uuid, text, jsonb),
  public.payment_resolve(text, uuid, text, text, text),
  public.apply_paid_register_order(uuid, uuid),
  public.payment_reverse_begin(text, uuid, text, text, numeric, text),
  public.payment_reverse_record(uuid, text, numeric, text, jsonb),
  public.payment_reverse_resolve(text, uuid, text, text, text),
  public.payment_receipt(uuid),
  public.admin_save_retail_product(text, uuid, text, numeric, text, boolean)
from public, anon, authenticated;

-- Browser-callable (role-checked inside).
grant execute on function
  public.register_load_outstanding(text, uuid, uuid),
  public.register_add_retail(text, uuid, uuid, numeric),
  public.register_remove_line(text, uuid, uuid),
  public.register_void_order(text, uuid),
  public.register_order(uuid),
  public.payment_begin(text, uuid, numeric, uuid, text, text, text, text),
  public.payment_for_provider(uuid),
  public.payment_resolve(text, uuid, text, text, text),
  public.payment_reverse_begin(text, uuid, text, text, numeric, text),
  public.payment_reverse_resolve(text, uuid, text, text, text),
  public.payment_receipt(uuid),
  public.admin_save_retail_product(text, uuid, text, numeric, text, boolean)
to authenticated;

-- Server only: the /api/payments/* route handlers (service role). Recording a provider outcome
-- or reading a terminal secret is never possible from the browser.
grant execute on function
  public.payment_terminal_runtime(uuid, uuid),
  public.payment_record_result(uuid, text, jsonb),
  public.payment_log_event(uuid, text, jsonb),
  public.apply_paid_register_order(uuid, uuid),
  public.payment_reverse_record(uuid, text, numeric, text, jsonb)
to service_role;
