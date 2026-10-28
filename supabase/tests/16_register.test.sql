-- WP-16 payments core + register: Load outstanding (server-computed, replaces cart lines — S3;
-- stale batches re-quoted; paid-unreleased refused — S6; one broken batch never blocks the
-- others — S8), retail lines, tax with cap (§12), the charge flow (pending → approved /
-- partial / declined / cancelled / indeterminate / error; an unresolved payment blocks retry;
-- a retry uses a new ref), apply_paid_register_order (settlements, session charges, open
-- charges, storage release; idempotent; insert-as-paid and transition), manager void/refund
-- (refunds never release — S11), receipts from stored payment data, the Vault terminal secret,
-- server-only result recording and tenancy. Table-driven like 09_storage: every scenario
-- records (invariant, label, got, want) rows in t_check; one assertion per row at the end.
-- TS ↔ SQL tax parity and the route-handler flow: packages/db/src/register.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone, settings) values
  ('a1600000-0000-4000-8000-00000000000a', 'register-a', 'Register A', 'UTC',
   '{"tax": {"mode": "exclusive", "rate": 0.06, "cap_amount": 30}, "receipt_footer": "Thanks!"}'),
  ('b1600000-0000-4000-8000-00000000000b', 'register-b', 'Register B', 'UTC', '{}');
insert into public.site (id, org_id, name, is_default) values
  ('a1600000-0000-4000-8000-0000000000a5', 'a1600000-0000-4000-8000-00000000000a', 'Dock', true);
insert into public.rate_card (id, org_id, name, is_default) values
  ('a1600000-0000-4000-8000-0000000000c1', 'a1600000-0000-4000-8000-00000000000a', 'Standard', true);
insert into public.rate_card_line (org_id, rate_card_id, key, amount) values
  ('a1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-0000000000c1', 'storage_per_box_day', 1.00);
insert into public.customer (id, org_id, name, phone) values
  ('a1600000-0000-4000-8000-0000000002a1', 'a1600000-0000-4000-8000-00000000000a', 'Pat Party', '+19075551601'),
  ('a1600000-0000-4000-8000-0000000002a2', 'a1600000-0000-4000-8000-00000000000a', 'Sam Second', '+19075551602'),
  ('a1600000-0000-4000-8000-0000000002a3', 'a1600000-0000-4000-8000-00000000000a', 'Carl Cash', '+19075551603'),
  ('a1600000-0000-4000-8000-0000000002a4', 'a1600000-0000-4000-8000-00000000000a', 'Lee Late', '+19075551604'),
  ('b1600000-0000-4000-8000-0000000002b1', 'b1600000-0000-4000-8000-00000000000b', 'Other Org', '+19075551605');
insert into public.org_member (id, org_id, user_id, role, display_name)
select 'a1600000-0000-4000-8000-0000000000e1', 'a1600000-0000-4000-8000-00000000000a', u.id, 'manager', 'Mo Manager'
from (select 'a1600000-0000-4000-8000-0000000000f2'::uuid as id) u
where exists (select 1 from auth.users where id = u.id);

-- INT-0001 (Pat) is pooled in ALC-0001 (priced; two anglers); INT-0002 (Sam) is not pooled.
insert into public.intake (id, org_id, number, customer_id, site_id, tote_count) values
  ('a1600000-0000-4000-8000-000000000011', 'a1600000-0000-4000-8000-00000000000a', 'INT-0001',
   'a1600000-0000-4000-8000-0000000002a1', 'a1600000-0000-4000-8000-0000000000a5', 1),
  ('a1600000-0000-4000-8000-000000000012', 'a1600000-0000-4000-8000-00000000000a', 'INT-0002',
   'a1600000-0000-4000-8000-0000000002a2', 'a1600000-0000-4000-8000-0000000000a5', 1);
insert into public.charge (id, org_id, number, customer_id, kind, source_type, source_id, qty, unit, unit_price) values
  ('a1600000-0000-4000-8000-000000000c01', 'a1600000-0000-4000-8000-00000000000a', 'CHG-9001',
   'a1600000-0000-4000-8000-0000000002a1', 'processing', 'intake', 'a1600000-0000-4000-8000-000000000011', 40, 'lb', 1.50),
  ('a1600000-0000-4000-8000-000000000c02', 'a1600000-0000-4000-8000-00000000000a', 'CHG-9002',
   'a1600000-0000-4000-8000-0000000002a2', 'processing', 'intake', 'a1600000-0000-4000-8000-000000000012', 20, 'lb', 1.00),
  ('a1600000-0000-4000-8000-000000000c03', 'a1600000-0000-4000-8000-00000000000a', 'CHG-9003',
   'a1600000-0000-4000-8000-0000000002a1', 'adjustment', 'manual', null, 1, 'each', 5.00),
  ('a1600000-0000-4000-8000-000000000c04', 'a1600000-0000-4000-8000-00000000000a', 'CHG-9004',
   'a1600000-0000-4000-8000-0000000002a3', 'retail', 'manual', null, 1, 'each', 12.00),
  ('a1600000-0000-4000-8000-000000000c05', 'a1600000-0000-4000-8000-00000000000a', 'CHG-9005',
   'a1600000-0000-4000-8000-0000000002a4', 'adjustment', 'manual', null, 1, 'each', 10.00);
insert into public.allocation_session (id, org_id, number, party_customer_id, state) values
  ('a1600000-0000-4000-8000-000000000501', 'a1600000-0000-4000-8000-00000000000a', 'ALC-0001',
   'a1600000-0000-4000-8000-0000000002a1', 'priced');
insert into public.allocation_intake (org_id, session_id, intake_id) values
  ('a1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000501', 'a1600000-0000-4000-8000-000000000011');
insert into public.settlement (id, org_id, number, session_id, angler_name, customer_id, processing_share,
                               box_fee_total, amount_total) values
  ('a1600000-0000-4000-8000-000000000601', 'a1600000-0000-4000-8000-00000000000a', 'STL-0001',
   'a1600000-0000-4000-8000-000000000501', 'Pat', 'a1600000-0000-4000-8000-0000000002a1', 30, 10, 40),
  ('a1600000-0000-4000-8000-000000000602', 'a1600000-0000-4000-8000-00000000000a', 'STL-0002',
   'a1600000-0000-4000-8000-000000000501', 'Bob', null, 30, 0, 30);
insert into public.payment_terminal (id, org_id, name, provider, config, secret_ref) values
  ('a1600000-0000-4000-8000-000000000701', 'a1600000-0000-4000-8000-00000000000a', 'Counter cash', 'manual', '{}', null),
  ('a1600000-0000-4000-8000-000000000702', 'a1600000-0000-4000-8000-00000000000a', 'Dejavoo 1', 'dejavoo_spin',
   '{"tpn": "T-1", "endpoint_url": "https://dev.spinpos.net"}', 'terminal:a1600000-0000-4000-8000-00000000000a:dejavoo-1'),
  ('a1600000-0000-4000-8000-000000000703', 'a1600000-0000-4000-8000-00000000000a', 'No secret yet', 'dejavoo_spin',
   '{}', 'terminal:a1600000-0000-4000-8000-00000000000a:missing');
select vault.create_secret('not-a-real-key', 'terminal:a1600000-0000-4000-8000-00000000000a:dejavoo-1');

create temp table t_ids (k text primary key, v text) on commit drop;
create temp table t_check (seq serial, inv text, label text, got text, want text) on commit drop;
grant all on t_ids, t_check to authenticated;
grant usage on sequence t_check_seq_seq to authenticated;

create function pg_temp.as_role(p_role text, p_org text default 'a1600000-0000-4000-8000-00000000000a') returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', case when p_role = 'manager' then 'a1600000-0000-4000-8000-0000000000f2'
                else 'a1600000-0000-4000-8000-0000000000f1' end,
    'role', 'authenticated', 'org_id', p_org, 'app_role', p_role)::text, true);
$$;
create function pg_temp.id(p_k text) returns uuid language sql as $$
  select v::uuid from t_ids where k = p_k;
$$;
create function pg_temp.res(p_k text) returns jsonb language sql as $$
  select v::jsonb from t_ids where k = p_k;
$$;
create function pg_temp.chk(p_inv text, p_label text, p_got anycompatible, p_want anycompatible) returns void
language sql as $$
  insert into t_check (inv, label, got, want) values (p_inv, p_label, p_got::text, p_want::text);
$$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;
create function pg_temp.kinds(p_cart jsonb) returns text language sql as $$
  select string_agg(l ->> 'kind', ',' order by o) from jsonb_array_elements(p_cart -> 'lines') with ordinality x (l, o);
$$;
create function pg_temp.totals(p_cart jsonb) returns text language sql as $$
  select format('%s+%s=%s paid %s due %s', t ->> 'subtotal', t ->> 'tax', t ->> 'total', t ->> 'paid', t ->> 'due')
  from (select p_cart -> 'totals' as t) x;
$$;
create function pg_temp.cart(p_k text) returns jsonb language sql security definer as $$
  select app.register_order_json(pg_temp.id(p_k));
$$;
create function pg_temp.pay(p_k text) returns public.payment language sql security definer as $$
  select * from public.payment where id = pg_temp.id(p_k);
$$;
-- What the route handler records for the provider's answer (service role in production).
create function pg_temp.record(p_k text, p_event text, p_result jsonb) returns jsonb language sql security definer as $$
  select public.payment_record_result(pg_temp.id(p_k), p_event, p_result);
$$;
create function pg_temp.events(p_k text) returns text language sql security definer as $$
  -- one transaction stamps every event with the same now(): order by the enum (the lifecycle order)
  select string_agg(kind::text, ',' order by kind) from public.payment_event where payment_id = pg_temp.id(p_k);
$$;
create function pg_temp.force_paid(p_k text) returns jsonb language plpgsql security definer as $$
begin
  update public.register_order set state = 'paid' where id = pg_temp.id(p_k);
  return public.apply_paid_register_order(pg_temp.id(p_k), null);
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.as_role('staff');
set local role authenticated;

-- Pat's storage: STG-0001 with two boxes; SPB-0001 = box 1, quoted today (1 day × 1.00).
insert into t_ids select 'si1', public.confirm_storage_intake('wp16-stg-1', jsonb_build_object(
  'customer_id', 'a1600000-0000-4000-8000-0000000002a1', 'boxes', '[{}, {}]'::jsonb)) ->> 'storage_intake_id';
insert into t_ids select 'bx' || box_no, id::text from public.storage_box where storage_intake_id = pg_temp.id('si1');
insert into t_ids select 'B1', public.create_pickup_batch('wp16-spb-1', pg_temp.id('si1'), array[pg_temp.id('bx1')]) ->> 'batch_id';

-- Retail catalogue -----------------------------------------------------------------------------

select pg_temp.chk('RETAIL', 'only managers edit the retail catalogue',
  pg_temp.err($$select public.admin_save_retail_product('wp16-rp-staff', null, 'Ice', 1)$$), '42501');
select pg_temp.as_role('manager');
insert into t_ids select 'rp1', public.admin_save_retail_product('wp16-rp-1', null, ' Ice pack ', 2.50, 'ICE') ->> 'retail_product_id';
insert into t_ids select 'rp2', public.admin_save_retail_product('wp16-rp-2', null, 'Old bags', 1.00, null, false) ->> 'retail_product_id';
select pg_temp.chk('RETAIL', 'a product: trimmed name, sku, price, active',
  (select format('%s|%s|%s|%s', name, sku, unit_price, is_active) from public.retail_product where id = pg_temp.id('rp1')),
  'Ice pack|ICE|2.50|t');
select pg_temp.chk('RETAIL', 'duplicate name / negative or sub-cent price refused',
  pg_temp.err($$select public.admin_save_retail_product('wp16-rp-dup', null, 'Ice pack', 1)$$) || ':'
  || pg_temp.err($$select public.admin_save_retail_product('wp16-rp-neg', null, 'X', -1)$$) || ':'
  || pg_temp.err($$select public.admin_save_retail_product('wp16-rp-mil', null, 'Y', 1.005)$$),
  '23505:22023:22023');
select pg_temp.as_role('cashier');

-- LOAD outstanding (docs/04 §11) -----------------------------------------------------------------

insert into t_ids values ('L1', public.register_load_outstanding('wp16-load-1', 'a1600000-0000-4000-8000-0000000002a1')::text);
insert into t_ids select 'o1', pg_temp.res('L1') ->> 'id';
select pg_temp.chk('LOAD', 'a new cart: REG- number, open sale, Pat',
  format('%s|%s|%s|%s', pg_temp.res('L1') ->> 'number', pg_temp.res('L1') ->> 'kind', pg_temp.res('L1') ->> 'state',
         pg_temp.res('L1') -> 'customer' ->> 'name'), 'REG-0001|sale|open|Pat Party');
select pg_temp.chk('LOAD', 'server-computed lines: both settlements (angler + party), the pending batch, the open direct charge',
  pg_temp.kinds(pg_temp.res('L1')), 'settlement,settlement,storage,charge');
select pg_temp.chk('LOAD', 'lines carry the server ids and amounts',
  (select string_agg(format('%s:%s', coalesce(l ->> 'description', ''), l ->> 'amount'), ' | ' order by o)
   from jsonb_array_elements(pg_temp.res('L1') -> 'lines') with ordinality x (l, o)),
  'STL-0001 — Pat (ALC-0001):40.00 | STL-0002 — Bob (ALC-0001):30.00 | Cold storage SPB-0001 (STG-0001, 1 box):1.00 | Adjustment CHG-9003:5.00');
select pg_temp.chk('LOAD', 'a processing charge billed by a session is NOT a line (it is in the settlements); Sam''s charge is not Pat''s',
  (select count(*) from jsonb_array_elements(pg_temp.res('L1') -> 'lines') l
   where l ->> 'charge_id' in ('a1600000-0000-4000-8000-000000000c01', 'a1600000-0000-4000-8000-000000000c02')), 0);
select pg_temp.chk('TAX', 'exclusive 6%: 76.00 + 4.56 = 80.56',
  pg_temp.totals(pg_temp.res('L1')), '76.00+4.56=80.56 paid 0 due 80.56');

insert into t_ids values ('A1', public.register_add_retail('wp16-add-1', pg_temp.id('o1'), pg_temp.id('rp1'), 2)::text);
select pg_temp.chk('RETAIL', 'retail line: catalogue price × qty, taxed with the rest',
  pg_temp.kinds(pg_temp.res('A1')) || ' ' || pg_temp.totals(pg_temp.res('A1')),
  'settlement,settlement,storage,charge,retail 81.00+4.86=85.86 paid 0 due 85.86');
select pg_temp.chk('RETAIL', 'an inactive product cannot be sold; qty must be > 0',
  pg_temp.err($$select public.register_add_retail('wp16-add-x', pg_temp.id('o1'), pg_temp.id('rp2'), 1)$$) || ':'
  || pg_temp.err($$select public.register_add_retail('wp16-add-y', pg_temp.id('o1'), pg_temp.id('rp1'), 0)$$),
  'P0002:22023');

insert into t_ids values ('L2', public.register_load_outstanding('wp16-load-2', 'a1600000-0000-4000-8000-0000000002a1', pg_temp.id('o1'))::text);
select pg_temp.chk('S3', 'reload replaces every server line with fresh rows; the retail line stays',
  format('%s|%s', pg_temp.kinds(pg_temp.res('L2')),
         (select count(*) from jsonb_array_elements(pg_temp.res('L1') -> 'lines') a
          join jsonb_array_elements(pg_temp.res('L2') -> 'lines') b on a ->> 'id' = b ->> 'id')),
  'settlement,settlement,storage,charge,retail|0');
select pg_temp.chk('S3', 'replaying the load returns the stored result',
  public.register_load_outstanding('wp16-load-2', 'a1600000-0000-4000-8000-0000000002a1', pg_temp.id('o1')) = pg_temp.res('L2'), true);

-- Stale quote: the box has now been in storage 3 days → the batch is re-quoted on load (S3/S4).
reset role;
update public.storage_intake set intake_at = now() - interval '3 days' where id = pg_temp.id('si1');
set local role authenticated;
insert into t_ids values ('L3', public.register_load_outstanding('wp16-load-3', 'a1600000-0000-4000-8000-0000000002a1', pg_temp.id('o1'))::text);
select pg_temp.chk('S3', 'a stale pending batch is re-quoted: new batch, old one superseded, notice',
  format('%s|%s|%s', (select n ->> 'code' from jsonb_array_elements(pg_temp.res('L3') -> 'notices') n limit 1),
         (select state from public.storage_pickup_batch where id = pg_temp.id('B1')),
         (select l ->> 'description' || ':' || (l ->> 'amount') from jsonb_array_elements(pg_temp.res('L3') -> 'lines') l
          where l ->> 'kind' = 'storage')),
  'requoted|void|Cold storage SPB-0002 (STG-0001, 1 box):3.00');
insert into t_ids select 'B2', l ->> 'batch_id' from jsonb_array_elements(pg_temp.res('L3') -> 'lines') l where l ->> 'kind' = 'storage';

-- S6: a paid-but-unreleased batch is never served. S8: a broken batch never blocks the rest.
insert into t_ids select 'si2', public.confirm_storage_intake('wp16-stg-2', jsonb_build_object(
  'customer_id', 'a1600000-0000-4000-8000-0000000002a1', 'boxes', '[{}, {}]'::jsonb)) ->> 'storage_intake_id';
insert into t_ids select 'cx' || box_no, id::text from public.storage_box where storage_intake_id = pg_temp.id('si2');
insert into t_ids select 'B3', public.create_pickup_batch('wp16-spb-3', pg_temp.id('si2'), array[pg_temp.id('cx1')]) ->> 'batch_id';
insert into t_ids select 'B4', public.create_pickup_batch('wp16-spb-4', pg_temp.id('si2'), array[pg_temp.id('cx2')]) ->> 'batch_id';
reset role;
update public.storage_pickup_batch set release_failed = true where id = pg_temp.id('B3');
-- B4's box disappears from under it (released by hand): its snapshot now fails.
update public.storage_box set state = 'released', released_at = now() where id = pg_temp.id('cx2');
set local role authenticated;
insert into t_ids values ('L4', public.register_load_outstanding('wp16-load-4', 'a1600000-0000-4000-8000-0000000002a1', pg_temp.id('o1'))::text);
select pg_temp.chk('S6', 'a release_failed batch is refused with a Force Release notice, never a line',
  format('%s|%s', (select n ->> 'code' from jsonb_array_elements(pg_temp.res('L4') -> 'notices') n
                   where n ->> 'batch_id' = pg_temp.id('B3')::text),
         (select count(*) from jsonb_array_elements(pg_temp.res('L4') -> 'lines') l where l ->> 'batch_id' = pg_temp.id('B3')::text)),
  'paid_not_released|0');
select pg_temp.chk('S8', 'a batch that fails to load is reported; the other lines still load',
  format('%s|%s', (select n ->> 'code' from jsonb_array_elements(pg_temp.res('L4') -> 'notices') n
                   where n ->> 'batch_id' = pg_temp.id('B4')::text),
         pg_temp.kinds(pg_temp.res('L4'))),
  'batch_load_failed|settlement,settlement,storage,charge,retail');

select pg_temp.as_role('cashier', 'b1600000-0000-4000-8000-00000000000b');
select pg_temp.chk('TENANCY', 'another org cannot load, read or charge this org''s customer / cart',
  pg_temp.err($$select public.register_load_outstanding('wp16-load-xorg', 'a1600000-0000-4000-8000-0000000002a1')$$) || ':'
  || pg_temp.err($$select public.register_order(pg_temp.id('o1'))$$) || ':'
  || pg_temp.err($$select public.payment_begin('wp16-pay-xorg', pg_temp.id('o1'), 1, null, 'cash')$$),
  'P0002:P0002:P0002');
select pg_temp.as_role('cashier');

-- TAX §12 ------------------------------------------------------------------------------------------

select pg_temp.chk('TAX', 'cap: 6% on $600 is capped at $30; inclusive; none',
  format('%s|%s|%s', app.tax_amount('{"mode":"exclusive","rate":0.06,"cap_amount":30}', 600),
         app.tax_amount('{"mode":"inclusive","rate":0.06}', 106), app.tax_amount('{"mode":"none","rate":0.06}', 100)),
  '30.00|6.00|0');

-- Charge flow (docs/05 §2) ----------------------------------------------------------------------

select pg_temp.chk('PAY', 'card needs an active card terminal (not the manual one); more than due is refused',
  pg_temp.err($$select public.payment_begin('wp16-pay-noterm', pg_temp.id('o1'), 10)$$) || ':'
  || pg_temp.err($$select public.payment_begin('wp16-pay-manterm', pg_temp.id('o1'), 10, 'a1600000-0000-4000-8000-000000000701')$$) || ':'
  || pg_temp.err($$select public.payment_begin('wp16-pay-over', pg_temp.id('o1'), 1000, 'a1600000-0000-4000-8000-000000000702')$$),
  '22023:22023:22023');
insert into t_ids values ('P1r', public.payment_begin('wp16-pay-1', pg_temp.id('o1'), 10, 'a1600000-0000-4000-8000-000000000702')::text);
insert into t_ids select 'P1', pg_temp.res('P1r') ->> 'id';
select pg_temp.chk('PAY', 'Charge → pending payment, attempt 1, provider_ref <order-hex-24>-1, sale_requested',
  format('%s|%s|%s|%s|%s', (pg_temp.pay('P1')).state, (pg_temp.pay('P1')).attempt, (pg_temp.pay('P1')).provider,
         (pg_temp.pay('P1')).provider_ref = left(replace(pg_temp.id('o1')::text, '-', ''), 24) || '-1', pg_temp.events('P1')),
  'pending|1|dejavoo_spin|t|sale_requested');
select pg_temp.chk('PAY', 'a replayed Charge returns the same payment flagged replayed (the route never re-sends the sale)',
  (select format('%s|%s|%s', r ->> 'id' = pg_temp.id('P1')::text, r ->> 'replayed',
                 (select count(*) from public.payment where register_order_id = pg_temp.id('o1')))
   from (select public.payment_begin('wp16-pay-1', pg_temp.id('o1'), 10, 'a1600000-0000-4000-8000-000000000702') as r) x),
  't|true|1');
select pg_temp.chk('PAY', 'the browser can never record a provider result or read a terminal secret',
  pg_temp.err($$select public.payment_record_result(pg_temp.id('P1'), 'sale_result', '{"outcome":"approved"}')$$) || ':'
  || pg_temp.err($$select public.payment_terminal_runtime('a1600000-0000-4000-8000-000000000702', 'a1600000-0000-4000-8000-00000000000a')$$) || ':'
  || pg_temp.err($$select public.apply_paid_register_order(pg_temp.id('o1'), null)$$),
  '42501:42501:42501');
select pg_temp.chk('INDETERMINATE', 'a pending payment blocks the next Charge (never charge twice)',
  pg_temp.err($$select public.payment_begin('wp16-pay-1b', pg_temp.id('o1'), 5, 'a1600000-0000-4000-8000-000000000702')$$), '55000');
select pg_temp.chk('PAY', 'a cart with a live payment is frozen (no line changes)',
  pg_temp.err($$select public.register_remove_line('wp16-rm-0', pg_temp.id('o1'), (select id from public.register_order_line where register_order_id = pg_temp.id('o1') limit 1))$$),
  '55000');

-- Timeout: the sale is indeterminate; the status check cannot tell either.
select pg_temp.record('P1', 'sale_result', '{"outcome":"indeterminate","message":"Terminal timed out","raw":{"StatusCode":"1999"}}');
select pg_temp.record('P1', 'status_check', '{"outcome":"indeterminate","raw":{"StatusCode":"2001"}}');
select pg_temp.record('P1', 'status_check', '{"outcome":"error","message":"could not reach terminal","raw":{}}');
select pg_temp.chk('INDETERMINATE', 'unknown → indeterminate; a later unknown / transport error leaves it indeterminate',
  format('%s|%s', (pg_temp.pay('P1')).state, pg_temp.events('P1')),
  'indeterminate|sale_requested,sale_result,status_check,status_check');
select pg_temp.chk('INDETERMINATE', 'indeterminate still blocks retry until resolved',
  pg_temp.err($$select public.payment_begin('wp16-pay-1c', pg_temp.id('o1'), 5, 'a1600000-0000-4000-8000-000000000702')$$), '55000');
select pg_temp.chk('INDETERMINATE', 'the cart shows the blocking payment',
  pg_temp.cart('o1') ->> 'blocking_payment_id', pg_temp.id('P1')::text);
select pg_temp.chk('INDETERMINATE', 'only a manager marks a payment by hand, with a reason',
  pg_temp.err($$select public.payment_resolve('wp16-res-0', pg_temp.id('P1'), 'declined', 'no record on the terminal')$$),
  '42501');
select pg_temp.as_role('manager');
select pg_temp.chk('INDETERMINATE', 'manager mark needs a reason',
  pg_temp.err($$select public.payment_resolve('wp16-res-1', pg_temp.id('P1'), 'declined', ' ')$$), '22023');
select public.payment_resolve('wp16-res-2', pg_temp.id('P1'), 'declined', 'no record on the terminal');
select pg_temp.as_role('cashier');
select pg_temp.chk('INDETERMINATE', 'resolved → declined; the event log shows the manual mark',
  format('%s|%s|%s', (pg_temp.pay('P1')).state, (pg_temp.pay('P1')).decline_reason, pg_temp.events('P1')),
  'declined|no record on the terminal|sale_requested,sale_result,status_check,status_check,manual_resolve');

-- Retry: attempt 2 with a new ref; the terminal approves only 6 of 10 (partial approval).
insert into t_ids select 'P2', public.payment_begin('wp16-pay-2', pg_temp.id('o1'), 10, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.chk('PAY', 'retry: attempt 2, a new provider ref that never collides with the first',
  format('%s|%s', (pg_temp.pay('P2')).attempt, (pg_temp.pay('P2')).provider_ref = left(replace(pg_temp.id('o1')::text, '-', ''), 24) || '-2'),
  '2|t');
insert into t_ids values ('R2', pg_temp.record('P2', 'sale_result', '{"outcome":"approved","approvedAmount":6,"providerTxn":"TX-77",
  "card":{"brand":"VISA","last4":"4242","entryMode":"chip","authCode":"OK1234","hostResponseCode":"00"},"raw":{"StatusCode":"0001"}}')::text);
select pg_temp.chk('PARTIAL', 'partial approval counts as approved for the captured amount; the cart stays open with the rest due',
  format('%s|%s|%s/%s|%s|%s', pg_temp.res('R2') ->> 'status', (pg_temp.pay('P2')).state, (pg_temp.pay('P2')).amount,
         (pg_temp.pay('P2')).requested_amount, pg_temp.cart('o1') ->> 'state', pg_temp.totals(pg_temp.cart('o1'))),
  'applied:partial|approved|6.00/10.00|open|83.00+4.98=87.98 paid 6.00 due 81.98');
select pg_temp.chk('PARTIAL', 'card meta stored on the payment (receipt source)',
  (select format('%s|%s|%s|%s|%s|%s', card_brand, card_last4, entry_mode, auth_code, host_response_code, provider_txn)
   from pg_temp.pay('P2')), 'VISA|4242|chip|OK1234|00|TX-77');
select pg_temp.chk('PARTIAL', 'nothing is settled or released by a partial payment',
  format('%s|%s', (select string_agg(state::text, ',' order by number) from public.settlement
                   where session_id = 'a1600000-0000-4000-8000-000000000501'),
         (select state from public.storage_pickup_batch where id = pg_temp.id('B2'))),
  'draft,draft|pending');
select pg_temp.chk('PAY', 'a sale result recorded twice is a no-op',
  pg_temp.record('P2', 'sale_result', '{"outcome":"approved","approvedAmount":6}') ->> 'status', 'noop');
select pg_temp.chk('COMP', 'COMP needs a manager and a reason; check / external need their reference',
  pg_temp.err($$select public.payment_begin('wp16-comp-0', pg_temp.id('o1'), 1, null, 'comp', null, 'goodwill')$$) || ':'
  || pg_temp.err($$select public.payment_begin('wp16-chk-0', pg_temp.id('o1'), 1, null, 'check')$$),
  '42501:22023');

-- Cash for the rest (manual adapter: approved at once) → the cart is paid → the paid hook.
insert into t_ids select 'P3', public.payment_begin('wp16-pay-3', pg_temp.id('o1'), 81.98, null, 'cash') ->> 'id';
insert into t_ids values ('R3', pg_temp.record('P3', 'sale_result', '{"outcome":"approved","approvedAmount":81.98,
  "card":{"entryMode":"manual"},"message":"Cash recorded.","raw":{"tender":{"type":"cash"}}}')::text);
select pg_temp.chk('HOOK', 'the remainder paid → cart paid, paid_at stamped, hook applied',
  format('%s|%s|%s|%s', (pg_temp.pay('P3')).provider, pg_temp.cart('o1') ->> 'state',
         (select paid_at is not null from public.register_order where id = pg_temp.id('o1')), pg_temp.res('R3') -> 'paid_hook' ->> 'status'),
  'manual|paid|t|applied');
select pg_temp.chk('HOOK', 'settlements → paid by the completing payment',
  (select string_agg(format('%s:%s:%s', number, state, paid_payment_id = pg_temp.id('P3')), ',' order by number)
   from public.settlement where session_id = 'a1600000-0000-4000-8000-000000000501'),
  'STL-0001:paid:t,STL-0002:paid:t');
select pg_temp.chk('HOOK', 'the session''s billed processing charge settles once every angler has paid; the direct charge settles',
  (select string_agg(format('%s:%s', number, state), ',' order by number) from public.charge
   where id in ('a1600000-0000-4000-8000-000000000c01', 'a1600000-0000-4000-8000-000000000c02', 'a1600000-0000-4000-8000-000000000c03')),
  'CHG-9001:settled,CHG-9002:open,CHG-9003:settled');
select pg_temp.chk('HOOK', 'storage batch released with the cash ref = the register order number (S7); its box released',
  (select format('%s|%s|%s|%s', pb.state, pb.payment_ref, pb.payment_id = pg_temp.id('P3'),
                 (select state from public.storage_box where id = pg_temp.id('bx1')))
   from public.storage_pickup_batch pb where pb.id = pg_temp.id('B2')),
  'released|REG-0001|t|released');
select pg_temp.chk('HOOK', 'payment.settled_charge_ids = everything the hook settled',
  (select array_length(settled_charge_ids, 1) from pg_temp.pay('P3')), 3);
select pg_temp.chk('HOOK', 'audit: one paid_hook payment_event, one register_order_paid domain event',
  format('%s|%s', pg_temp.events('P3'),
         (select count(*) from public.domain_event where kind = 'register_order_paid' and subject_id = pg_temp.id('o1'))),
  'sale_requested,sale_result,paid_hook|1');

-- Idempotency: the hook runs once whatever re-fires it.
reset role;
insert into t_ids values ('H2', public.apply_paid_register_order(pg_temp.id('o1'), pg_temp.id('P3'))::text);
set constraints all immediate;  -- the deferred insert/transition trigger fires now
set constraints all deferred;
set local role authenticated;
select pg_temp.chk('IDEMPOTENT', 'a second hook call returns the stored result and writes nothing',
  format('%s|%s|%s|%s', pg_temp.res('H2') ->> 'status',
         (select count(*) from public.payment_event where kind = 'paid_hook' and payment_id = pg_temp.id('P3')),
         (select count(*) from public.domain_event where kind = 'register_order_paid' and subject_id = pg_temp.id('o1')),
         (select count(*) from public.storage_box where batch_id = pg_temp.id('B2'))),
  'noop|1|1|1');
select pg_temp.chk('IDEMPOTENT', 'recording the approval again is a no-op; the paid cart takes no more charges',
  pg_temp.record('P3', 'sale_result', '{"outcome":"approved","approvedAmount":81.98}') ->> 'status' || ':'
  || pg_temp.err($$select public.payment_begin('wp16-pay-4', pg_temp.id('o1'), 1, null, 'cash')$$),
  'noop:55000');

-- Receipts render from stored payment data (DECISION-13).
select pg_temp.chk('RECEIPT', 'the receipt is the snapshot: lines, tax, totals, this tender, the earlier card payment',
  (select format('%s|%s|%s|%s|%s|%s|%s|%s|%s', r ->> 'order_number', jsonb_array_length(r -> 'lines'), r ->> 'subtotal', r ->> 'tax',
                 r ->> 'total', r ->> 'due', r -> 'payment' ->> 'tender',
                 (select string_agg(format('%s %s %s', p ->> 'amount', p ->> 'card_brand', p ->> 'card_last4'), ',')
                  from jsonb_array_elements(r -> 'other_payments') p), r -> 'org' ->> 'footer')
   from (select public.payment_receipt(pg_temp.id('P3')) as r) x),
  'REG-0001|5|83.00|4.98|87.98|0.00|cash|6.00 VISA 4242|Thanks!');
reset role;
update public.charge set description = 'renamed later' where id = 'a1600000-0000-4000-8000-000000000c03';
set local role authenticated;
select pg_temp.chk('RECEIPT', 'a reprint is never re-rendered from live data',
  (select l ->> 'description' from jsonb_array_elements(public.payment_receipt(pg_temp.id('P3')) -> 'lines') l
   where l ->> 'charge_id' = 'a1600000-0000-4000-8000-000000000c03'), 'Adjustment CHG-9003');
select pg_temp.chk('RECEIPT', 'the card payment''s receipt carries its card meta',
  (select format('%s %s %s %s', r -> 'payment' ->> 'card_brand', r -> 'payment' ->> 'card_last4',
                 r -> 'payment' ->> 'entry_mode', r -> 'payment' ->> 'auth_code')
   from (select public.payment_receipt(pg_temp.id('P2')) as r) x), 'VISA 4242 chip OK1234');

-- Refunds never release (S11) -------------------------------------------------------------------

-- Sam: a fresh pending batch + his open charge; a partial card payment, then refunded.
insert into t_ids select 'si3', public.confirm_storage_intake('wp16-stg-3', jsonb_build_object(
  'customer_id', 'a1600000-0000-4000-8000-0000000002a2', 'boxes', '[{}]'::jsonb)) ->> 'storage_intake_id';
insert into t_ids select 'B5', public.create_pickup_batch('wp16-spb-5', pg_temp.id('si3'),
  array(select id from public.storage_box where storage_intake_id = pg_temp.id('si3'))) ->> 'batch_id';
insert into t_ids select 'o2', public.register_load_outstanding('wp16-load-5', 'a1600000-0000-4000-8000-0000000002a2') ->> 'id';
insert into t_ids select 'P5', public.payment_begin('wp16-pay-5', pg_temp.id('o2'), 5, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P5', 'sale_result', '{"outcome":"approved","providerTxn":"TX-5","card":{"last4":"1111"}}');
select pg_temp.chk('REFUND', 'void / refund is manager-gated',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rv-0', pg_temp.id('P5'), 'refund', 'customer changed mind', 5)$$), '42501');
select pg_temp.as_role('manager');
select pg_temp.chk('REFUND', 'a refund needs a reason and at most the captured amount',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rv-1', pg_temp.id('P5'), 'refund', '', 5)$$) || ':'
  || pg_temp.err($$select public.payment_reverse_begin('wp16-rv-2', pg_temp.id('P5'), 'refund', 'x', 6)$$),
  '22023:22023');
insert into t_ids values ('RV', public.payment_reverse_begin('wp16-rv-3', pg_temp.id('P5'), 'refund', 'customer changed mind', 5)::text);
select pg_temp.chk('REFUND', 'reverse_begin: refund_requested logged, a refund ref derived from the original',
  format('%s|%s|%s', pg_temp.events('P5'), pg_temp.res('RV') ->> 'reverse_amount',
         pg_temp.res('RV') ->> 'refund_ref' = (pg_temp.pay('P5')).provider_ref || '-R1'),
  'sale_requested,sale_result,refund_requested|5|t');
-- One reversal at a time: the reservation is committed with the request, before the provider call.
select pg_temp.chk('REVERSAL', 'begin reserves the reversal on the payment (kind, amount, ref) while it stays approved',
  (select format('%s|%s|%s|%s', state, reverse_pending_kind, reverse_pending_amount,
                 reverse_pending_ref = pg_temp.res('RV') ->> 'refund_ref') from pg_temp.pay('P5')),
  'approved|refund|5.00|t');
select pg_temp.chk('REVERSAL', 'a competing void / refund (another action id) is refused while one is in flight',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rv-3b', pg_temp.id('P5'), 'refund', 'second manager', 2)$$) || ':'
  || pg_temp.err($$select public.payment_reverse_begin('wp16-rv-3c', pg_temp.id('P5'), 'reverse', 'second manager')$$),
  '55000:55000');
-- The request died without recording (older than the route's lifetime): its outcome is unknown,
-- so nothing new may start — not even the same intent — until it is recorded or resolved.
reset role;
update public.payment set reverse_pending_at = now() - interval '10 minutes' where id = pg_temp.id('P5');
set local role authenticated;
select pg_temp.chk('REVERSAL', 'a reservation whose request died is unresolved: every new void / refund is refused',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rv-3d', pg_temp.id('P5'), 'refund', 'retry', 5)$$) || ':'
  || pg_temp.err($$select public.payment_reverse_begin('wp16-rv-3e', pg_temp.id('P5'), 'refund', 'retry', 4)$$) || ':'
  || (pg_temp.cart('o2') -> 'payments' -> 0 ->> 'reverse_unresolved'),
  '55000:55000:true');
reset role;
select pg_temp.chk('REVERSAL', 'recording a result that does not match the reservation is refused',
  pg_temp.err($$select public.payment_reverse_record(pg_temp.id('P5'), 'refund', 2, 'x', '{"outcome":"refunded"}')$$) || ':'
  || pg_temp.err($$select public.payment_reverse_record(pg_temp.id('P2'), 'reverse', 6, 'x', '{"outcome":"voided"}')$$),
  '55000:55000');
insert into t_ids values ('RR', public.payment_reverse_record(pg_temp.id('P5'), 'refund', 5, 'customer changed mind',
  '{"outcome":"refunded","providerTxn":"TX-5R","raw":{"ProcessedAs":"Return"}}')::text);
select pg_temp.chk('REVERSAL', 'the result clears the reservation; recording it again is a no-op (one refund order)',
  format('%s|%s|%s', (pg_temp.pay('P5')).reverse_pending_at is null,
         public.payment_reverse_record(pg_temp.id('P5'), 'refund', 5, 'x', '{"outcome":"refunded"}') ->> 'status',
         (select count(*) from public.register_order where refund_payment_id = pg_temp.id('P5'))),
  't|noop|1');
set constraints all immediate;
set constraints all deferred;
set local role authenticated;
select pg_temp.chk('REFUND', 'refund order: kind refund, paid, records amount + reason; its hook never releases',
  (select format('%s|%s|%s|%s|%s', o.kind, o.state, o.refund_amount, o.reason, o.paid_hook_result ->> 'status')
   from public.register_order o where o.refund_payment_id = pg_temp.id('P5')),
  'refund|paid|5.00|customer changed mind|refund');
select pg_temp.chk('REFUND', 'the refunded payment: state refunded, amount + txn stored; nothing released or settled',
  format('%s|%s|%s|%s|%s', (pg_temp.pay('P5')).state, (pg_temp.pay('P5')).reversed_amount, (pg_temp.pay('P5')).reverse_txn,
         (select state from public.storage_pickup_batch where id = pg_temp.id('B5')),
         (select state from public.charge where id = 'a1600000-0000-4000-8000-000000000c02')),
  'refunded|5.00|TX-5R|pending|open');
select pg_temp.chk('REFUND', 'the original cart is open again with the full amount due',
  format('%s|%s', pg_temp.cart('o2') ->> 'state', pg_temp.cart('o2') -> 'totals' ->> 'paid'), 'open|0');
select pg_temp.as_role('manager');
select pg_temp.chk('REFUND', 'a refunded payment cannot be reversed again',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rv-4', pg_temp.id('P5'), 'reverse', 'again')$$), '55000');
select pg_temp.as_role('cashier');

-- A provider call that throws (the money may already be back) leaves the reversal UNRESOLVED -----

select pg_temp.as_role('manager');
insert into t_ids values ('RU', public.payment_reverse_begin('wp16-rv-u1', pg_temp.id('P2'), 'refund', 'wrong card', 6)::text);
reset role;
insert into t_ids values ('RUr', public.payment_reverse_record(pg_temp.id('P2'), 'refund', 6, 'wrong card',
  '{"outcome":"indeterminate","raw":{"error":"socket hang up"}}')::text);
select pg_temp.chk('UNRESOLVED', 'indeterminate keeps the reservation (original ref), flags it unresolved, alerts; the payment stays approved',
  (select format('%s|%s|%s|%s|%s', pg_temp.res('RUr') ->> 'status', p.state, p.reverse_unresolved,
                 p.reverse_pending_ref = pg_temp.res('RU') ->> 'refund_ref',
                 (select count(*) from public.domain_event where kind = 'payment_alert' and subject_id = p.id
                    and payload ->> 'code' = 'reversal_unresolved'))
   from pg_temp.pay('P2') p),
  'indeterminate|approved|t|t|1');
select pg_temp.as_role('manager');
select pg_temp.chk('UNRESOLVED', 'every new void / refund is refused until it is resolved (never refund twice)',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rv-u2', pg_temp.id('P2'), 'refund', 'try again', 6)$$) || ':'
  || pg_temp.err($$select public.payment_reverse_begin('wp16-rv-u3', pg_temp.id('P2'), 'reverse', 'try again')$$),
  '55000:55000');
select pg_temp.as_role('cashier');
select pg_temp.chk('UNRESOLVED', 'only a manager resolves it',
  pg_temp.err($$select public.payment_reverse_resolve('wp16-rr-0', pg_temp.id('P2'), 'refunded', 'processor shows it')$$),
  '42501');
select pg_temp.as_role('manager');
select pg_temp.chk('UNRESOLVED', 'resolve needs a reason and a known outcome; nothing to resolve on a payment without one',
  pg_temp.err($$select public.payment_reverse_resolve('wp16-rr-1', pg_temp.id('P2'), 'refunded', ' ')$$) || ':'
  || pg_temp.err($$select public.payment_reverse_resolve('wp16-rr-2', pg_temp.id('P2'), 'maybe', 'x')$$) || ':'
  || pg_temp.err($$select public.payment_reverse_resolve('wp16-rr-3', pg_temp.id('P3'), 'refunded', 'x')$$),
  '22023:22023:55000');
insert into t_ids values ('RRv', public.payment_reverse_resolve('wp16-rr-4', pg_temp.id('P2'), 'refunded',
  'processor portal shows the refund')::text);
select pg_temp.chk('UNRESOLVED', 'manager resolves "refunded": payment refunded, one refund order with the reservation''s amount + reason, event logged',
  (select format('%s|%s|%s|%s|%s', p.state, p.reversed_amount, p.reverse_pending_at is null,
                 (select format('%s:%s', count(*), max(o.refund_amount)) from public.register_order o
                  where o.refund_payment_id = p.id and o.reason = 'wrong card'),
                 (select count(*) from public.payment_event where payment_id = p.id and kind = 'manual_resolve'))
   from pg_temp.pay('P2') p),
  'refunded|6.00|t|1:6.00|1');
-- 'not_reversed': the money did not go back — the payment stays approved and may be reversed again.
insert into t_ids values ('RU3', public.payment_reverse_begin('wp16-rv-u4', pg_temp.id('P3'), 'reverse', 'void it')::text);
reset role;
select public.payment_reverse_record(pg_temp.id('P3'), 'reverse', 81.98, 'void it', '{"outcome":"indeterminate"}');
set local role authenticated;
select public.payment_reverse_resolve('wp16-rr-5', pg_temp.id('P3'), 'not_reversed', 'processor shows no void');
select pg_temp.chk('UNRESOLVED', 'manager resolves "not_reversed": still approved, reservation cleared, reversible again',
  (select format('%s|%s|%s', p.state, p.reverse_pending_at is null,
                 (public.payment_reverse_begin('wp16-rv-u5', p.id, 'refund', 'second try', 1) ->> 'refund_ref') is not null)
   from pg_temp.pay('P3') p),
  'approved|t|t');
select pg_temp.as_role('cashier');
-- Even a refund order carrying a batch line (any writer) never enters the release path.
reset role;
insert into public.register_order (id, org_id, customer_id, kind, state, refund_payment_id, refund_amount, reason)
values ('a1600000-0000-4000-8000-0000000009f1', 'a1600000-0000-4000-8000-00000000000a',
        'a1600000-0000-4000-8000-0000000002a2', 'refund', 'paid', pg_temp.id('P5'), 1, 'test: refund with a batch line');
insert into public.register_order_line (org_id, register_order_id, charge_id, batch_id, qty, unit_price)
select org_id, 'a1600000-0000-4000-8000-0000000009f1', charge_id, id, 1, -amount
from public.storage_pickup_batch where id = pg_temp.id('B5');
set constraints all immediate;
set constraints all deferred;
select pg_temp.chk('S11', 'a refund order with a batch line: hook status refund; batch still pending, no release note',
  format('%s|%s|%s', (select paid_hook_result ->> 'status' from public.register_order where id = 'a1600000-0000-4000-8000-0000000009f1'),
         (select state from public.storage_pickup_batch where id = pg_temp.id('B5')),
         (select notes !~ 'released' from public.storage_pickup_batch where id = pg_temp.id('B5'))),
  'refund|pending|t');
set local role authenticated;

-- Partial refunds keep the rest captured ----------------------------------------------------------

-- Sam's open cart (22.26 due) is paid in two lines: card 10 + cash 5 → 7.26 still due.
insert into t_ids select 'P9', public.payment_begin('wp16-pay-9', pg_temp.id('o2'), 10, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P9', 'sale_result', '{"outcome":"approved","providerTxn":"TX-9","card":{"last4":"9999"}}');
insert into t_ids select 'P10', public.payment_begin('wp16-pay-10', pg_temp.id('o2'), 5, null, 'cash') ->> 'id';
select pg_temp.record('P10', 'sale_result', '{"outcome":"approved"}');
select pg_temp.chk('PARTIAL-REFUND', 'split-payment cart: card 10 + cash 5 paid, the rest still due',
  pg_temp.totals(pg_temp.cart('o2')), '21.00+1.26=22.26 paid 15.00 due 7.26');
reset role;  -- owned by the superuser: it plays the route (service role) between manager calls
create function pg_temp.refund(p_id text, p_pay text, p_kind text, p_amount numeric, p_reason text) returns jsonb
language plpgsql security definer as $$
declare v_r jsonb;
begin
  perform pg_temp.as_role('manager');
  v_r := public.payment_reverse_begin(p_id, pg_temp.id(p_pay), p_kind, p_reason, p_amount);
  perform public.payment_reverse_record(pg_temp.id(p_pay), p_kind, (v_r ->> 'reverse_amount')::numeric, p_reason,
    jsonb_build_object('outcome', case when p_kind = 'reverse' then 'voided' else 'refunded' end));
  perform pg_temp.as_role('cashier');
  return v_r;
end;
$$;
create function pg_temp.refundable(p_payment uuid) returns text language sql security definer as $$
  select app.payment_json(p) ->> 'refundable' from public.payment p where p.id = p_payment;
$$;
grant execute on function pg_temp.refund(text, text, text, numeric, text), pg_temp.refundable(uuid) to authenticated;
set local role authenticated;

select pg_temp.refund('wp16-prf-1', 'P9', 'refund', 2, 'one bag short');
select pg_temp.chk('PARTIAL-REFUND', 'refunding 2 of 10: the payment stays approved with 8 still captured and refundable',
  (select format('%s|%s|%s', p.state, p.reversed_amount, pg_temp.refundable(p.id)) from pg_temp.pay('P9') p),
  'approved|2.00|8.00');
select pg_temp.chk('PARTIAL-REFUND', '… the open cart loses exactly the refunded 2, not the whole 10',
  pg_temp.totals(pg_temp.cart('o2')), '21.00+1.26=22.26 paid 13.00 due 9.26');
select pg_temp.as_role('manager');
select pg_temp.chk('PARTIAL-REFUND', 'a later refund is limited to what is still captured (8)',
  pg_temp.err($$select public.payment_reverse_begin('wp16-prf-2', pg_temp.id('P9'), 'refund', 'too much', 9)$$), '22023');
select pg_temp.as_role('cashier');
select pg_temp.refund('wp16-prf-3', 'P9', 'refund', 8, 'rest of it');
select pg_temp.chk('PARTIAL-REFUND', 'refunding the remaining 8: the payment is now refunded (10 back in total)',
  (select format('%s|%s|%s', p.state, p.reversed_amount, pg_temp.refundable(p.id)) from pg_temp.pay('P9') p),
  'refunded|10.00|0');
select pg_temp.chk('PARTIAL-REFUND', 'one refund order per refund: 2 then 8',
  (select string_agg(refund_amount::text, ',' order by refund_amount) from public.register_order
   where refund_payment_id = pg_temp.id('P9')), '2.00,8.00');
-- A void after a partial refund returns only what is still captured.
select pg_temp.refund('wp16-prf-4', 'P10', 'refund', 1, 'change');
insert into t_ids values ('PV', pg_temp.refund('wp16-prf-5', 'P10', 'reverse', null, 'void the rest')::text);
select pg_temp.chk('PARTIAL-REFUND', 'void after refunding 1 of 5: reverses the remaining 4; payment voided, 5 back',
  (select format('%s|%s|%s', pg_temp.res('PV') ->> 'reverse_amount', p.state, p.reversed_amount) from pg_temp.pay('P10') p),
  '4.00|voided|5.00');
select pg_temp.chk('PARTIAL-REFUND', 'the cart is back to the full amount due',
  pg_temp.totals(pg_temp.cart('o2')), '21.00+1.26=22.26 paid 0 due 22.26');

-- A reserved reversal blocks completing the cart (its money may already be back) ---------------

-- Sam's cart is open again (22.26 due). Card 10 approved; a second card sale (12.26) is in flight.
insert into t_ids select 'P11', public.payment_begin('wp16-pay-11', pg_temp.id('o2'), 10, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P11', 'sale_result', '{"outcome":"approved","providerTxn":"TX-11"}');
insert into t_ids select 'P12', public.payment_begin('wp16-pay-12', pg_temp.id('o2'), 12.26, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.as_role('manager');
select pg_temp.chk('REVERSAL-BLOCK', 'no void / refund on a cart while one of its sales is still in flight (same cart lock)',
  pg_temp.err($$select public.payment_reverse_begin('wp16-rvb-0', pg_temp.id('P11'), 'refund', 'x', 10)$$), '55000');
select pg_temp.chk('INDETERMINATE', 'a FRESH pending sale may still be running on the terminal: a manager cannot mark it',
  (select format('%s|%s', pg_temp.err($$select public.payment_resolve('wp16-res-fresh', pg_temp.id('P12'), 'declined', 'cashier pressed Cancel')$$),
                 (pg_temp.pay('P12')).state)),
  '55000|pending');
select pg_temp.as_role('cashier');
select pg_temp.record('P12', 'sale_result', '{"outcome":"cancelled"}');
-- The 10 refund reaches the provider, which returns the money, then the call throws.
select pg_temp.as_role('manager');
insert into t_ids values ('RV11', public.payment_reverse_begin('wp16-rvb-1', pg_temp.id('P11'), 'refund', 'customer left', 10)::text);
reset role;
select public.payment_reverse_record(pg_temp.id('P11'), 'refund', 10, 'customer left', '{"outcome":"indeterminate"}');
set local role authenticated;
select pg_temp.as_role('cashier');
select pg_temp.chk('REVERSAL-BLOCK', 'the cart shows the reversal blocker; the displayed balance cannot be charged',
  format('%s|%s', pg_temp.cart('o2') ->> 'reversal_payment_id' = pg_temp.id('P11')::text,
         pg_temp.err($$select public.payment_begin('wp16-pay-13', pg_temp.id('o2'), 12.26, null, 'cash')$$)),
  't|55000');
-- A late approval of the cancelled 12.26 sale arrives meanwhile: it is kept, but the cart does
-- not complete on credit that may already have been refunded.
select pg_temp.record('P12', 'status_check', '{"outcome":"approved","approvedAmount":12.26}');
select pg_temp.chk('REVERSAL-BLOCK', 'a late approval never completes a cart with a reserved reversal: still open, nothing released',
  format('%s|%s|%s', (pg_temp.pay('P12')).state, pg_temp.cart('o2') ->> 'state',
         (select state from public.storage_pickup_batch where id = pg_temp.id('B5'))),
  'approved|open|pending');
reset role;
select pg_temp.chk('REVERSAL-BLOCK', 'the paid hook refuses a cart with a reserved reversal (any writer)',
  pg_temp.err($$select pg_temp.force_paid('o2')$$), '55000');
set local role authenticated;
-- The manager finds the refund went through.
select pg_temp.as_role('manager');
select public.payment_reverse_resolve('wp16-rvb-2', pg_temp.id('P11'), 'refunded', 'processor shows the refund');
select pg_temp.as_role('cashier');
select pg_temp.chk('REVERSAL-BLOCK', 'after resolving "refunded": the cart is still open with 10 due, storage not released',
  format('%s|%s|%s', pg_temp.cart('o2') ->> 'state', pg_temp.totals(pg_temp.cart('o2')),
         (select state from public.storage_pickup_batch where id = pg_temp.id('B5'))),
  'open|21.00+1.26=22.26 paid 12.26 due 10.00|pending');
insert into t_ids select 'P14', public.payment_begin('wp16-pay-14', pg_temp.id('o2'), 10, null, 'cash') ->> 'id';
select pg_temp.record('P14', 'sale_result', '{"outcome":"approved"}');
select pg_temp.chk('REVERSAL-BLOCK', 'paying the real balance completes the cart and runs the hook',
  format('%s|%s|%s', pg_temp.cart('o2') ->> 'state', pg_temp.cart('o2') -> 'paid_hook' ->> 'status',
         (select state from public.storage_pickup_batch where id = pg_temp.id('B5'))),
  'paid|applied|released');

-- Resolving "not reversed" completes a cart the reservation was holding open.
reset role;
insert into public.charge (id, org_id, number, customer_id, kind, source_type, qty, unit, unit_price) values
  ('a1600000-0000-4000-8000-000000000c06', 'a1600000-0000-4000-8000-00000000000a', 'CHG-9006',
   'a1600000-0000-4000-8000-0000000002a1', 'adjustment', 'manual', 1, 'each', 10.00);
set local role authenticated;
insert into t_ids select 'o4', public.register_load_outstanding('wp16-load-7', 'a1600000-0000-4000-8000-0000000002a1') ->> 'id';
insert into t_ids select 'P15', public.payment_begin('wp16-pay-15', pg_temp.id('o4'), 5, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P15', 'sale_result', '{"outcome":"approved"}');
insert into t_ids select 'P16', public.payment_begin('wp16-pay-16', pg_temp.id('o4'), 5.60, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
-- Its request is certainly over once it is older than the route's lifetime: a manager may mark it.
reset role;
update public.payment set created_at = now() - interval '7 minutes' where id = pg_temp.id('P16');
set local role authenticated;
select pg_temp.as_role('manager');
select pg_temp.chk('INDETERMINATE', 'a pending sale older than the in-flight window can be marked by a manager',
  public.payment_resolve('wp16-res-old', pg_temp.id('P16'), 'cancelled', 'request timed out long ago') -> 'payment' ->> 'state',
  'cancelled');
select pg_temp.as_role('cashier');
select pg_temp.chk('INDETERMINATE', 'the sale result arriving later for the marked payment is a no-op',
  pg_temp.record('P16', 'sale_result', '{"outcome":"cancelled"}') ->> 'status', 'noop');
select pg_temp.as_role('manager');
select public.payment_reverse_begin('wp16-rvb-3', pg_temp.id('P15'), 'refund', 'mistake', 5);
reset role;
select public.payment_reverse_record(pg_temp.id('P15'), 'refund', 5, 'mistake', '{"outcome":"indeterminate"}');
set local role authenticated;
select pg_temp.as_role('cashier');
select pg_temp.record('P16', 'status_check', '{"outcome":"approved","approvedAmount":5.60}');
select pg_temp.chk('REVERSAL-BLOCK', 'covered by captured payments but held open by the reserved refund',
  format('%s|%s', pg_temp.cart('o4') ->> 'state', pg_temp.cart('o4') -> 'totals' ->> 'due'), 'open|0.00');
select pg_temp.as_role('manager');
insert into t_ids values ('NR', public.payment_reverse_resolve('wp16-rvb-4', pg_temp.id('P15'), 'not_reversed',
  'processor shows no refund')::text);
select pg_temp.as_role('cashier');
select pg_temp.chk('REVERSAL-BLOCK', 'resolving "not reversed": the money is still captured, so the cart completes and the hook runs',
  format('%s|%s|%s', pg_temp.cart('o4') ->> 'state', pg_temp.res('NR') -> 'order_paid_hook' ->> 'status',
         (select state from public.charge where id = 'a1600000-0000-4000-8000-000000000c06')),
  'paid|applied|settled');

-- Cash: insert-as-paid (the CSP lesson: cash orders are paid on create) ---------------------------

reset role;
insert into public.register_order (id, org_id, customer_id, state)
values ('a1600000-0000-4000-8000-0000000009c1', 'a1600000-0000-4000-8000-00000000000a',
        'a1600000-0000-4000-8000-0000000002a3', 'paid');
insert into public.register_order_line (org_id, register_order_id, charge_id, qty, unit_price, description)
values ('a1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-0000000009c1',
        'a1600000-0000-4000-8000-000000000c04', 1, 12.00, 'Retail CHG-9004');
insert into public.payment (id, org_id, number, customer_id, provider, amount, state, tender, register_order_id, provider_ref)
values ('a1600000-0000-4000-8000-0000000009c2', 'a1600000-0000-4000-8000-00000000000a', 'PAY-9001',
        'a1600000-0000-4000-8000-0000000002a3', 'manual', 12.72, 'approved', 'cash',
        'a1600000-0000-4000-8000-0000000009c1', 'cash-9001');
select pg_temp.chk('CASH', 'before commit the deferred hook has not run',
  (select paid_hook_at is null from public.register_order where id = 'a1600000-0000-4000-8000-0000000009c1'), true);
set constraints all immediate;
set constraints all deferred;
select pg_temp.chk('CASH', 'insert-as-paid: number + tax snapshot assigned, hook ran: charge settled by the cash payment, ref = order number',
  (select format('%s|%s|%s|%s|%s', o.number ~ '^REG-[0-9]{4}$', o.tax ->> 'rate', o.paid_hook_result ->> 'status',
                 o.paid_hook_result ->> 'payment_ref' = o.number,
                 (select format('%s:%s', c.state, c.settled_payment_id = 'a1600000-0000-4000-8000-0000000009c2')
                  from public.charge c where c.id = 'a1600000-0000-4000-8000-000000000c04'))
   from public.register_order o where o.id = 'a1600000-0000-4000-8000-0000000009c1'),
  't|0.06|applied|t|settled:t');
create function pg_temp.paid_without_payment() returns void language plpgsql as $$
begin
  insert into public.register_order (org_id, customer_id, state)
  values ('a1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-0000000002a3', 'paid');
  set constraints all immediate;
end;
$$;
select pg_temp.chk('CASH', 'a paid order with no approved payment is refused at commit',
  pg_temp.err($$select pg_temp.paid_without_payment()$$), '23514');
set constraints all deferred;
set local role authenticated;

-- Declined / cancelled / error, and a late approval (never lose a capture) ------------------------

insert into t_ids select 'o3', public.register_load_outstanding('wp16-load-6', 'a1600000-0000-4000-8000-0000000002a4') ->> 'id';
insert into t_ids select 'P6', public.payment_begin('wp16-pay-6', pg_temp.id('o3'), 10.60, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P6', 'sale_result', '{"outcome":"declined","card":{"hostResponseCode":"51","declineReason":"Insufficient funds"}}');
insert into t_ids select 'P7', public.payment_begin('wp16-pay-7', pg_temp.id('o3'), 10.60, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P7', 'sale_result', '{"outcome":"cancelled","message":"Cancelled at the terminal"}');
insert into t_ids select 'P8', public.payment_begin('wp16-pay-8', pg_temp.id('o3'), 10.60, 'a1600000-0000-4000-8000-000000000702') ->> 'id';
select pg_temp.record('P8', 'sale_result', '{"outcome":"error","message":"could not reach terminal"}');
select pg_temp.chk('FLOW', 'declined (bank reason kept) / cancelled / error each leave the cart open for a retry',
  format('%s:%s|%s|%s|%s', (pg_temp.pay('P6')).state, (pg_temp.pay('P6')).decline_reason, (pg_temp.pay('P7')).state,
         (pg_temp.pay('P8')).state, pg_temp.cart('o3') ->> 'blocking_payment_id' is null),
  'declined:Insufficient funds|cancelled|error|t');
insert into t_ids values ('R7', pg_temp.record('P7', 'status_check', '{"outcome":"approved","approvedAmount":10.60,"providerTxn":"TX-LATE"}')::text);
select pg_temp.chk('FLOW', 'a capture reported after the payment was recorded cancelled is kept (approved) and alerted',
  format('%s|%s|%s|%s', pg_temp.res('R7') ->> 'status', (pg_temp.pay('P7')).state, pg_temp.cart('o3') ->> 'state',
         (select count(*) from public.domain_event where kind = 'payment_alert' and subject_id = pg_temp.id('P7')
            and payload ->> 'code' = 'late_approval')),
  'late_approval|approved|paid|1');

-- Terminal secret from Vault (service role only) ---------------------------------------------------

reset role;
select pg_temp.chk('VAULT', 'TerminalConfig = config + the Vault secret named by secret_ref',
  (select format('%s|%s|%s', r ->> 'provider', r -> 'config' ->> 'tpn', r ->> 'secret')
   from (select public.payment_terminal_runtime('a1600000-0000-4000-8000-000000000702', 'a1600000-0000-4000-8000-00000000000a') as r) x),
  'dejavoo_spin|T-1|not-a-real-key');
select pg_temp.chk('VAULT', 'a missing secret, or another org''s terminal, is not found',
  pg_temp.err($$select public.payment_terminal_runtime('a1600000-0000-4000-8000-000000000703', 'a1600000-0000-4000-8000-00000000000a')$$) || ':'
  || pg_temp.err($$select public.payment_terminal_runtime('a1600000-0000-4000-8000-000000000702', 'b1600000-0000-4000-8000-00000000000b')$$),
  'P0002:P0002');
select pg_temp.chk('VAULT', 'no table or event stores the secret',
  (select count(*) from public.payment_event where payload::text like '%not-a-real-key%')
  + (select count(*) from public.payment_terminal where config::text like '%not-a-real-key%'), 0);

-- Assertions -----------------------------------------------------------------------------------------

select is(got, want, format('%s — %s', inv, label)) from t_check order by seq;

select * from finish();
rollback;
