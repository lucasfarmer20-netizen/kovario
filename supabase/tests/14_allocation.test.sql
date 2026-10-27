-- WP-14 counter allocation: box size catalogue, session create/edit from one or more intakes
-- (m2m), anglers with per-angler species lb, box plans (method, size, weight, 70-lb heavy
-- check), price_session (pooled processing charges split weight/even by the penny rule, box
-- fees, freight placeholder), an intake pooled in two sessions (billed once), box plans with no
-- vessel link, settlement receipts with the boxing QR, the fulfillment rollup and session list,
-- tenancy and replay. TS ↔ SQL penny-rule parity: packages/db/src/allocation.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a1400000-0000-4000-8000-00000000000a', 'alloc-a', 'Alloc A', 'America/Anchorage'),
  ('b1400000-0000-4000-8000-00000000000b', 'alloc-b', 'Alloc B', 'UTC');
insert into public.site (id, org_id, name, is_default) values
  ('a1400000-0000-4000-8000-0000000000a5', 'a1400000-0000-4000-8000-00000000000a', 'Dock', true);
insert into public.species (org_id, code, name, "group") values
  ('a1400000-0000-4000-8000-00000000000a', 'salmon_silvers', 'Silvers', 'salmon'),
  ('a1400000-0000-4000-8000-00000000000a', 'whitefish_halibut', 'Halibut', 'whitefish');
insert into public.processing_method (org_id, code, name, kind) values
  ('a1400000-0000-4000-8000-00000000000a', 'fillets', 'Fillets', 'service'),
  ('a1400000-0000-4000-8000-00000000000a', 'portions', 'Portions', 'service');
insert into public.customer (id, org_id, name, phone) values
  ('a1400000-0000-4000-8000-0000000002a1', 'a1400000-0000-4000-8000-00000000000a', 'Pat Party', '+19075551401'),
  ('a1400000-0000-4000-8000-0000000002a2', 'a1400000-0000-4000-8000-00000000000a', 'Sam Second', '+19075551402'),
  ('b1400000-0000-4000-8000-0000000002b1', 'b1400000-0000-4000-8000-00000000000b', 'Other Org', '+19075551403');

-- INT-0001 + INT-0002: Pat's party (two boats). INT-0003: Sam. INT-0004: an unsaved draft.
insert into public.intake (id, org_id, number, customer_id, site_id, tote_count) values
  ('a1400000-0000-4000-8000-000000000011', 'a1400000-0000-4000-8000-00000000000a', 'INT-0001',
   'a1400000-0000-4000-8000-0000000002a1', 'a1400000-0000-4000-8000-0000000000a5', 2),
  ('a1400000-0000-4000-8000-000000000012', 'a1400000-0000-4000-8000-00000000000a', 'INT-0002',
   'a1400000-0000-4000-8000-0000000002a1', 'a1400000-0000-4000-8000-0000000000a5', 1),
  ('a1400000-0000-4000-8000-000000000013', 'a1400000-0000-4000-8000-00000000000a', 'INT-0003',
   'a1400000-0000-4000-8000-0000000002a2', 'a1400000-0000-4000-8000-0000000000a5', 1),
  ('a1400000-0000-4000-8000-000000000014', 'a1400000-0000-4000-8000-00000000000a', 'INT-0004',
   'a1400000-0000-4000-8000-0000000002a2', 'a1400000-0000-4000-8000-0000000000a5', 1);
update public.intake set state = 'holding' where number <> 'INT-0004';

-- Pooled processing charges: INT-0001 45.00 + 15.00 ribbing, INT-0002 40.01 → 100.01.
-- Not pooled: a voided charge, a comped one, a storage charge. INT-0003: 20.00.
insert into public.charge (org_id, number, customer_id, kind, source_type, source_id, qty, unit,
                           unit_price, state, comp_reason) values
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0001', 'a1400000-0000-4000-8000-0000000002a1', 'processing',
   'intake', 'a1400000-0000-4000-8000-000000000011', 30, 'lb', 1.50, 'open', null),
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0002', 'a1400000-0000-4000-8000-0000000002a1', 'ribbing',
   'intake', 'a1400000-0000-4000-8000-000000000011', 30, 'lb', 0.50, 'open', null),
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0003', 'a1400000-0000-4000-8000-0000000002a1', 'processing',
   'intake', 'a1400000-0000-4000-8000-000000000012', 40.01, 'lb', 1.00, 'open', null),
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0004', 'a1400000-0000-4000-8000-0000000002a1', 'processing',
   'intake', 'a1400000-0000-4000-8000-000000000012', 10, 'lb', 1.00, 'voided', null),
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0005', 'a1400000-0000-4000-8000-0000000002a1', 'processing',
   'intake', 'a1400000-0000-4000-8000-000000000012', 10, 'lb', 1.00, 'comped', 'goodwill'),
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0006', 'a1400000-0000-4000-8000-0000000002a1', 'storage',
   'intake', 'a1400000-0000-4000-8000-000000000011', 3, 'day', 2.00, 'open', null),
  ('a1400000-0000-4000-8000-00000000000a', 'CHG-0007', 'a1400000-0000-4000-8000-0000000002a2', 'processing',
   'intake', 'a1400000-0000-4000-8000-000000000013', 16, 'lb', 1.25, 'open', null);

insert into public.printer (id, org_id, name, site_id, kind, is_default_for) values
  ('a1400000-0000-4000-8000-0000000003a2', 'a1400000-0000-4000-8000-00000000000a', 'Counter receipt',
   'a1400000-0000-4000-8000-0000000000a5', 'receipt_pdf', '{"receipt": true}');

create temp table t_ids (k text primary key, v text) on commit drop;
grant all on t_ids to authenticated;

create function pg_temp.as_role(p_org text, p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a1400000-0000-4000-8000-0000000000f1', 'role', 'authenticated',
    'org_id', p_org, 'app_role', p_role)::text, true);
$$;
create function pg_temp.id(p_k text) returns uuid language sql as $$
  select v::uuid from t_ids where k = p_k;
$$;
-- A session's current state as a save payload (ids included), for edit round trips.
create function pg_temp.current_payload(p_session uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'session_id', s.id, 'party_customer_id', s.party_customer_id, 'split_method', s.split_method,
    'notes', s.notes,
    'intake_ids', (select jsonb_agg(ai.intake_id order by ai.intake_id)
                   from public.allocation_intake ai where ai.session_id = s.id),
    'settlements', coalesce((select jsonb_agg(jsonb_build_object(
        'id', st.id, 'angler_name', st.angler_name, 'customer_id', st.customer_id,
        'retail_note', st.retail_note,
        'species', coalesce((select jsonb_agg(jsonb_build_object('species_code', ss.species_code,
                               'method_code', ss.method_code, 'lb', ss.lb) order by ss.species_code)
                             from public.settlement_species ss where ss.settlement_id = st.id), '[]'),
        'boxes', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'method', b.method,
                             'box_size_id', b.box_size_id, 'weight_lb', b.weight_lb,
                             'heavy_allowed', b.heavy_allowed) order by app.number_order(b.number))
                           from public.box_plan b where b.settlement_id = st.id), '[]'))
      order by app.number_order(st.number))
      from public.settlement st where st.session_id = s.id), '[]'))
  from public.allocation_session s where s.id = p_session;
$$;
-- number:weight_total_lb:processing_share:box_fee_total:freight_total:amount_total, in order.
create function pg_temp.priced(p_session uuid) returns text[] language sql as $$
  select array_agg(format('%s:%s:%s:%s:%s:%s', number, weight_total_lb, processing_share,
                          box_fee_total, freight_total, amount_total) order by app.number_order(number))
  from public.settlement where session_id = p_session;
$$;
create function pg_temp.share_sum(p_session uuid) returns numeric language sql as $$
  select sum(processing_share) from public.settlement where session_id = p_session;
$$;
grant execute on function pg_temp.as_role(text, text), pg_temp.id(text),
  pg_temp.current_payload(uuid), pg_temp.priced(uuid), pg_temp.share_sum(uuid) to authenticated;

set local role authenticated;

-- Box size catalogue (/admin/box-sizes) -------------------------------------------------------

select pg_temp.as_role('a1400000-0000-4000-8000-00000000000a', 'manager');
insert into t_ids select 'size_med', public.admin_save_box_size('wp14-size-1', null, 'Medium', 50, 12.50,
  '{"length_in": 20, "width_in": 13, "height_in": 10}', true) ->> 'box_size_id';
insert into t_ids select 'size_large', public.admin_save_box_size('wp14-size-2', null, 'Large', 90, 15.00,
  '{}', true) ->> 'box_size_id';
insert into t_ids select 'size_old', public.admin_save_box_size('wp14-size-3', null, 'Old cooler', 40, 5.00,
  '{}', false) ->> 'box_size_id';
select is((select format('%s:%s:%s:%s', name, max_lb, fee, dims ->> 'length_in') from public.box_size
           where id = pg_temp.id('size_med')), 'Medium:50.00:12.50:20',
  'BOXSIZE — manager adds a catalogue size (name, max lb, fee, dims)');
select is(public.admin_save_box_size('wp14-size-1', null, 'Medium', 50, 12.50, '{}', true) ->> 'box_size_id',
  (select v from t_ids where k = 'size_med'), 'BOXSIZE — a replayed save returns the stored result');
select throws_like($$select public.admin_save_box_size('wp14-size-4', null, 'Medium', 50, 1, '{}', true)$$,
  '%already exists%', 'BOXSIZE — names are unique per org');
select throws_like($$select public.admin_save_box_size('wp14-size-5', null, 'Tiny', 0, 1, '{}', true)$$,
  '%max lb%', 'BOXSIZE — max lb must be positive');
select throws_like($$select public.admin_save_box_size('wp14-size-6', null, 'Odd', 10, 1, '{"depth": 3}', true)$$,
  '%dims%', 'BOXSIZE — dims are length/width/height only');
select lives_ok($$select public.admin_save_box_size('wp14-size-7', pg_temp.id('size_med'), 'Medium', 50, 12.50,
  '{"length_in": 20, "width_in": 13, "height_in": 10}', true)$$, 'BOXSIZE — edit keeps the same row');
select pg_temp.as_role('a1400000-0000-4000-8000-00000000000a', 'staff');
select throws_ok($$select public.admin_save_box_size('wp14-size-8', null, 'Staff box', 10, 1, '{}', true)$$,
  '42501', null, 'BOXSIZE — staff cannot edit the catalogue');

-- Session create: two intakes (m2m), three anglers, box plans ----------------------------------

create function pg_temp.new_session() returns jsonb language sql as $$
  select jsonb_build_object(
    'party_customer_id', null, 'split_method', 'weight', 'notes', 'two boats',
    'intake_ids', jsonb_build_array('a1400000-0000-4000-8000-000000000011', 'a1400000-0000-4000-8000-000000000012'),
    'settlements', jsonb_build_array(
      jsonb_build_object('angler_name', 'Ann', 'species', jsonb_build_array(
          jsonb_build_object('species_code', 'salmon_silvers', 'method_code', 'fillets', 'lb', 10)),
        'boxes', jsonb_build_array(
          jsonb_build_object('method', 'ship', 'box_size_id', pg_temp.id('size_med'), 'weight_lb', 45, 'heavy_allowed', false),
          jsonb_build_object('method', 'willcall', 'box_size_id', pg_temp.id('size_large'), 'weight_lb', 75, 'heavy_allowed', true))),
      jsonb_build_object('angler_name', 'Bo', 'customer_id', 'a1400000-0000-4000-8000-0000000002a2',
        'species', jsonb_build_array(
          jsonb_build_object('species_code', 'whitefish_halibut', 'method_code', 'portions', 'lb', 20)),
        'boxes', '[]'::jsonb),
      jsonb_build_object('angler_name', 'Cy', 'retail_note', 'jerky x2', 'species', jsonb_build_array(
          jsonb_build_object('species_code', 'salmon_silvers', 'method_code', 'fillets', 'lb', 18),
          jsonb_build_object('species_code', 'whitefish_halibut', 'method_code', 'portions', 'lb', 12)),
        'boxes', jsonb_build_array(
          jsonb_build_object('method', 'air', 'box_size_id', pg_temp.id('size_med'), 'weight_lb', 30, 'heavy_allowed', false)))));
$$;
grant execute on function pg_temp.new_session() to authenticated;

insert into t_ids select 's1', public.save_allocation_session('wp14-save-0001', pg_temp.new_session()) ->> 'session_id';

select is((select format('%s:%s:%s:%s', number, state, split_method, party_customer_id)
           from public.allocation_session where id = pg_temp.id('s1')),
  'ALC-0001:draft:weight:a1400000-0000-4000-8000-0000000002a1',
  'SESSION — created as a draft ALC-; party falls back to the first intake''s customer (D4)');
select is((select array_agg(i.number order by i.number) from public.allocation_intake ai
           join public.intake i on i.id = ai.intake_id where ai.session_id = pg_temp.id('s1')),
  array['INT-0001', 'INT-0002'], 'SESSION — pools both intakes (m2m)');
select is((select array_agg(format('%s:%s:%s', number, angler_name, coalesce(retail_note, '-'))
                            order by app.number_order(number))
           from public.settlement where session_id = pg_temp.id('s1')),
  array['STL-0001:Ann:-', 'STL-0002:Bo:-', 'STL-0003:Cy:jerky x2'],
  'SESSION — one STL- settlement per angler, retail note kept');
select is((select array_agg(format('%s:%s:%s', ss.species_code, ss.method_code, ss.lb) order by ss.species_code)
           from public.settlement_species ss join public.settlement st on st.id = ss.settlement_id
           where st.number = 'STL-0003'),
  array['salmon_silvers:fillets:18.00', 'whitefish_halibut:portions:12.00'],
  'SESSION — per-angler species lb');
select is((select array_agg(format('%s:%s:%s:%s:%s:%s', b.number, st.angler_name, b.method, bs.name, b.weight_lb,
                                   b.fulfillment_state) order by app.number_order(b.number))
           from public.box_plan b join public.settlement st on st.id = b.settlement_id
           join public.box_size bs on bs.id = b.box_size_id where b.session_id = pg_temp.id('s1')),
  array['BOX-0001:Ann:ship:Medium:45.00:planned', 'BOX-0002:Ann:willcall:Large:75.00:planned',
        'BOX-0003:Cy:air:Medium:30.00:planned'],
  'SESSION — box plans with method, catalogue size, weight; planned');
select is((public.save_allocation_session('wp14-save-0001', pg_temp.new_session()) ->> 'session_id')::uuid,
  pg_temp.id('s1'), 'REPLAY — the same client_action_id returns the stored session');
select is((select count(*)::int from public.allocation_session), 1, 'REPLAY — no second session written');

-- Box plan rules -----------------------------------------------------------------------------

select throws_like($$select public.save_allocation_session('wp14-heavy',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{settlements,0,boxes,1,heavy_allowed}', 'false'))$$,
  '%over 70 lb%', 'HEAVY — a 75 lb box without the heavy check is refused');
select throws_like($$select public.save_allocation_session('wp14-nosize',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{settlements,1,boxes}',
      '[{"method":"ship","box_size_id":null,"weight_lb":10,"heavy_allowed":false}]'))$$,
  '%box size from the catalogue%', 'BOX — a box needs a catalogue size');
select throws_like($$select public.save_allocation_session('wp14-archived',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{settlements,1,boxes}',
      jsonb_build_array(jsonb_build_object('method', 'ship', 'box_size_id', pg_temp.id('size_old'),
                                           'weight_lb', 10, 'heavy_allowed', false))))$$,
  '%archived%', 'BOX — an archived size cannot be planned');
select throws_like($$select public.save_allocation_session('wp14-method',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{settlements,1,boxes}',
      jsonb_build_array(jsonb_build_object('method', 'truck', 'box_size_id', pg_temp.id('size_med'),
                                           'weight_lb', 10, 'heavy_allowed', false))))$$,
  '%air, ship or willcall%', 'BOX — method is air / ship / willcall');
select is((select count(*)::int from pg_constraint
           where contype = 'f'
             and ((conrelid = 'public.box_plan'::regclass and confrelid = 'public.vessel'::regclass)
               or (conrelid = 'public.vessel'::regclass and confrelid = 'public.box_plan'::regclass))),
  0, 'FOUNDING — box plan has no vessel FK (either direction)');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'public' and table_name = 'box_plan' and column_name like '%vessel%'),
  0, 'FOUNDING — box_plan has no vessel column');
select throws_like($$select public.save_allocation_session('wp14-draft-intake',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{intake_ids}',
      '["a1400000-0000-4000-8000-000000000011", "a1400000-0000-4000-8000-000000000014"]'))$$,
  '%cannot pool INT-0004 (draft)%', 'SESSION — an unsaved draft intake cannot be pooled');
select throws_like($$select public.save_allocation_session('wp14-no-intake',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{intake_ids}', '[]'))$$,
  '%at least one intake%', 'SESSION — a session pools at least one intake');

-- Price: weight vs even split sums exactly to the pooled charges -------------------------------

select throws_like($$select public.print_settlement_receipt('wp14-early-receipt',
    (select id from public.settlement where number = 'STL-0001'))$$,
  '%price ALC-0001 before printing%', 'RECEIPT — a draft session''s receipt does not print');

select is(public.price_session('wp14-price-0001', pg_temp.id('s1')) -> 'pool' ->> 'total', '100.01',
  'PRICE — pool = the intakes'' open processing + ribbing charges (voided, comped, storage excluded)');
select is((select state::text from public.allocation_session where id = pg_temp.id('s1')), 'priced',
  'PRICE — draft → priced');
-- exact: 100.01 × 10/60 = 16.668…, × 20/60 = 33.336…, × 30/60 = 50.005 → floors 16.66 / 33.33 /
-- 50.00 (99.99); two leftover cents to the largest remainders (Ann .83, Bo .67).
select is(pg_temp.priced(pg_temp.id('s1')), array[
  'STL-0001:10.00:16.67:27.50:0.00:44.17',
  'STL-0002:20.00:33.34:0.00:0.00:33.34',
  'STL-0003:30.00:50.00:12.50:0.00:62.50'],
  'PRICE — weight split ∝ take-home lb; box fees from the catalogue; freight placeholder 0');
select is(pg_temp.share_sum(pg_temp.id('s1')), 100.01::numeric,
  'SPLIT — weight split sums exactly to the pooled charges');

insert into t_ids select 'even', public.save_allocation_session('wp14-even',
  jsonb_set(pg_temp.current_payload(pg_temp.id('s1')), '{split_method}', '"even"'))::text;
select is(pg_temp.priced(pg_temp.id('s1')), array[
  'STL-0001:10.00:33.34:27.50:0.00:60.84',
  'STL-0002:20.00:33.34:0.00:0.00:33.34',
  'STL-0003:30.00:33.33:12.50:0.00:45.83'],
  'PRICE — editing a priced session reprices it at once (even split, pennies to the first anglers)');
select is(pg_temp.share_sum(pg_temp.id('s1')), 100.01::numeric,
  'SPLIT — even split sums exactly to the pooled charges');
select is(app.split_amount(0.05, '{1,1,1}'), '{0.02,0.02,0.01}'::numeric[],
  'SPLIT — penny rule: leftover cents go one each to the earliest of equal remainders');

-- Receipt with boxing QR ------------------------------------------------------------------------

insert into t_ids select 'rcpt', public.print_settlement_receipt('wp14-receipt-0001',
  (select id from public.settlement where number = 'STL-0001'))::text;
select is((select format('%s:%s:%s', j.kind, j.payload_type, j.source ->> 'template') from public.print_job j
           where j.id = ((select v from t_ids where k = 'rcpt')::jsonb ->> 'print_job_id')::uuid),
  'receipt:pdf_url:settlement_receipt', 'RECEIPT — queues a receipt print job on the counter printer');
select is((select j.source ->> 'qr' from public.print_job j
           where j.id = ((select v from t_ids where k = 'rcpt')::jsonb ->> 'print_job_id')::uuid),
  (select 'FL:BOX:' || boxing_token from public.settlement where number = 'STL-0001'),
  'RECEIPT — the job carries the angler''s boxing QR (FL:BOX:<token>)');
select is((select r ->> 'qr' from (select public.settlement_receipt(id) r from public.settlement
                                   where number = 'STL-0001') x),
  (select 'FL:BOX:' || boxing_token from public.settlement where number = 'STL-0001'),
  'RECEIPT — settlement_receipt carries the same QR for the browser print');
select is((select format('%s|%s|%s|%s|%s', r ->> 'amount_total', r ->> 'processing_share', r ->> 'box_fee_total',
                         jsonb_array_length(r -> 'boxes'), r -> 'boxes' -> 1 ->> 'heavy')
           from (select public.settlement_receipt(id) r from public.settlement where number = 'STL-0001') x),
  '60.84|33.34|27.50|2|true', 'RECEIPT — totals and box list (heavy flagged)');
reset role;
update public.printer set is_default_for = '{}' where id = 'a1400000-0000-4000-8000-0000000003a2';
set local role authenticated;
select is(public.print_settlement_receipt('wp14-receipt-0002',
  (select id from public.settlement where number = 'STL-0002')) ->> 'printer_missing', 'true',
  'RECEIPT — no receipt printer → nothing queued, printer_missing');

-- An intake pooled in two sessions -----------------------------------------------------------------

insert into t_ids select 's2', public.save_allocation_session('wp14-save-0002', jsonb_build_object(
  'party_customer_id', 'a1400000-0000-4000-8000-0000000002a2', 'split_method', 'weight',
  'intake_ids', jsonb_build_array('a1400000-0000-4000-8000-000000000013', 'a1400000-0000-4000-8000-000000000011'),
  'settlements', jsonb_build_array(
    jsonb_build_object('angler_name', 'Dee', 'species', jsonb_build_array(
      jsonb_build_object('species_code', 'salmon_silvers', 'method_code', 'fillets', 'lb', 0)),
      'boxes', jsonb_build_array(
        jsonb_build_object('method', 'willcall', 'box_size_id', pg_temp.id('size_med'), 'weight_lb', 20, 'heavy_allowed', false),
        jsonb_build_object('method', 'willcall', 'box_size_id', pg_temp.id('size_med'), 'weight_lb', 22, 'heavy_allowed', false))),
    jsonb_build_object('angler_name', 'Eli', 'species', jsonb_build_array(
      jsonb_build_object('species_code', 'salmon_silvers', 'method_code', 'fillets', 'lb', 0)),
      'boxes', '[]'::jsonb)))) ->> 'session_id';
select is((select count(*)::int from public.allocation_intake where intake_id = 'a1400000-0000-4000-8000-000000000011'),
  2, 'SHARED — an intake pooled in two sessions is allowed');
select throws_like($$select public.price_session('wp14-price-zero', pg_temp.id('s2'))$$,
  '%take-home lb%', 'SPLIT — a weight split with no take-home lb is refused (enter lb or split evenly)');
insert into t_ids select 's2_even', public.save_allocation_session('wp14-s2-even',
  jsonb_set(pg_temp.current_payload(pg_temp.id('s2')), '{split_method}', '"even"'))::text;
insert into t_ids select 's2_priced', public.price_session('wp14-price-0002', pg_temp.id('s2'))::text;
select is((select format('%s|%s|%s', p -> 'pool' ->> 'total',
                         (select string_agg(format('%s:%s:%s', x ->> 'number', x ->> 'billed_here', x ->> 'billed_by'), ',')
                          from jsonb_array_elements(p -> 'pool' -> 'intakes') x), pg_temp.share_sum(pg_temp.id('s2')))
           from (select v::jsonb from t_ids where k = 's2_priced') y (p)),
  '20.00|INT-0001:false:ALC-0001,INT-0003:true:ALC-0002|20.00',
  'SHARED — a shared intake''s charges are billed once, by the earliest session (never split twice)');
select is(pg_temp.share_sum(pg_temp.id('s1')), 100.01::numeric,
  'SHARED — the first session still bills INT-0001 in full');

select is(public.cancel_allocation_session('wp14-cancel-0001', pg_temp.id('s1'), 'party re-split') ->> 'state',
  'cancelled', 'CANCEL — an unpaid, unreleased session can be cancelled');
reset role; -- app.session_pool is internal (not granted to clients)
select is((select format('%s|%s', (app.session_pool(pg_temp.id('s2')) ->> 'total'), pg_temp.share_sum(pg_temp.id('s2')))),
  '80.00|80.00', 'SHARED — cancelling the billing session hands INT-0001 to the other session, repriced at once');
set local role authenticated;
select throws_like($$select public.save_allocation_session('wp14-edit-cancelled', pg_temp.current_payload(pg_temp.id('s1')))$$,
  '%is cancelled%', 'CANCEL — a cancelled session cannot be edited');

-- Fulfillment rollup + session list ------------------------------------------------------------------

select is((select fulfillment_status::text from public.allocation_session_list where session_id = pg_temp.id('s2')),
  'pending', 'ROLLUP — all boxes planned → pending');
reset role;
update public.box_plan set fulfillment_state = 'picked_up' where number = 'BOX-0004';
set local role authenticated;
select is((select format('%s:%s:%s', fulfillment_status, box_count, planned_count)
           from public.allocation_session_list where session_id = pg_temp.id('s2')),
  'partial:2:1', 'ROLLUP — some boxes released → partial');

select throws_like($$select public.save_allocation_session('wp14-edit-released',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s2')), '{settlements,0,boxes,0,weight_lb}', '25'))$$,
  '%BOX-0004 is already picked_up%', 'RELEASED — a released box cannot change');
select throws_like($$select public.save_allocation_session('wp14-drop-released',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s2')), '{settlements,0,boxes}',
      (pg_temp.current_payload(pg_temp.id('s2')) #> '{settlements,0,boxes}') - 0))$$,
  '%BOX-0004 already released%', 'RELEASED — a released box cannot be removed');
select throws_like($$select public.cancel_allocation_session('wp14-cancel-released', pg_temp.id('s2'), null)$$,
  '%already released%', 'RELEASED — a session with a released box cannot be cancelled');
select lives_ok($$select public.save_allocation_session('wp14-edit-other',
    jsonb_set(pg_temp.current_payload(pg_temp.id('s2')), '{settlements,0,boxes,1,weight_lb}', '24'))$$,
  'RELEASED — the session''s planned boxes stay editable');

reset role;
update public.box_plan set fulfillment_state = 'picked_up' where number = 'BOX-0005';
set local role authenticated;
select is((select fulfillment_status::text from public.allocation_session_list where session_id = pg_temp.id('s2')),
  'released', 'ROLLUP — no planned boxes left → released');
select is((select fulfillment_status::text from public.allocation_session_fulfillment
           where session_id = (select id from public.allocation_session where number = 'ALC-0001')),
  'pending', 'ROLLUP — the view reads box states only');

select is((select array_agg(number order by number) from public.allocation_session_list
           where search_text like '%' || lower('Dee') || '%'), array['ALC-0002'],
  'LIST — search matches angler names');
select is((select array_agg(number order by number) from public.allocation_session_list
           where search_text like '%int-0001%'), array['ALC-0001', 'ALC-0002'],
  'LIST — search matches pooled intake numbers');
select is((select format('%s|%s|%s|%s|%s', state, party_name, settlement_count, amount_total, array_to_string(intake_numbers, ','))
           from public.allocation_session_list where number = 'ALC-0002'),
  'priced|Sam Second|2|105.00|INT-0001,INT-0003', 'LIST — state, party, anglers, total, intakes');

-- Paid settlement freezes the session ------------------------------------------------------------------

reset role;
insert into public.payment (id, org_id, number, provider, amount, state)
values ('a1400000-0000-4000-8000-0000000009a1', 'a1400000-0000-4000-8000-00000000000a', 'PAY-0001', 'manual', 52.50, 'approved');
update public.settlement set state = 'paid', paid_payment_id = 'a1400000-0000-4000-8000-0000000009a1'
where session_id = (select id from public.allocation_session where number = 'ALC-0002') and angler_name = 'Eli';
set local role authenticated;
select throws_like($$select public.price_session('wp14-price-paid', pg_temp.id('s2'))$$,
  '%paid settlement%', 'PAID — a session with a paid settlement is not repriced');
select throws_like($$select public.save_allocation_session('wp14-edit-paid', pg_temp.current_payload(pg_temp.id('s2')))$$,
  '%paid settlement%', 'PAID — nor edited');

-- Tenancy ------------------------------------------------------------------------------------------

select pg_temp.as_role('b1400000-0000-4000-8000-00000000000b', 'staff');
select is((select count(*)::int from public.allocation_session_list), 0, 'TENANCY — another org sees no sessions');
select is((select count(*)::int from public.box_plan), 0, 'TENANCY — nor box plans');
select throws_like($$select public.save_allocation_session('wp14-b-steal', jsonb_build_object(
    'intake_ids', jsonb_build_array('a1400000-0000-4000-8000-000000000013'), 'settlements', '[]'::jsonb))$$,
  '%intake not found%', 'TENANCY — another org''s intake cannot be pooled');
select throws_like($$select public.price_session('wp14-b-price', (select v::uuid from t_ids where k = 's2'))$$,
  '%not found%', 'TENANCY — another org''s session cannot be priced');
select throws_like($$select public.settlement_receipt((select id from public.settlement limit 1))$$,
  '%not found%', 'TENANCY — nor its receipt read');

select * from finish();
rollback;
