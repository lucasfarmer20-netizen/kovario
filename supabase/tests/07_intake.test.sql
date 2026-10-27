-- WP-07 sport intake: save_intake (number, rate card + lodge snapshot, lines, charges from the
-- rules engine's drafts priced by app.price_per_lb, tote tags, lock, holding, print jobs),
-- Fast Pass floor and lodge cap, read-only until a manager unlocks, unlock/re-save
-- idempotency (only open charges re-created), and the lodge-flip reprice event.
-- TS ↔ SQL round trip and the price parity grid: packages/db/src/intake.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a7000000-0000-4000-8000-00000000000a', 'intake-a', 'Intake A', 'America/Anchorage'),
  ('b7000000-0000-4000-8000-00000000000b', 'intake-b', 'Intake B', 'UTC');

insert into public.site (id, org_id, name, is_default) values
  ('a7000000-0000-4000-8000-0000000000a5', 'a7000000-0000-4000-8000-00000000000a', 'Dock', true);

insert into public.species (org_id, code, name, "group", skin_off_allowed) values
  ('a7000000-0000-4000-8000-00000000000a', 'salmon_silvers', 'Silvers', 'salmon', false),
  ('a7000000-0000-4000-8000-00000000000a', 'whitefish_halibut', 'Halibut', 'whitefish', true);
insert into public.incoming_condition (org_id, code, name) values
  ('a7000000-0000-4000-8000-00000000000a', 'whole', 'Whole'),
  ('a7000000-0000-4000-8000-00000000000a', 'filleted_ribs', 'Filleted (ribs in)');
insert into public.processing_method (org_id, code, name, kind) values
  ('a7000000-0000-4000-8000-00000000000a', 'fresh', 'Fresh', 'virtual'),
  ('a7000000-0000-4000-8000-00000000000a', 'fillets', 'Fillets', 'service'),
  ('a7000000-0000-4000-8000-00000000000a', 'portions', 'Portions', 'service'),
  ('a7000000-0000-4000-8000-00000000000a', 'smoking', 'Smoking', 'service');

insert into public.rate_card (id, org_id, name, is_default) values
  ('a7000000-0000-4000-8000-0000000000c1', 'a7000000-0000-4000-8000-00000000000a', 'Standard', true);
insert into public.rate_card_line (org_id, rate_card_id, key, amount)
select 'a7000000-0000-4000-8000-00000000000a', 'a7000000-0000-4000-8000-0000000000c1', k, a
from (values ('fillets', 1.50), ('portions', 1.25), ('smoking', 2.75), ('ribbing_per_lb', 0.50),
             ('fast_pass_per_lb', 2.00)) v (k, a);

insert into public.lodge (id, org_id, name, pricing_cap) values
  ('a7000000-0000-4000-8000-0000000001a1', 'a7000000-0000-4000-8000-00000000000a', 'Kenai Lodge', 1.30);

insert into public.customer (id, org_id, name, phone, is_lodge_guest, lodge_id) values
  ('a7000000-0000-4000-8000-0000000002a1', 'a7000000-0000-4000-8000-00000000000a', 'Pat Plain',
   '+19075550001', false, null),
  ('a7000000-0000-4000-8000-0000000002a2', 'a7000000-0000-4000-8000-00000000000a', 'Lou Lodge',
   '+19075550002', true, 'a7000000-0000-4000-8000-0000000001a1'),
  ('b7000000-0000-4000-8000-0000000002b1', 'b7000000-0000-4000-8000-00000000000b', 'Other Org',
   '+19075550003', false, null);

insert into public.printer (id, org_id, name, site_id, kind, is_default_for) values
  ('a7000000-0000-4000-8000-0000000003a1', 'a7000000-0000-4000-8000-00000000000a', 'Dock ZD421',
   'a7000000-0000-4000-8000-0000000000a5', 'label_zpl', '{"tote_tag": true}'),
  ('a7000000-0000-4000-8000-0000000003a2', 'a7000000-0000-4000-8000-00000000000a', 'Desk receipt',
   'a7000000-0000-4000-8000-0000000000a5', 'receipt_pdf', '{"receipt": true}');

create temp table t_ids (k text primary key, v text) on commit drop;
grant all on t_ids to authenticated;

create function pg_temp.as_role(p_org text, p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a7000000-0000-4000-8000-0000000000f1', 'role', 'authenticated',
    'org_id', p_org, 'app_role', p_role)::text, true);
$$;

-- What packages/rules savePayload() produces for the WP-07 acceptance pair (salmon fresh
-- 60/40 + a ribbed halibut line); intake.test.ts pins the TS side of this shape.
create function pg_temp.payload(
  p_customer text, p_fast_pass boolean, p_intake text default null, p_totes int default 2,
  p_receipt boolean default false
) returns jsonb language sql as $$
  select jsonb_build_object(
    'intake_id', p_intake, 'customer_id', p_customer, 'site_id', null, 'tote_count', p_totes,
    'dirty_fish', false, 'dirty_notes', null, 'cut_notes', null, 'processing_notes', 'thin',
    'fast_pass', p_fast_pass, 'print_receipt', p_receipt,
    'lines', '[
      {"species_code":"salmon_silvers","condition_code":"whole","method_code":"fresh","lb":50,
       "fillets_pct":60,"skin_off":false,"yield_factor":0.56,"notes":null},
      {"species_code":"whitefish_halibut","condition_code":"filleted_ribs","method_code":"portions",
       "lb":30,"fillets_pct":null,"skin_off":false,"yield_factor":0.95,"notes":"big one"}]'::jsonb,
    'charges', '[
      {"kind":"processing","line_index":0,"rate_key":"fillets","qty":30,"description":"Silvers Whole — Fillets"},
      {"kind":"processing","line_index":0,"rate_key":"portions","qty":20,"description":"Silvers Whole — Portions"},
      {"kind":"processing","line_index":1,"rate_key":"portions","qty":30,"description":"Halibut Filleted (ribs in) — Portions"},
      {"kind":"ribbing","line_index":1,"rate_key":"ribbing_per_lb","qty":30,"description":"Ribbing — Halibut"}]'::jsonb);
$$;

-- Live (non-voided) charges of an intake as kind:rate_key:qty@unit_price=amount, in order.
create function pg_temp.charges(p_intake text) returns text[] language sql as $$
  select coalesce(array_agg(format('%s:%s:%s@%s=%s:%s', kind, rate_key, qty, unit_price, amount, state)
                            order by number), '{}')
  from public.charge where source_type = 'intake' and source_id = p_intake::uuid and state <> 'voided';
$$;

create function pg_temp.save(p_id text, p_payload jsonb) returns jsonb language sql as $$
  select public.save_intake(p_id, p_payload);
$$;
grant execute on function pg_temp.as_role(text, text), pg_temp.payload(text, boolean, text, int, boolean),
  pg_temp.charges(text), pg_temp.save(text, jsonb) to authenticated;

select pg_temp.as_role('a7000000-0000-4000-8000-00000000000a', 'staff');
set local role authenticated;

-- Save: salmon fresh 60/40 + ribbed halibut ------------------------------------------------

insert into t_ids values ('r1', pg_temp.save('wp07-save-0001',
  pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false, p_receipt => true))::text);
insert into t_ids select 'i1', (v::jsonb) ->> 'intake_id' from t_ids where k = 'r1';

select is((select (v::jsonb) ->> 'number' from t_ids where k = 'r1'), 'INT-0001',
  'save assigns the org''s first INT- number');
select is(
  (select row(i.state::text, i.locked, i.rate_card_id::text, i.is_lodge_guest, i.tote_count,
              i.total_incoming_lb, i.total_est_yield_lb, i.ribbing, i.site_id::text, i.processing_notes)::text
   from public.intake i where i.id = (select v::uuid from t_ids where k = 'i1')),
  row('holding', true, 'a7000000-0000-4000-8000-0000000000c1', false, 2, 80.00, 56.50, true,
      'a7000000-0000-4000-8000-0000000000a5', 'thin')::text,
  'saved intake: holding, locked, rate card + lodge flag snapshotted, totals from lines, default site');
select is(
  (select array_agg(format('%s:%s:%s:%s:%s', sort, method_code, lb, yield_factor, est_yield_lb) order by sort)
   from public.intake_line where intake_id = (select v::uuid from t_ids where k = 'i1')),
  array['0:fresh:50.00:0.56:28.00', '1:portions:30.00:0.95:28.50'],
  'lines carry the rules engine''s yield snapshot');
select is(pg_temp.charges((select v from t_ids where k = 'i1')), array[
  'processing:fillets:30.00@1.50=45.00:open',
  'processing:portions:20.00@1.25=25.00:open',
  'processing:portions:30.00@1.25=37.50:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'fresh 60/40 → fillets + portions charges; ribbed halibut → portions + one ribbing charge');
select is(
  (select count(*)::int from public.charge
   where source_id = (select v::uuid from t_ids where k = 'i1')
     and customer_id = 'a7000000-0000-4000-8000-0000000002a1' and number ~ '^CHG-\d{4}$'
     and intake_line_id is not null),
  4, 'charges are numbered CHG-, owed by the customer, linked to their line');
select is(
  (select array_agg(format('%s/%s %s', tote_no, of_count, qr) order by tote_no) from public.tote_tag
   where intake_id = (select v::uuid from t_ids where k = 'i1')),
  array['1/2 FL:TOTE:INT-0001:1', '2/2 FL:TOTE:INT-0001:2'],
  'one tote tag per tote, QR text from app.qr_tote');
select is(
  (select count(*)::int from public.print_job j join public.tote_tag t on t.print_job_id = j.id
   where t.intake_id = (select v::uuid from t_ids where k = 'i1')
     and j.kind = 'tote_tag' and j.state = 'queued' and j.printer_id = 'a7000000-0000-4000-8000-0000000003a1'),
  2, 'a queued tote_tag print job per tote on the site''s tote printer');
select is(
  (select j.printer_id::text from public.print_job j
   where j.id = (select ((v::jsonb) ->> 'receipt_job_id')::uuid from t_ids where k = 'r1') and j.kind = 'receipt'),
  'a7000000-0000-4000-8000-0000000003a2', 'print_receipt queues a receipt job on the receipt printer');
select ok((select last_visit_at is not null from public.customer where id = 'a7000000-0000-4000-8000-0000000002a1'),
  'save stamps the customer''s last visit');

select is(pg_temp.save('wp07-save-0001', '{}'::jsonb)::text, (select v from t_ids where k = 'r1'),
  'replaying the client_action_id returns the stored result');
select is((select count(*)::int from public.intake), 1, 'a replay writes nothing');

-- Read-only until unlocked ----------------------------------------------------------------

select throws_ok(
  format('select pg_temp.save(%L, pg_temp.payload(%L, false, %L))', 'wp07-resave-locked',
    'a7000000-0000-4000-8000-0000000002a1', (select v from t_ids where k = 'i1')),
  '55000', 'intake is locked; a manager must unlock it first', 're-save of a locked intake is refused');
select throws_ok(
  format('update public.intake_line set lb = 1 where intake_id = %L', (select v from t_ids where k = 'i1')),
  '42501', null, 'clients cannot write lines directly');
reset role;
select throws_ok(
  format('update public.intake_line set lb = 1 where intake_id = %L', (select v from t_ids where k = 'i1')),
  '55000', 'intake is locked; a manager must unlock it first', 'even a direct write cannot touch a locked intake''s lines');
set local role authenticated;

-- Unlock (manager) ------------------------------------------------------------------------

select throws_ok(
  format('select public.unlock_intake(%L, %L)', 'wp07-unlock-staff', (select v from t_ids where k = 'i1')),
  '42501', null, 'staff cannot unlock without a manager');
select throws_ok(
  format('select public.unlock_intake(%L, %L, %L, %L)', 'wp07-unlock-bad', (select v from t_ids where k = 'i1'),
    'mis-weighed', 'not-a-token'),
  '42501', 'manager approval required', 'a station needs a live manager elevation (manager PIN)');

select pg_temp.as_role('a7000000-0000-4000-8000-00000000000a', 'manager');
select is((public.unlock_intake('wp07-unlock-0001', (select v::uuid from t_ids where k = 'i1'), ' mis-weighed ')) ->> 'locked',
  'false', 'a manager unlocks');
select is(
  (select input ->> 'reason' from public.action_log where client_action_id = 'wp07-unlock-0001' and action = 'intake.unlock'),
  'mis-weighed', 'unlock writes action_log with the reason');
select pg_temp.as_role('a7000000-0000-4000-8000-00000000000a', 'staff');

-- Re-save idempotency ---------------------------------------------------------------------

insert into t_ids values ('before', pg_temp.charges((select v from t_ids where k = 'i1'))::text);
insert into t_ids values ('r2', pg_temp.save('wp07-resave-0001',
  pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false, (select v from t_ids where k = 'i1')))::text);
select is(
  (select format('%s/%s/%s', (v::jsonb) ->> 'charges_created', (v::jsonb) ->> 'charges_voided',
                 (v::jsonb) ->> 'charges_kept') from t_ids where k = 'r2'),
  '4/4/0', 're-save voids the open charges and re-creates them');
select is(pg_temp.charges((select v from t_ids where k = 'i1'))::text, (select v from t_ids where k = 'before'),
  're-saving the same lines yields the same live charges');
select is((select locked from public.intake where id = (select v::uuid from t_ids where k = 'i1')), true,
  're-save locks the intake again');
select is((select count(*)::int from public.intake_line where intake_id = (select v::uuid from t_ids where k = 'i1')), 2,
  're-save replaces the lines');
select is(pg_temp.save('wp07-resave-0001', '{}'::jsonb)::text, (select v from t_ids where k = 'r2'),
  'a replayed re-save is a no-op');
select is((select count(*)::int from public.charge where source_id = (select v::uuid from t_ids where k = 'i1')), 8,
  'the replay created no charges');

-- Only open charges are re-created: a comped charge is kept, its draft not duplicated.
reset role;
update public.charge set state = 'comped', comp_reason = 'regular'
where source_id = (select v::uuid from t_ids where k = 'i1') and state = 'open' and rate_key = 'fillets';
set local role authenticated;
select pg_temp.as_role('a7000000-0000-4000-8000-00000000000a', 'manager');
select public.unlock_intake('wp07-unlock-0002', (select v::uuid from t_ids where k = 'i1'));
select pg_temp.as_role('a7000000-0000-4000-8000-00000000000a', 'staff');
insert into t_ids values ('r3', pg_temp.save('wp07-resave-0002',
  pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false, (select v from t_ids where k = 'i1'), 3))::text);
select is(
  (select format('%s/%s/%s', (v::jsonb) ->> 'charges_created', (v::jsonb) ->> 'charges_voided',
                 (v::jsonb) ->> 'charges_kept') from t_ids where k = 'r3'),
  '3/3/1', 'a settled/comped charge is kept and only open ones are re-created');
select is(pg_temp.charges((select v from t_ids where k = 'i1')), array[
  'processing:fillets:30.00@1.50=45.00:comped',
  'processing:portions:20.00@1.25=25.00:open',
  'processing:portions:30.00@1.25=37.50:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'live charges after re-save: the comped one plus re-created open ones');
select is(
  (select array_agg(format('%s/%s %s', tote_no, of_count, qr) order by tote_no) from public.tote_tag
   where intake_id = (select v::uuid from t_ids where k = 'i1')),
  array['1/3 FL:TOTE:INT-0001:1', '2/3 FL:TOTE:INT-0001:2', '3/3 FL:TOTE:INT-0001:3'],
  're-save with 3 totes: tags renumbered X of 3');

-- Fast Pass floor and lodge cap -----------------------------------------------------------

insert into t_ids select 'fp', (pg_temp.save('wp07-save-fastpass',
  pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', true))) ->> 'intake_id';
select is(pg_temp.charges((select v from t_ids where k = 'fp')), array[
  'processing:fillets:30.00@2.00=60.00:open',
  'processing:portions:20.00@2.00=40.00:open',
  'processing:portions:30.00@2.00=60.00:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'Fast Pass floors processing at fast_pass_per_lb; ribbing stays at ribbing_per_lb (DECISION-19)');

insert into t_ids select 'lodge', (pg_temp.save('wp07-save-lodge',
  pg_temp.payload('a7000000-0000-4000-8000-0000000002a2', false))) ->> 'intake_id';
select is(pg_temp.charges((select v from t_ids where k = 'lodge')), array[
  'processing:fillets:30.00@1.30=39.00:open',
  'processing:portions:20.00@1.25=25.00:open',
  'processing:portions:30.00@1.25=37.50:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'lodge guest: processing capped at the lodge cap; ribbing never capped');
select is((select is_lodge_guest from public.intake where id = (select v::uuid from t_ids where k = 'lodge')), true,
  'the lodge flag is snapshotted on the intake');

insert into t_ids select 'lodge_fp', (pg_temp.save('wp07-save-lodge-fp',
  pg_temp.payload('a7000000-0000-4000-8000-0000000002a2', true))) ->> 'intake_id';
select is(pg_temp.charges((select v from t_ids where k = 'lodge_fp')), array[
  'processing:fillets:30.00@2.00=60.00:open',
  'processing:portions:20.00@2.00=40.00:open',
  'processing:portions:30.00@2.00=60.00:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'Fast Pass floor overrides the lodge cap');

-- Lodge-flip reprice (WP-06 event) ----------------------------------------------------------

select public.set_lodge_guest('wp07-flip-0001', 'a7000000-0000-4000-8000-0000000002a1', true,
  'a7000000-0000-4000-8000-0000000001a1');
select is(pg_temp.charges((select v from t_ids where k = 'i1')), array[
  'processing:fillets:30.00@1.50=45.00:comped',
  'processing:portions:20.00@1.25=25.00:open',
  'processing:portions:30.00@1.25=37.50:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'flip to lodge: comped charge untouched; portions already under the cap');
select is(pg_temp.charges((select v from t_ids where k = 'fp')), array[
  'processing:fillets:30.00@2.00=60.00:open',
  'processing:portions:20.00@2.00=40.00:open',
  'processing:portions:30.00@2.00=60.00:open',
  'ribbing:ribbing_per_lb:30.00@0.50=15.00:open'],
  'Fast Pass charges are never repriced by a lodge flip');
select ok(
  (select bool_and(processed_at is not null) from public.domain_event
   where kind = 'customer_lodge_flag_changed' and subject_id = 'a7000000-0000-4000-8000-0000000002a1'),
  'the flip event is consumed in the same transaction');

-- A new open fillets charge on a non-Fast-Pass intake is capped by the flip, and uncapped by
-- the flip back.
reset role;
update public.charge set state = 'open', comp_reason = null
where source_id = (select v::uuid from t_ids where k = 'i1') and state = 'comped';
set local role authenticated;
select public.set_lodge_guest('wp07-flip-0002', 'a7000000-0000-4000-8000-0000000002a1', false);
select public.set_lodge_guest('wp07-flip-0003', 'a7000000-0000-4000-8000-0000000002a1', true,
  'a7000000-0000-4000-8000-0000000001a1');
select is((pg_temp.charges((select v from t_ids where k = 'i1')))[1], 'processing:fillets:30.00@1.30=39.00:open',
  'flip to lodge caps an open, unpaid processing charge');
select public.set_lodge_guest('wp07-flip-0004', 'a7000000-0000-4000-8000-0000000002a1', false);
select is((pg_temp.charges((select v from t_ids where k = 'i1')))[1], 'processing:fillets:30.00@1.50=45.00:open',
  'flip back reprices it to the list price');
select is((pg_temp.charges((select v from t_ids where k = 'i1')))[4], 'ribbing:ribbing_per_lb:30.00@0.50=15.00:open',
  'ribbing is never repriced');

-- Reprint / receipt -----------------------------------------------------------------------

select is((public.reprint_intake_tote_tags('wp07-reprint-0001', (select v::uuid from t_ids where k = 'fp'))) ->> 'tote_jobs_queued',
  '2', 'reprint queues a job per tote');
select is((public.print_intake_receipt('wp07-receipt-0001', (select v::uuid from t_ids where k = 'fp'))) ->> 'printer_missing',
  'false', 'print receipt queues a receipt job');
reset role;
update public.printer set is_default_for = '{}' where org_id = 'a7000000-0000-4000-8000-00000000000a';
set local role authenticated;
select is((public.reprint_intake_tote_tags('wp07-reprint-0002', (select v::uuid from t_ids where k = 'fp'))) ->> 'printer_missing',
  'true', 'with no printer routed to the site, reprint reports it instead of failing');

-- A number taken outside next_seq (seed fixture, import) is skipped, not a failed save.
reset role;
insert into public.intake (org_id, number, customer_id, state)
values ('a7000000-0000-4000-8000-00000000000a', 'INT-0005', 'a7000000-0000-4000-8000-0000000002a1', 'holding');
set local role authenticated;
select is((pg_temp.save('wp07-save-skip', pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false))) ->> 'number',
  'INT-0006', 'save skips an intake number already taken outside next_seq');

-- Validation ------------------------------------------------------------------------------

select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0001',
    jsonb_set(pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false), '{charges}',
      (pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false) -> 'charges') - 3)),
  '22023', 'charge drafts do not match the intake lines', 'a filleted_ribs line without its ribbing draft is refused');
select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0002',
    jsonb_set(pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false), '{charges,0,qty}', '25')),
  '22023', 'charge drafts do not match the intake lines', 'processing qty must add up to the line''s lb');
select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0003',
    jsonb_set(pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false), '{charges,2,rate_key}', '"smoking"')),
  '22023', 'charge drafts do not match the intake lines', 'a draft priced under another method is refused');
select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0004',
    jsonb_set(pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false), '{lines}', '[]')),
  '22023', 'an intake needs at least one line', 'an intake without lines is refused');
select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0005',
    pg_temp.payload('a7000000-0000-4000-8000-0000000002a1', false, p_totes => 0)),
  '22023', 'tote count must be at least 1', 'zero totes is refused');
select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0006',
    pg_temp.payload('b7000000-0000-4000-8000-0000000002b1', false)),
  'P0002', 'customer not found', 'another org''s customer is not found');
select is((select count(*)::int from public.intake), 6, 'refused saves wrote nothing');

-- Unlock is only for intakes still in the cooler.
reset role;
update public.intake set state = 'processing' where id = (select v::uuid from t_ids where k = 'lodge');
set local role authenticated;
select pg_temp.as_role('a7000000-0000-4000-8000-00000000000a', 'manager');
select throws_ok(
  format('select public.unlock_intake(%L, %L)', 'wp07-unlock-late', (select v from t_ids where k = 'lodge')),
  '55000', 'only an intake still in the cooler can be unlocked', 'a processing intake cannot be unlocked');

-- No rate card (org B has none) → nothing priced, nothing saved.
select pg_temp.as_role('b7000000-0000-4000-8000-00000000000b', 'staff');
select throws_ok(
  format('select pg_temp.save(%L, %L::jsonb)', 'wp07-bad-0007',
    pg_temp.payload('b7000000-0000-4000-8000-0000000002b1', false)),
  'P0002', 'no active rate card; set one up in Admin → Rate cards', 'saving without a rate card is refused');

-- Generated rules ---------------------------------------------------------------------------

select is(app.qr_tote('INT-0042', 3), 'FL:TOTE:INT-0042:3', 'app.qr_tote matches qr.ts encode');
select throws_ok($$select app.qr_tote('42', 1)$$, '22023', null, 'app.qr_tote rejects a malformed number');

select * from finish();
rollback;
