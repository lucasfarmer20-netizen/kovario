-- WP-06 customers: phone-first search (partial and formatted input, never raises, org
-- scoped), inline create, the lodge-guest flip and its domain_event (docs/04 §2 reprice
-- hook), lodges and customer admin including merge-duplicates by phone.
-- Search latency on 50k customers: packages/db/src/customer-search.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a6000000-0000-4000-8000-00000000000a', 'cust-a', 'Cust A', 'UTC'),
  ('b6000000-0000-4000-8000-00000000000b', 'cust-b', 'Cust B', 'UTC');

insert into public.lodge (id, org_id, name, pricing_cap) values
  ('a6000000-0000-4000-8000-0000000001a1', 'a6000000-0000-4000-8000-00000000000a', 'Kenai Lodge', 2.00),
  ('a6000000-0000-4000-8000-0000000001a2', 'a6000000-0000-4000-8000-00000000000a', 'River Lodge', 1.75),
  ('b6000000-0000-4000-8000-0000000001b1', 'b6000000-0000-4000-8000-00000000000b', 'Other Lodge', 1.00);

insert into public.customer (id, org_id, name, phone, email, last_visit_at, is_lodge_guest, lodge_id) values
  ('a6000000-0000-4000-8000-0000000002a1', 'a6000000-0000-4000-8000-00000000000a', 'Alice Angler',
   '+19075551234', null, '2026-07-10', false, null),
  ('a6000000-0000-4000-8000-0000000002a2', 'a6000000-0000-4000-8000-00000000000a', 'Carol Angler',
   '+19075551234', 'carol@example.test', '2026-07-01', false, null),
  ('a6000000-0000-4000-8000-0000000002a3', 'a6000000-0000-4000-8000-00000000000a', 'Bob Boat',
   '+19075559999', null, '2026-07-20', true, 'a6000000-0000-4000-8000-0000000001a1'),
  ('a6000000-0000-4000-8000-0000000002a4', 'a6000000-0000-4000-8000-00000000000a', 'Dave Visitor',
   '+442079460958', null, null, false, null),
  ('a6000000-0000-4000-8000-0000000002a5', 'a6000000-0000-4000-8000-00000000000a', 'Erin O''Neil',
   null, null, null, false, null),
  ('a6000000-0000-4000-8000-0000000002a6', 'a6000000-0000-4000-8000-00000000000a', 'Al_x Under',
   null, null, null, false, null),
  ('a6000000-0000-4000-8000-0000000002a7', 'a6000000-0000-4000-8000-00000000000a', 'Alpx Plain',
   null, null, null, false, null),
  ('b6000000-0000-4000-8000-0000000002b1', 'b6000000-0000-4000-8000-00000000000b', 'Other Org',
   '+19075551234', null, null, false, null);

create temp table t_ids (k text primary key, v text) on commit drop;
grant all on t_ids to authenticated;

create function pg_temp.as_role(p_org text, p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a6000000-0000-4000-8000-0000000000f1', 'role', 'authenticated',
    'org_id', p_org, 'app_role', p_role)::text, true);
$$;

create function pg_temp.hits(p_q text) returns text[] language sql as $$
  select coalesce(array_agg(s.name order by s.ord), '{}')
  from public.search_customers('a6000000-0000-4000-8000-00000000000a', p_q)
    with ordinality as s (id, name, phone, last_visit_at, is_lodge_guest, lodge_id, lodge_name, ord);
$$;
grant execute on function pg_temp.hits(text), pg_temp.as_role(text, text) to authenticated;

select pg_temp.as_role('a6000000-0000-4000-8000-00000000000a', 'staff');
set local role authenticated;

-- Search: phone-first, any formatting ----------------------------------------------------

select is(pg_temp.hits('(907) 555-'), array['Bob Boat', 'Alice Angler', 'Carol Angler'],
  'formatted partial phone (907) 555- matches by digits, most recent visit first');
select is(pg_temp.hits('907555'), array['Bob Boat', 'Alice Angler', 'Carol Angler'],
  'bare partial digits 907555');
select is(pg_temp.hits('+1907'), array['Bob Boat', 'Alice Angler', 'Carol Angler'],
  'partial with country code +1907');
select is(pg_temp.hits('(907) 555-1234'), array['Alice Angler', 'Carol Angler'],
  'a full national number matches exactly');
select is(pg_temp.hits('+1 907 555 1234'), array['Alice Angler', 'Carol Angler'],
  'a full E.164 number matches exactly');
select is(pg_temp.hits('555-9999'), array['Bob Boat'], 'a middle fragment matches (contains)');
select is(pg_temp.hits('1234'), array['Alice Angler', 'Carol Angler'], 'last digits match');
select is(pg_temp.hits('20 7946'), array['Dave Visitor'], 'foreign numbers match by digits');
select is(pg_temp.hits('5551234'), array['Alice Angler', 'Carol Angler'],
  'contains matches without the area code');

-- Exact before prefix before contains, regardless of visit recency.
reset role;
insert into public.customer (org_id, name, phone, last_visit_at) values
  ('a6000000-0000-4000-8000-00000000000a', 'Zed Contains', '+19079075551', '2026-08-01');
set local role authenticated;
select is((pg_temp.hits('907555'))[1:3], array['Bob Boat', 'Alice Angler', 'Carol Angler'],
  'prefix matches rank above a more recent contains match');
select is((pg_temp.hits('907555'))[4], 'Zed Contains', 'contains matches follow');

select is(
  (select array_agg(lodge_name) from public.search_customers('a6000000-0000-4000-8000-00000000000a', '5559999')),
  array['Kenai Lodge'], 'hits carry the lodge badge');
select is(
  (select count(*)::int from public.search_customers('a6000000-0000-4000-8000-00000000000a', '907', 0)),
  1, 'limit is clamped to at least 1');
select is(
  (select count(*)::int from public.search_customers('a6000000-0000-4000-8000-00000000000a', '907', 1000)),
  4, 'limit is clamped (to 50) without raising');

-- Name fallback below 3 digits.
select is(pg_temp.hits('ali'), array['Alice Angler'], 'names match below 3 digits');
select is(pg_temp.hits('o''ne'), array['Erin O''Neil'], 'quotes in names are plain text');
select is(pg_temp.hits('al_x'), array['Al_x Under'], 'LIKE wildcards in the query are literal');
select is(pg_temp.hits('al'), '{}'::text[], 'names need 3 letters');

-- Partial input never raises and returns nothing.
select lives_ok($$ select pg_temp.hits(q) from unnest(array[
    '', ' ', '9', '90', '(9', '(', ')', '+', '-', '+1', '%', '_', '\', '%%', '*', '''',
    'a', E'\n', E'\t9', repeat('9', 500), repeat('(', 500), '1;drop table customer'
  ]) q $$, 'partial or odd input never raises');
select is(
  (select array_agg(q) from unnest(array['', ' ', '9', '90', '(9', '(', '+', '+1', '%', '_', '\', 'a', repeat('9', 500)]) q
   where cardinality(pg_temp.hits(q)) > 0),
  null, 'input below the thresholds returns no rows');
select is((select count(*)::int from public.search_customers('a6000000-0000-4000-8000-00000000000a', null)), 0,
  'null query returns no rows');

-- Org scoping: RLS wins over the org argument.
select is(
  (select count(*)::int from public.search_customers('b6000000-0000-4000-8000-00000000000b', '907')),
  0, 'a session cannot search another org by passing its id');
select ok(not ('Other Org' = any (pg_temp.hits('9075551234'))), 'other orgs'' customers never appear');

reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$ select * from public.search_customers('a6000000-0000-4000-8000-00000000000a', '907') $$,
  '42501', null, 'anon cannot search customers');
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select array_agg(name) from public.search_customers('b6000000-0000-4000-8000-00000000000b', '907')),
  array['Other Org'], 'service_role searches the org it names');

-- Inline create ---------------------------------------------------------------------------

select pg_temp.as_role('a6000000-0000-4000-8000-00000000000a', 'station');
set local role authenticated;

insert into t_ids select 'new', public.create_customer('cust-act-0001', ' Frank Fisher ', '+19075550001', '')
  ->> 'customer_id';
select is((select name || '|' || phone || '|' || coalesce(email, '-') from public.customer
           where id = (select v::uuid from t_ids where k = 'new')),
  'Frank Fisher|+19075550001|-', 'a station creates a customer inline (trimmed, empty email is null)');
select is(public.create_customer('cust-act-0001', 'Frank Fisher', '+19075550001') ->> 'customer_id',
  (select v from t_ids where k = 'new'), 'replaying a create returns the same customer');
select is((select count(*)::int from public.customer where phone = '+19075550001'), 1, 'a replay does not create twice');
select is(pg_temp.hits('5550001'), array['Frank Fisher'], 'the new customer is searchable at once');
select throws_ok($$ select public.create_customer('cust-act-0002', 'Bad Phone', '(907) 555-0002') $$,
  '23514', null, 'phones must arrive as E.164 (normalised by rules/phone.ts)');
select throws_ok($$ select public.create_customer('cust-act-0003', '  ', '+19075550003') $$,
  '23514', null, 'a name is required');

select pg_temp.as_role('a6000000-0000-4000-8000-00000000000a', 'agent');
select throws_ok($$ select public.create_customer('cust-act-0004', 'Agent', null) $$,
  '42501', null, 'a print agent cannot create customers');

-- Lodge-guest flip and the reprice hook -----------------------------------------------------

select pg_temp.as_role('a6000000-0000-4000-8000-00000000000a', 'staff');

insert into t_ids select 'flip1', public.set_lodge_guest('lodge-act-0001',
  'a6000000-0000-4000-8000-0000000002a4', true, 'a6000000-0000-4000-8000-0000000001a1') ->> 'event_id';
select is(
  (select is_lodge_guest::text || '|' || lodge_id::text from public.customer where id = 'a6000000-0000-4000-8000-0000000002a4'),
  'true|a6000000-0000-4000-8000-0000000001a1', 'set_lodge_guest flags the customer with the lodge');
select is(
  (select kind || '|' || subject_id::text || '|' || (payload ->> 'is_lodge_guest') || '|'
     || (payload ->> 'previous_is_lodge_guest') || '|' || (payload ->> 'lodge_id') || '|'
     || (processed_at is null)::text
   from public.domain_event where id = (select v::uuid from t_ids where k = 'flip1')),
  'customer_lodge_flag_changed|a6000000-0000-4000-8000-0000000002a4|true|false|a6000000-0000-4000-8000-0000000001a1|true',
  'the flip writes an unprocessed customer_lodge_flag_changed event for the reprice consumer');

select is(public.set_lodge_guest('lodge-act-0001', 'a6000000-0000-4000-8000-0000000002a4', true,
    'a6000000-0000-4000-8000-0000000001a1') ->> 'event_id',
  (select v from t_ids where k = 'flip1'), 'replaying a flip returns the stored result');
select is(public.set_lodge_guest('lodge-act-0002', 'a6000000-0000-4000-8000-0000000002a4', true) ->> 'event_id',
  null, 'setting the same status again (lodge kept) emits no event');
select is((select count(*)::int from public.domain_event where subject_id = 'a6000000-0000-4000-8000-0000000002a4'),
  1, 'one event per real change');

select isnt(public.set_lodge_guest('lodge-act-0003', 'a6000000-0000-4000-8000-0000000002a4', true,
    'a6000000-0000-4000-8000-0000000001a2') ->> 'event_id',
  null, 'moving a guest to another lodge (another cap) emits an event');
insert into t_ids select 'flip-off', public.set_lodge_guest('lodge-act-0004',
  'a6000000-0000-4000-8000-0000000002a4', false) ->> 'event_id';
select is(
  (select coalesce(c.lodge_id::text, 'none') || '|' || (e.payload ->> 'is_lodge_guest') || '|' || (e.payload ->> 'previous_lodge_id')
   from public.customer c, public.domain_event e
   where c.id = 'a6000000-0000-4000-8000-0000000002a4' and e.id = (select v::uuid from t_ids where k = 'flip-off')),
  'none|false|a6000000-0000-4000-8000-0000000001a2', 'unflagging clears the lodge and records the previous one');

select throws_ok($$ select public.set_lodge_guest('lodge-act-0005', 'a6000000-0000-4000-8000-0000000002a4', true,
    'b6000000-0000-4000-8000-0000000001b1') $$, 'P0002', null, 'another org''s lodge is not found');
select throws_ok($$ select public.set_lodge_guest('lodge-act-0006', 'b6000000-0000-4000-8000-0000000002b1', true) $$,
  'P0002', null, 'another org''s customer is not found');
select throws_ok($$ select public.set_lodge_guest('lodge-act-0007', 'a6000000-0000-4000-8000-0000000002a4', false,
    'a6000000-0000-4000-8000-0000000001a1') $$, '22023', null, 'a non-guest cannot be given a lodge');
select throws_ok($$ select public.set_lodge_guest('lodge-act-0008', 'a6000000-0000-4000-8000-0000000002a4', null) $$,
  '22004', null, 'the flag is required');
select throws_ok($$ update public.customer set is_lodge_guest = true where id = 'a6000000-0000-4000-8000-0000000002a4' $$,
  '42501', null, 'clients cannot flip the flag directly (bypassing the event)');

-- Customers admin ---------------------------------------------------------------------------

select throws_ok($$ select public.admin_update_customer('adm-act-0001', 'a6000000-0000-4000-8000-0000000002a1',
    'X', null, null, null) $$, '42501', null, 'staff cannot edit customers in admin');
select throws_ok($$ select * from public.admin_customer_duplicates() $$, '42501', null,
  'staff cannot list duplicates');

select pg_temp.as_role('a6000000-0000-4000-8000-00000000000a', 'manager');

select lives_ok($$ select public.admin_update_customer('adm-act-0002', 'a6000000-0000-4000-8000-0000000002a1',
    ' Alice A. Angler ', '+19075551234', 'alice@example.test', ' prefers fillets ') $$, 'a manager edits a customer');
select is((select name || '|' || email || '|' || notes from public.customer where id = 'a6000000-0000-4000-8000-0000000002a1'),
  'Alice A. Angler|alice@example.test|prefers fillets', 'edits are trimmed');
select throws_ok($$ select public.admin_update_customer('adm-act-0003', 'b6000000-0000-4000-8000-0000000002b1',
    'X', null, null, null) $$, 'P0002', null, 'another org''s customer cannot be edited');

select is(
  (select phone || ':' || jsonb_array_length(customers) from public.admin_customer_duplicates()),
  '+19075551234:2', 'duplicates are customers sharing a phone (in this org only)');

-- Merge: Carol (with an intake, a charge and a pending event) into Alice.
reset role;
insert into public.intake (id, org_id, number, customer_id) values
  ('a6000000-0000-4000-8000-0000000003a1', 'a6000000-0000-4000-8000-00000000000a', 'INT-0001',
   'a6000000-0000-4000-8000-0000000002a2');
insert into public.charge (id, org_id, number, customer_id, kind, source_type, source_id, qty, unit, unit_price) values
  ('a6000000-0000-4000-8000-0000000004a1', 'a6000000-0000-4000-8000-00000000000a', 'CHG-0001',
   'a6000000-0000-4000-8000-0000000002a2', 'processing', 'intake', 'a6000000-0000-4000-8000-0000000003a1', 10, 'lb', 2.00);
insert into public.domain_event (org_id, kind, subject_id) values
  ('a6000000-0000-4000-8000-00000000000a', 'customer_lodge_flag_changed', 'a6000000-0000-4000-8000-0000000002a2');
set local role authenticated;

select throws_ok($$ select public.admin_merge_customers('merge-act-0001', 'a6000000-0000-4000-8000-0000000002a1',
    'a6000000-0000-4000-8000-0000000002a1') $$, '22023', null, 'a customer cannot merge into itself');
select throws_ok($$ select public.admin_merge_customers('merge-act-0002', 'a6000000-0000-4000-8000-0000000002a1',
    'a6000000-0000-4000-8000-0000000002a3') $$, '22023', null, 'customers with different phones are not merged');
select throws_ok($$ select public.admin_merge_customers('merge-act-0003', 'a6000000-0000-4000-8000-0000000002a1',
    'b6000000-0000-4000-8000-0000000002b1') $$, 'P0002', null, 'another org''s customer cannot be merged');

reset role;
update public.customer set is_lodge_guest = true where id = 'a6000000-0000-4000-8000-0000000002a2';
set local role authenticated;
select throws_ok($$ select public.admin_merge_customers('merge-act-0004', 'a6000000-0000-4000-8000-0000000002a1',
    'a6000000-0000-4000-8000-0000000002a2') $$, '22023', null,
  'customers with different lodge status are not merged (the flip must go through set_lodge_guest)');
reset role;
update public.customer set is_lodge_guest = false where id = 'a6000000-0000-4000-8000-0000000002a2';
set local role authenticated;

select is(public.admin_merge_customers('merge-act-0005', 'a6000000-0000-4000-8000-0000000002a1',
    'a6000000-0000-4000-8000-0000000002a2') ->> 'merged_customer_id',
  'a6000000-0000-4000-8000-0000000002a2', 'a manager merges a duplicate');
select is_empty($$ select id from public.customer where id = 'a6000000-0000-4000-8000-0000000002a2' $$,
  'the merged customer is gone');
select is((select customer_id::text from public.intake where id = 'a6000000-0000-4000-8000-0000000003a1'),
  'a6000000-0000-4000-8000-0000000002a1', 'its intakes move to the kept customer');
select is((select customer_id::text from public.charge where id = 'a6000000-0000-4000-8000-0000000004a1'),
  'a6000000-0000-4000-8000-0000000002a1', 'its charges move to the kept customer');
select is((select count(*)::int from public.domain_event
           where subject_id = 'a6000000-0000-4000-8000-0000000002a1' and kind = 'customer_lodge_flag_changed'),
  1, 'its pending customer events follow the kept customer');
select is((select last_visit_at::date::text from public.customer where id = 'a6000000-0000-4000-8000-0000000002a1'),
  '2026-07-10', 'the kept customer keeps the latest visit');
select is((select count(*)::int from public.domain_event
           where kind = 'customer_merged' and subject_id = 'a6000000-0000-4000-8000-0000000002a1'
             and payload ->> 'merged_customer_id' = 'a6000000-0000-4000-8000-0000000002a2'),
  1, 'the merge is recorded as a customer_merged event');
select is(public.admin_merge_customers('merge-act-0005', 'a6000000-0000-4000-8000-0000000002a1',
    'a6000000-0000-4000-8000-0000000002a2') ->> 'customer_id',
  'a6000000-0000-4000-8000-0000000002a1', 'replaying a merge returns the stored result');
select is_empty($$ select * from public.admin_customer_duplicates() $$, 'no duplicates remain');

-- Lodges admin --------------------------------------------------------------------------------

insert into t_ids select 'lodge', public.admin_create_lodge('lodgeadm-0001', ' Bay Lodge ', 2.25,
  '{"name":"Pat","phone":"+19075550100"}') ->> 'lodge_id';
select is((select name || '|' || pricing_cap || '|' || (contact ->> 'name') from public.lodge
           where id = (select v::uuid from t_ids where k = 'lodge')),
  'Bay Lodge|2.25|Pat', 'a manager creates a lodge with a pricing cap and contact');
select throws_ok($$ select public.admin_create_lodge('lodgeadm-0002', 'Bay Lodge', 1) $$, '23505', null,
  'lodge names are unique per org');
select throws_ok($$ select public.admin_create_lodge('lodgeadm-0003', 'Neg Lodge', -1) $$, '23514', null,
  'a pricing cap cannot be negative');
select lives_ok($$ select public.admin_update_lodge('lodgeadm-0004', (select v::uuid from t_ids where k = 'lodge'),
    'Bay Lodge', null, '{}') $$, 'a manager edits a lodge (null cap = no cap)');
select is((select pricing_cap from public.lodge where id = (select v::uuid from t_ids where k = 'lodge')), null,
  'the cap can be removed');
select throws_ok($$ select public.admin_update_lodge('lodgeadm-0005', (select v::uuid from t_ids where k = 'lodge'),
    'Kenai Lodge', 1) $$, '23505', null, 'renaming onto another lodge''s name is refused');
select throws_ok($$ select public.admin_update_lodge('lodgeadm-0006', 'b6000000-0000-4000-8000-0000000001b1',
    'Mine', 1) $$, 'P0002', null, 'another org''s lodge cannot be edited');

select pg_temp.as_role('a6000000-0000-4000-8000-00000000000a', 'staff');
select throws_ok($$ select public.admin_create_lodge('lodgeadm-0007', 'Staff Lodge', 1) $$, '42501', null,
  'staff cannot create lodges');

reset role;
select * from finish();
rollback;
