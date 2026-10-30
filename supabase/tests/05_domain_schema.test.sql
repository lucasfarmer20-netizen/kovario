-- WP-03 core domain schema: RLS on every table, trigger-maintained denormals, views, the
-- state-transition guard and force_transition. Applying from empty is covered by
-- `supabase db reset` (CI) before this file runs.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Catalog ------------------------------------------------------------------------------

create temp table domain_tables (tbl text primary key) on commit drop;
insert into domain_tables values
  ('lodge'), ('customer'),
  ('species'), ('incoming_condition'), ('processing_method'), ('condition_matrix'),
  ('processing_matrix'), ('yield_factor'), ('rate_card'), ('rate_card_line'),
  ('intake'), ('intake_line'), ('charge'), ('tote_tag'),
  ('storage_intake'), ('storage_box'), ('storage_pickup_batch'),
  ('wave'), ('wave_intake'), ('wave_scan'), ('scan_log'), ('asset_tag'), ('vessel'),
  ('reconcile_line'), ('scale_reading'),
  ('location'), ('location_placement'),
  ('allocation_session'), ('allocation_intake'), ('settlement'), ('settlement_species'),
  ('box_size'), ('box_plan'), ('release_audit'), ('shipment'),
  ('payment_terminal'), ('payment'), ('payment_event'), ('register_order'), ('register_order_line'),
  ('printer'), ('print_agent'), ('print_job'), ('scale');

select is(
  (select array_agg(d.tbl order by d.tbl) from domain_tables d
   where not exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tablename = d.tbl)),
  null,
  'every domain table of docs/02-DOMAIN-MODEL.md §2–§10 exists'
);

select is(
  (select array_agg(t.tablename::text order by t.tablename) from pg_tables t
   where t.schemaname = 'public'
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename)),
  null,
  'no public table without RLS policies (pg_policies)'
);

select is(
  (select array_agg(d.tbl order by d.tbl) from domain_tables d
   where not exists (select 1 from pg_policies p
                     where p.schemaname = 'public' and p.tablename = d.tbl and p.policyname = 'org_select'
                       and p.qual like '%app.org_id()%')),
  null,
  'every domain table has the enable_org_rls org_select policy'
);

select is(
  (select array_agg(d.tbl order by d.tbl) from domain_tables d
   where not exists (select 1 from pg_trigger g
                     where g.tgrelid = ('public.' || d.tbl)::regclass and g.tgname = 'set_updated_at')),
  null,
  'every domain table maintains updated_at'
);

select is(
  (select array_agg(d.tbl order by d.tbl) from domain_tables d
   where has_table_privilege('authenticated', 'public.' || d.tbl, 'insert')
      or has_table_privilege('authenticated', 'public.' || d.tbl, 'update')
      or has_table_privilege('authenticated', 'public.' || d.tbl, 'delete')),
  null,
  'domain tables are read-only for clients (writes go through action_log functions)'
);

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and not coalesce('security_invoker=true' = any (c.reloptions), false)),
  null,
  'every public view is security_invoker (RLS of the base tables applies)'
);

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and has_table_privilege('anon', c.oid, 'select')),
  null,
  'anon cannot select any public view'
);

select ok(
  not has_table_privilege('authenticated', 'app.state_transitions', 'select')
  and not has_table_privilege('authenticated', 'app.state_transitions', 'insert')
  and not has_table_privilege('anon', 'app.state_transitions', 'select'),
  'clients cannot read or edit the transition table'
);

select results_eq(
  $$ select unnest(enum_range(null::public.intake_state))::text $$,
  array['draft', 'holding', 'processing', 'rollstock', 'reconcile', 'blast_freezer', 'stored', 'done', 'cancelled'],
  'intake_state labels match the doc'
);

select results_eq(
  $$ select unnest(enum_range(null::public.vessel_lifecycle_state))::text $$,
  array['occupied', 'emptied', 'void'],
  'vessel_lifecycle_state labels match the doc'
);

select is(
  (select count(*)::int from pg_type t
   where t.typnamespace = 'public'::regnamespace and t.typtype = 'e'
     and t.typname in (
       'species_group', 'processing_method_kind', 'intake_state', 'charge_kind', 'charge_source_type',
       'charge_state', 'storage_intake_state', 'storage_box_state', 'storage_pickup_batch_state',
       'wave_state', 'scan_log_result', 'asset_tag_state', 'vessel_lifecycle_state', 'location_kind',
       'location_depth', 'allocation_session_state', 'allocation_session_split_method',
       'allocation_session_fulfillment_status', 'settlement_state', 'box_plan_method',
       'box_plan_fulfillment_state', 'release_audit_event_kind', 'shipment_state',
       'payment_terminal_provider', 'payment_state', 'payment_entry_mode', 'payment_event_kind',
       'register_order_state', 'printer_kind', 'print_job_kind', 'print_job_payload_type',
       'print_job_state', 'scale_protocol')),
  33,
  'every enum is named <table>_<col> as in the doc'
);

-- The migration generated from packages/rules/src/states.ts filled the table (no seed
-- step needed), with manager flags, and every entity in it is guarded by a trigger.
select ok((select count(*) from app.state_transitions) > 0, 'state_transitions is filled by its migration');

select results_eq(
  $$ select manager from app.state_transitions
     where (entity, from_state, to_state) in (('vessel', 'emptied', 'occupied'), ('intake', 'draft', 'holding'))
     order by entity desc $$,
  array[true, false],
  'state_transitions carries the manager flag from states.ts'
);

select is(
  (select array_agg(entity order by entity) from (
     select distinct entity from app.state_transitions
     except select entity from app.state_entity) x),
  null,
  'every entity in the transition table has a guarded table'
);

select is(
  (select array_agg(e.entity order by e.entity) from app.state_entity e
   where not exists (select 1 from pg_trigger g where g.tgrelid = e.tbl and g.tgname = 'state_transition_guard')),
  null,
  'every registered entity has the state_transition_guard trigger'
);

-- Fixtures -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-0000000000c1', 'manager-c@test.filletry'),
  ('c0000000-0000-4000-8000-0000000000c2', 'staff-c@test.filletry');

insert into public.org (id, slug, name, timezone) values
  ('c0000000-0000-4000-8000-00000000000c', 'org-c', 'Org C', 'America/Anchorage'),
  ('d0000000-0000-4000-8000-00000000000d', 'org-d', 'Org D', 'America/Anchorage');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('c0000000-0000-4000-8000-00000000000c', 'd0000000-0000-4000-8000-00000000000d');

insert into public.org_member (id, org_id, user_id, role, display_name) values
  ('c0000000-0000-4000-8000-0000000003c1', 'c0000000-0000-4000-8000-00000000000c',
   'c0000000-0000-4000-8000-0000000000c1', 'manager', 'Manager C'),
  ('c0000000-0000-4000-8000-0000000003c2', 'c0000000-0000-4000-8000-00000000000c',
   'c0000000-0000-4000-8000-0000000000c2', 'staff', 'Staff C');

insert into public.customer (id, org_id, name, phone) values
  ('c0000000-0000-4000-8000-0000000010c1', 'c0000000-0000-4000-8000-00000000000c', 'Ann Angler', '+19075550123'),
  ('d0000000-0000-4000-8000-0000000010d1', 'd0000000-0000-4000-8000-00000000000d', 'Dan', null);

insert into public.species (org_id, code, name, "group", skin_off_allowed) values
  ('c0000000-0000-4000-8000-00000000000c', 'salmon_reds', 'Reds', 'salmon', false),
  ('c0000000-0000-4000-8000-00000000000c', 'whitefish_halibut', 'Halibut', 'whitefish', true);
insert into public.incoming_condition (org_id, code, name) values
  ('c0000000-0000-4000-8000-00000000000c', 'whole', 'Whole'),
  ('c0000000-0000-4000-8000-00000000000c', 'filleted_ribs', 'Filleted w/ ribs');
insert into public.processing_method (org_id, code, name, kind) values
  ('c0000000-0000-4000-8000-00000000000c', 'fresh', 'Fresh', 'virtual'),
  ('c0000000-0000-4000-8000-00000000000c', 'portions', 'Portions', 'service');

select is(
  (select phone_digits from public.customer where id = 'c0000000-0000-4000-8000-0000000010c1'),
  '19075550123',
  'customer.phone_digits is the digits of the E.164 phone'
);

select throws_ok(
  $$ insert into public.customer (org_id, name, phone) values ('c0000000-0000-4000-8000-00000000000c', 'Bad', '907-555') $$,
  '23514', null,
  'customer.phone must be E.164'
);

-- Intake denormals ---------------------------------------------------------------------
insert into public.intake (id, org_id, number, customer_id, intake_at, tote_count) values
  ('c0000000-0000-4000-8000-0000000020c1', 'c0000000-0000-4000-8000-00000000000c', 'INT-0001',
   'c0000000-0000-4000-8000-0000000010c1', '2026-07-01 08:00:00-08', 2),
  ('d0000000-0000-4000-8000-0000000020d1', 'd0000000-0000-4000-8000-00000000000d', 'INT-0001',
   'd0000000-0000-4000-8000-0000000010d1', '2026-07-01 08:00:00-08', 1);

select results_eq(
  $$ select total_incoming_lb, total_est_yield_lb, ribbing, hold_until
     from public.intake where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values (0.00::numeric(10,2), 0.00::numeric(10,2), false, '2026-07-03 08:00:00-08'::timestamptz) $$,
  'a new intake has zero totals and hold_until = intake_at + org hold_hours (48)'
);

insert into public.intake_line (id, org_id, intake_id, sort, species_code, condition_code, method_code, lb, fillets_pct, yield_factor) values
  ('c0000000-0000-4000-8000-0000000021c1', 'c0000000-0000-4000-8000-00000000000c',
   'c0000000-0000-4000-8000-0000000020c1', 1, 'salmon_reds', 'whole', 'fresh', 100, 60, 0.5),
  ('c0000000-0000-4000-8000-0000000021c2', 'c0000000-0000-4000-8000-00000000000c',
   'c0000000-0000-4000-8000-0000000020c1', 2, 'whitefish_halibut', 'filleted_ribs', 'portions', 20.5, null, 0.9);

select results_eq(
  $$ select ribbing, est_yield_lb from public.intake_line
     where intake_id = 'c0000000-0000-4000-8000-0000000020c1' order by sort $$,
  $$ values (false, 50.00::numeric(10,2)), (true, 18.45::numeric(10,2)) $$,
  'intake_line.ribbing = (condition = filleted_ribs); est_yield_lb = lb × yield_factor'
);

select results_eq(
  $$ select total_incoming_lb, total_est_yield_lb, ribbing from public.intake
     where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values (120.50::numeric(10,2), 68.45::numeric(10,2), true) $$,
  'intake totals and ribbing follow inserted lines'
);

update public.intake_line set lb = 40 where id = 'c0000000-0000-4000-8000-0000000021c1';
select results_eq(
  $$ select total_incoming_lb, total_est_yield_lb from public.intake where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values (60.50::numeric(10,2), 38.45::numeric(10,2)) $$,
  'intake totals follow a line update'
);

delete from public.intake_line where id = 'c0000000-0000-4000-8000-0000000021c2';
select results_eq(
  $$ select total_incoming_lb, total_est_yield_lb, ribbing from public.intake where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values (40.00::numeric(10,2), 20.00::numeric(10,2), false) $$,
  'intake totals and ribbing follow a line delete'
);

update public.intake set total_incoming_lb = 999, ribbing = true where id = 'c0000000-0000-4000-8000-0000000020c1';
select results_eq(
  $$ select total_incoming_lb, ribbing from public.intake where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values (40.00::numeric(10,2), false) $$,
  'a direct write to the intake denormals does not stick'
);

select throws_ok(
  $$ insert into public.intake_line (org_id, intake_id, species_code, condition_code, method_code, lb)
     values ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000020c1', 'salmon_reds', 'whole', 'fresh', -1) $$,
  '23514', null,
  'intake_line.lb >= 0'
);

select throws_ok(
  $$ insert into public.intake_line (org_id, intake_id, species_code, condition_code, method_code, lb, fillets_pct)
     values ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000020c1', 'salmon_reds', 'whole', 'fresh', 1, 101) $$,
  '23514', null,
  'intake_line.fillets_pct between 0 and 100'
);

select throws_ok(
  $$ insert into public.intake_line (org_id, intake_id, species_code, condition_code, method_code, lb)
     values ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000020c1', 'salmon_kings', 'whole', 'fresh', 1) $$,
  '23503', null,
  'intake_line codes must exist in the org''s reference data'
);

-- charge.amount ------------------------------------------------------------------------
insert into public.charge (id, org_id, number, customer_id, kind, source_type, source_id, qty, unit, unit_price) values
  ('c0000000-0000-4000-8000-0000000030c1', 'c0000000-0000-4000-8000-00000000000c', 'CHG-0001',
   'c0000000-0000-4000-8000-0000000010c1', 'processing', 'intake', 'c0000000-0000-4000-8000-0000000020c1',
   10.5, 'lb', 2.35);

select is(
  (select amount from public.charge where id = 'c0000000-0000-4000-8000-0000000030c1'),
  24.68::numeric(12,2),
  'charge.amount = qty × unit_price (rounded to cents)'
);

update public.charge set unit_price = 2.00 where id = 'c0000000-0000-4000-8000-0000000030c1';
select is(
  (select amount from public.charge where id = 'c0000000-0000-4000-8000-0000000030c1'),
  21.00::numeric(12,2),
  'charge.amount follows a re-price'
);

select throws_ok(
  $$ update public.charge set state = 'settled' where id = 'c0000000-0000-4000-8000-0000000030c1' $$,
  '23514', null,
  'a settled charge must reference its payment'
);

-- Storage box counts and days stored (S4) ---------------------------------------------
insert into public.storage_intake (id, org_id, number, customer_id, intake_at) values
  ('c0000000-0000-4000-8000-0000000040c1', 'c0000000-0000-4000-8000-00000000000c', 'STG-0001',
   'c0000000-0000-4000-8000-0000000010c1', now() - interval '3 days');

insert into public.storage_box (id, org_id, storage_intake_id, box_no) values
  ('c0000000-0000-4000-8000-0000000041c1', 'c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000040c1', 1),
  ('c0000000-0000-4000-8000-0000000041c2', 'c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000040c1', 2),
  ('c0000000-0000-4000-8000-0000000041c3', 'c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000040c1', 3);

select results_eq(
  $$ select box_count, active_box_count from public.storage_intake where id = 'c0000000-0000-4000-8000-0000000040c1' $$,
  $$ values (3, 3) $$,
  'storage_intake box counts follow inserted boxes'
);

select is(
  (select label from public.storage_box where id = 'c0000000-0000-4000-8000-0000000041c2'),
  'Box 2',
  'storage_box.label defaults to "Box <n>"'
);

update public.storage_box set state = 'released' where id = 'c0000000-0000-4000-8000-0000000041c1';

select results_eq(
  $$ select box_count, active_box_count from public.storage_intake where id = 'c0000000-0000-4000-8000-0000000040c1' $$,
  $$ values (3, 2) $$,
  'releasing a box decrements active_box_count'
);

select isnt(
  (select released_at from public.storage_box where id = 'c0000000-0000-4000-8000-0000000041c1'),
  null,
  'stored → released stamps storage_box.released_at'
);

select is(
  (select days_stored from public.storage_box_days where storage_box_id = 'c0000000-0000-4000-8000-0000000041c2'),
  3,
  'storage_box_days: days between intake and now in org tz'
);

select is(app.storage_days('2026-07-01 09:00-08', '2026-07-01 17:00-08', 'America/Anchorage'), 1, 'S4: same day = 1');
select is(app.storage_days('2026-07-01 23:30-08', '2026-07-02 00:30-08', 'America/Anchorage'), 1,
  'S4: crossing midnight in org tz counts calendar days');
select is(app.storage_days('2026-07-01 12:00-08', '2026-07-11 12:00-08', 'America/Anchorage'), 10, 'S4: ten days');

-- Floor: vessel location mirror, archived locations -----------------------------------
insert into public.location (id, org_id, zone, kind, "row", bay, level, depth, code, qr) values
  ('c0000000-0000-4000-8000-0000000050c1', 'c0000000-0000-4000-8000-00000000000c', 'IF', 'rack', 'A', 1, 1, 'F',
   'IF-A-01-1-F', 'FL:LOC:org-c:IF-A-01-1-F'),
  ('c0000000-0000-4000-8000-0000000050c2', 'c0000000-0000-4000-8000-00000000000c', 'IF', 'rack', 'A', 1, 1, 'R',
   'IF-A-01-1-R', 'FL:LOC:org-c:IF-A-01-1-R');
insert into public.location (id, org_id, zone, kind, code, qr, is_active) values
  ('c0000000-0000-4000-8000-0000000050c3', 'c0000000-0000-4000-8000-00000000000c', 'IF', 'pallet',
   'IF-PALLET-01', 'FL:LOC:org-c:IF-PALLET-01', false);

select ok(
  (select sort_key from public.location where id = 'c0000000-0000-4000-8000-0000000050c1')
  < (select sort_key from public.location where id = 'c0000000-0000-4000-8000-0000000050c2'),
  'location.sort_key walks F before R'
);

select throws_ok(
  $$ insert into public.location (org_id, zone, kind, code, qr, depth)
     values ('c0000000-0000-4000-8000-00000000000c', 'IF', 'pallet', 'IF-PALLET-02', 'x', 'F') $$,
  '23514', null,
  'pallet locations have no depth'
);

insert into public.vessel (id, org_id, intake_id, weight_lb) values
  ('c0000000-0000-4000-8000-0000000060c1', 'c0000000-0000-4000-8000-00000000000c',
   'c0000000-0000-4000-8000-0000000020c1', 30);

insert into public.location_placement (org_id, vessel_id, location_id, placed_at) values
  ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000060c1',
   'c0000000-0000-4000-8000-0000000050c1', now() - interval '1 hour');
select is(
  (select location_id from public.vessel where id = 'c0000000-0000-4000-8000-0000000060c1'),
  'c0000000-0000-4000-8000-0000000050c1'::uuid,
  'vessel.location_id mirrors the first placement'
);

insert into public.location_placement (org_id, vessel_id, location_id, placed_at) values
  ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000060c1',
   'c0000000-0000-4000-8000-0000000050c2', now());
select is(
  (select location_id from public.vessel where id = 'c0000000-0000-4000-8000-0000000060c1'),
  'c0000000-0000-4000-8000-0000000050c2'::uuid,
  'vessel.location_id mirrors the latest placement'
);

select throws_ok(
  $$ insert into public.location_placement (org_id, vessel_id, location_id) values
     ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000060c1', 'c0000000-0000-4000-8000-0000000050c3') $$,
  '23514', null,
  'an archived location cannot be bound by a placement'
);

select throws_ok(
  $$ update public.vessel set location_id = 'c0000000-0000-4000-8000-0000000050c3'
     where id = 'c0000000-0000-4000-8000-0000000060c1' $$,
  '23514', null,
  'an archived location cannot be bound to a vessel'
);

-- Another org's locations: one live, one archived.
insert into public.location (id, org_id, zone, kind, code, qr, is_active) values
  ('d0000000-0000-4000-8000-0000000050d1', 'd0000000-0000-4000-8000-00000000000d', 'IF', 'pallet',
   'IF-PALLET-01', 'FL:LOC:org-d:IF-PALLET-01', true),
  ('d0000000-0000-4000-8000-0000000050d2', 'd0000000-0000-4000-8000-00000000000d', 'IF', 'pallet',
   'IF-PALLET-02', 'FL:LOC:org-d:IF-PALLET-02', false);

select throws_ok(
  $$ insert into public.location_placement (org_id, vessel_id, location_id) values
     ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000060c1', 'd0000000-0000-4000-8000-0000000050d1') $$,
  '23503', 'location not found',
  'a placement cannot bind another org''s live location'
);

select throws_ok(
  $$ update public.vessel set location_id = 'd0000000-0000-4000-8000-0000000050d1'
     where id = 'c0000000-0000-4000-8000-0000000060c1' $$,
  '23503', 'location not found',
  'a vessel cannot be bound to another org''s location'
);

select throws_ok(
  $$ insert into public.storage_intake (org_id, number, customer_id, location_id) values
     ('c0000000-0000-4000-8000-00000000000c', 'STG-0002', 'c0000000-0000-4000-8000-0000000010c1',
      'd0000000-0000-4000-8000-0000000050d1') $$,
  '23503', 'location not found',
  'a storage intake cannot be bound to another org''s location'
);

select set_config('request.jwt.claims',
  '{"sub":"c0000000-0000-4000-8000-0000000000c1","role":"authenticated","org_id":"c0000000-0000-4000-8000-00000000000c","app_role":"manager"}',
  true);
set local role authenticated;

select lives_ok(
  $$ select app.check_location_is_live('c0000000-0000-4000-8000-0000000050c1') $$,
  'check_location_is_live passes for a live location of the caller''s org'
);

select throws_ok(
  $$ select app.check_location_is_live('c0000000-0000-4000-8000-0000000050c3') $$,
  '23514', null,
  'check_location_is_live rejects the caller''s archived location'
);

select throws_ok(
  $$ select app.check_location_is_live('d0000000-0000-4000-8000-0000000050d1') $$,
  '23503', 'location not found',
  'another org''s live location reads as not found'
);

select throws_ok(
  $$ select app.check_location_is_live('d0000000-0000-4000-8000-0000000050d2') $$,
  '23503', 'location not found',
  'another org''s archived location reads as not found (no state or code leaks)'
);

select throws_ok(
  $$ select app.check_location_is_live('d0000000-0000-4000-8000-0000000050d1', 'd0000000-0000-4000-8000-00000000000d') $$,
  '23503', 'location not found',
  'an end user cannot ask about another org by passing its id'
);

reset role;
select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ update public.location_placement set location_id = 'c0000000-0000-4000-8000-0000000050c1'
     where vessel_id = 'c0000000-0000-4000-8000-0000000060c1' $$,
  '55000', null,
  'location_placement is append-only'
);

select lives_ok(
  $$ insert into public.vessel (org_id, intake_id, is_exchange) values
     ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000020c1', true) $$,
  'an untagged smoked-exchange vessel is occupied by default'
);

insert into public.asset_tag (id, org_id, code, qr) values
  ('c0000000-0000-4000-8000-0000000070c1', 'c0000000-0000-4000-8000-00000000000c', '042', 'FL:TAG:org-c:042');

select throws_ok(
  $$ update public.asset_tag set state = 'in_use' where id = 'c0000000-0000-4000-8000-0000000070c1' $$,
  '23514', null,
  'an in_use asset tag must be bound to a vessel'
);

select throws_ok(
  $$ insert into public.vessel (org_id, intake_id, is_exchange, asset_tag_id) values
     ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000020c1', true, 'c0000000-0000-4000-8000-0000000070c1') $$,
  '23514', null,
  'smoked-exchange vessels are never tagged'
);

-- reconcile_variance -------------------------------------------------------------------
insert into public.reconcile_line (org_id, intake_id, intake_line_id, expected_lb, actual_lb) values
  ('c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000020c1',
   'c0000000-0000-4000-8000-0000000021c1', 20, 18);

select is(
  (select variance_pct from public.reconcile_variance where intake_line_id = 'c0000000-0000-4000-8000-0000000021c1'),
  -10.00::numeric,
  'reconcile_variance = (actual − expected) / expected × 100'
);

-- allocation_session_fulfillment -------------------------------------------------------
insert into public.allocation_session (id, org_id, number) values
  ('c0000000-0000-4000-8000-0000000080c1', 'c0000000-0000-4000-8000-00000000000c', 'ALC-0001');
insert into public.settlement (id, org_id, number, session_id, angler_name) values
  ('c0000000-0000-4000-8000-0000000081c1', 'c0000000-0000-4000-8000-00000000000c', 'STL-0001',
   'c0000000-0000-4000-8000-0000000080c1', 'Ann');

select is(
  (select fulfillment_status from public.allocation_session_fulfillment where session_id = 'c0000000-0000-4000-8000-0000000080c1'),
  'none'::public.allocation_session_fulfillment_status,
  'fulfillment: no boxes → none'
);

insert into public.box_plan (id, org_id, number, settlement_id, session_id, method, weight_lb) values
  ('c0000000-0000-4000-8000-0000000082c1', 'c0000000-0000-4000-8000-00000000000c', 'BOX-0001',
   'c0000000-0000-4000-8000-0000000081c1', 'c0000000-0000-4000-8000-0000000080c1', 'ship', 40),
  ('c0000000-0000-4000-8000-0000000082c2', 'c0000000-0000-4000-8000-00000000000c', 'BOX-0002',
   'c0000000-0000-4000-8000-0000000081c1', 'c0000000-0000-4000-8000-0000000080c1', 'willcall', 30);

select is(
  (select fulfillment_status from public.allocation_session_fulfillment where session_id = 'c0000000-0000-4000-8000-0000000080c1'),
  'pending'::public.allocation_session_fulfillment_status,
  'fulfillment: all planned → pending'
);

update public.box_plan set fulfillment_state = 'packed' where id = 'c0000000-0000-4000-8000-0000000082c1';
select is(
  (select fulfillment_status from public.allocation_session_fulfillment where session_id = 'c0000000-0000-4000-8000-0000000080c1'),
  'partial'::public.allocation_session_fulfillment_status,
  'fulfillment: some released → partial'
);

update public.box_plan set fulfillment_state = 'picked_up' where id = 'c0000000-0000-4000-8000-0000000082c2';
select is(
  (select fulfillment_status from public.allocation_session_fulfillment where session_id = 'c0000000-0000-4000-8000-0000000080c1'),
  'released'::public.allocation_session_fulfillment_status,
  'fulfillment: no planned boxes left → released'
);

select throws_ok(
  $$ insert into public.box_plan (org_id, number, settlement_id, session_id, method, weight_lb) values
     ('c0000000-0000-4000-8000-00000000000c', 'BOX-0003', 'c0000000-0000-4000-8000-0000000081c1',
      'c0000000-0000-4000-8000-0000000080c1', 'air', 71) $$,
  '23514', null,
  'box over 70 lb needs heavy_allowed'
);

select throws_ok(
  $$ update public.box_plan set fulfillment_state = 'planned' where id = 'c0000000-0000-4000-8000-0000000082c1' $$,
  '23514', null,
  'box_plan terminal states never roll back (packed → planned rejected)'
);

-- State-transition guard ---------------------------------------------------------------
select throws_ok(
  $$ update public.intake set state = 'stored' where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  '23514', null,
  'illegal transition intake draft → stored is rejected'
);

update public.intake set state = 'holding' where id = 'c0000000-0000-4000-8000-0000000020c1';
update public.intake set state = 'processing' where id = 'c0000000-0000-4000-8000-0000000020c1';
select results_eq(
  $$ select state::text, pulled_at is not null from public.intake where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values ('processing', true) $$,
  'legal transitions pass and stamp their timestamp (holding → processing stamps pulled_at)'
);

update public.vessel set lifecycle_state = 'emptied' where id = 'c0000000-0000-4000-8000-0000000060c1';
select isnt(
  (select emptied_at from public.vessel where id = 'c0000000-0000-4000-8000-0000000060c1'),
  null,
  'occupied → emptied stamps vessel.emptied_at'
);

-- force_transition ---------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"c0000000-0000-4000-8000-0000000000c2","role":"authenticated","org_id":"c0000000-0000-4000-8000-00000000000c","app_role":"staff"}',
  true);
set local role authenticated;

select throws_ok(
  $$ insert into public.intake (org_id, number, customer_id) values
     ('c0000000-0000-4000-8000-00000000000c', 'INT-0099', 'c0000000-0000-4000-8000-0000000010c1') $$,
  '42501', null,
  'clients cannot write domain tables directly'
);

select throws_ok(
  $$ select public.force_transition('force-staff-0001', 'intake', 'c0000000-0000-4000-8000-0000000020c1', 'stored', 'because') $$,
  '42501', null,
  'staff cannot force a transition'
);

reset role;
select set_config('request.jwt.claims',
  '{"sub":"c0000000-0000-4000-8000-0000000000c1","role":"authenticated","org_id":"c0000000-0000-4000-8000-00000000000c","app_role":"manager"}',
  true);
set local role authenticated;

select throws_ok(
  $$ select public.force_transition('force-noreason-1', 'intake', 'c0000000-0000-4000-8000-0000000020c1', 'stored', '  ') $$,
  '22023', null,
  'force_transition requires a reason'
);

select throws_ok(
  $$ select public.force_transition('force-unknown-01', 'intake', 'd0000000-0000-4000-8000-0000000020d1', 'stored', 'test') $$,
  'P0002', null,
  'force_transition cannot reach a row outside the caller''s org'
);

select is(
  public.force_transition('force-mgr-00001', 'intake', 'c0000000-0000-4000-8000-0000000020c1', 'stored',
                          'tote tags lost; manager verified in freezer'),
  '{"entity":"intake","id":"c0000000-0000-4000-8000-0000000020c1","from_state":"processing","to_state":"stored"}'::jsonb,
  'a manager forces processing → stored (not an edge)'
);

select is(
  public.force_transition('force-mgr-00001', 'intake', 'c0000000-0000-4000-8000-0000000020c1', 'stored',
                          'tote tags lost; manager verified in freezer'),
  '{"entity":"intake","id":"c0000000-0000-4000-8000-0000000020c1","from_state":"processing","to_state":"stored"}'::jsonb,
  'replaying the same client_action_id returns the stored result'
);

select throws_ok(
  $$ select public.force_transition('force-box-000001', 'box_plan', 'c0000000-0000-4000-8000-0000000082c1',
                                    'planned', 'customer changed their mind') $$,
  '23514', null,
  'box_plan terminal states never roll back, not even through force_transition'
);

reset role;

-- The guard enforces it on its own, even with the bypass flag set for that exact row.
select set_config('app.forced_transition', 'box_plan:c0000000-0000-4000-8000-0000000082c1:planned', true);
select throws_ok(
  $$ update public.box_plan set fulfillment_state = 'planned' where id = 'c0000000-0000-4000-8000-0000000082c1' $$,
  '23514', null,
  'the guard refuses the manager bypass for non-forceable entities (box_plan)'
);
select set_config('app.forced_transition', '', true);

select is(
  (select fulfillment_state::text from public.box_plan where id = 'c0000000-0000-4000-8000-0000000082c1'),
  'packed',
  'the released box stays packed'
);

select results_eq(
  $$ select state::text, stored_at is not null from public.intake where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  $$ values ('stored', true) $$,
  'the forced transition is applied and stamps stored_at'
);

select results_eq(
  $$ select action, input ->> 'reason', user_id, completed_at is not null from public.action_log
     where client_action_id = 'force-mgr-00001' $$,
  $$ values ('state.force', 'tote tags lost; manager verified in freezer',
             'c0000000-0000-4000-8000-0000000000c1'::uuid, true) $$,
  'force_transition writes action_log with the reason'
);

select is(current_setting('app.forced_transition', true), '', 'the forced flag is cleared after force_transition');

select throws_ok(
  $$ update public.intake set state = 'holding' where id = 'c0000000-0000-4000-8000-0000000020c1' $$,
  '23514', null,
  'after a forced transition, the guard still rejects illegal edges in the same transaction'
);

select * from finish();
rollback;
