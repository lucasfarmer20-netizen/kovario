-- WP-15 boxing / will-call release: release_party, the I10 close gate, the append-only
-- release_audit, restore_vessel and Release-by-Tag, against the CSP release spec
-- (docs/10-LESSONS-FROM-CSP.md §2). One test group per path P1–P24 (named `P<n> —`), plus
-- the invariants they lean on (`I<n> —`). P18's true two-transaction race is in
-- packages/db/src/release.db.test.ts; here P18 is the sequential loser.
-- Fixtures are written as the table owner; every release call runs as `authenticated`.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a1500000-0000-4000-8000-00000000000a', 'rel-a', 'Release A', 'UTC'),
  ('b1500000-0000-4000-8000-00000000000b', 'rel-b', 'Release B', 'UTC');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('a1500000-0000-4000-8000-00000000000a', 'b1500000-0000-4000-8000-00000000000b');
insert into public.site (id, org_id, name, is_default) values
  ('a1500000-0000-4000-8000-0000000000a5', 'a1500000-0000-4000-8000-00000000000a', 'Dock', true);
insert into public.customer (id, org_id, name, phone) values
  ('a1500000-0000-4000-8000-0000000002a1', 'a1500000-0000-4000-8000-00000000000a', 'Pat Party', '+19075551501'),
  ('a1500000-0000-4000-8000-0000000002a3', 'a1500000-0000-4000-8000-00000000000a', 'Olga Other', '+19075551503');
insert into auth.users (id, email) values
  ('a1500000-0000-4000-8000-0000000000f1', 'release-manager@example.test'),
  ('a1500000-0000-4000-8000-0000000000f2', 'release-staff@example.test');
insert into public.org_member (id, org_id, user_id, role, display_name) values
  ('a1500000-0000-4000-8000-0000000000e1', 'a1500000-0000-4000-8000-00000000000a',
   'a1500000-0000-4000-8000-0000000000f1', 'manager', 'Mia Manager'),
  ('a1500000-0000-4000-8000-0000000000e2', 'a1500000-0000-4000-8000-00000000000a',
   'a1500000-0000-4000-8000-0000000000f2', 'staff', 'Sid Staff');
insert into public.location (org_id, zone, kind, "row", bay, level, depth, code, qr)
select 'a1500000-0000-4000-8000-00000000000a', 'IF', 'rack', 'A', b, 1, d::public.location_depth,
       format('IF-A-%s-1-%s', lpad(b::text, 2, '0'), d), format('FL:LOC:rel-a:IF-A-%s-1-%s', lpad(b::text, 2, '0'), d)
from generate_series(1, 3) b, unnest('{F,R}'::text[]) d;
insert into public.box_size (id, org_id, name, max_lb, fee) values
  ('a1500000-0000-4000-8000-0000000000b1', 'a1500000-0000-4000-8000-00000000000a', 'Medium', 50, 10);
insert into public.rate_card (id, org_id, name, is_default) values
  ('a1500000-0000-4000-8000-0000000000c1', 'a1500000-0000-4000-8000-00000000000a', 'Standard', true);
insert into public.rate_card_line (org_id, rate_card_id, key, amount) values
  ('a1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-0000000000c1', 'storage_per_box_day', 0.75);

create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated;
create sequence pg_temp.n_seq;

create function pg_temp.id(p_k text) returns uuid language sql as $$ select v from t_ids where k = p_k $$;
create function pg_temp.put(p_k text, p_v uuid) returns uuid language sql as $$
  insert into t_ids values (p_k, p_v) returning v
$$;
create function pg_temp.as_user(p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', case p_role when 'manager' then 'a1500000-0000-4000-8000-0000000000f1'
                       else 'a1500000-0000-4000-8000-0000000000f2' end,
    'role', 'authenticated', 'org_id', 'a1500000-0000-4000-8000-00000000000a',
    'app_role', p_role)::text, true);
$$;

-- Fixture builders (run as the table owner) ----------------------------------------------
create function pg_temp.intake(p_k text, p_customer text default 'pat', p_state text default 'stored')
returns uuid language sql as $$
  with x as (
    insert into public.intake (org_id, number, customer_id, site_id, state, dirty_fish, cut_notes)
    values ('a1500000-0000-4000-8000-00000000000a', 'INT-' || lpad(nextval('pg_temp.n_seq')::text, 4, '0'),
            case p_customer when 'olga' then 'a1500000-0000-4000-8000-0000000002a3'::uuid
                            else 'a1500000-0000-4000-8000-0000000002a1'::uuid end,
            'a1500000-0000-4000-8000-0000000000a5', p_state::public.intake_state,
            p_k = 'i4', case when p_k = 'i4' then 'skin on' end)
    returning id)
  insert into t_ids select p_k, id from x returning v
$$;
-- A vessel as reconcile + locate leave it: tag p_tag bound (null = exchange), on p_loc.
create function pg_temp.vessel(p_k text, p_intake text, p_lb numeric, p_tag text, p_loc text default null)
returns uuid language plpgsql as $$
declare v uuid; t uuid;
begin
  if p_tag is not null then
    insert into public.asset_tag (org_id, code, qr)
    values ('a1500000-0000-4000-8000-00000000000a', p_tag, 'FL:TAG:rel-a:' || p_tag)
    on conflict (org_id, code) do nothing;
    select id into t from public.asset_tag where org_id = 'a1500000-0000-4000-8000-00000000000a' and code = p_tag;
  end if;
  insert into public.vessel (org_id, intake_id, asset_tag_id, is_exchange, weight_lb, species_summary,
                             location_id, stored_at)
  values ('a1500000-0000-4000-8000-00000000000a', pg_temp.id(p_intake), t, p_tag is null, p_lb, 'Silvers',
          (select id from public.location where code = p_loc), now())
  returning id into v;
  if t is not null then
    update public.asset_tag set state = 'in_use', current_vessel_id = v where id = t;
  end if;
  return pg_temp.put(p_k, v);
end $$;
create function pg_temp.session(p_k text, p_intakes text[], p_state text default 'priced', p_party text default 'pat')
returns uuid language plpgsql as $$
declare s uuid;
begin
  insert into public.allocation_session (org_id, number, party_customer_id, state)
  values ('a1500000-0000-4000-8000-00000000000a', 'ALC-' || lpad(nextval('pg_temp.n_seq')::text, 4, '0'),
          case p_party when 'pat' then 'a1500000-0000-4000-8000-0000000002a1'::uuid end,
          p_state::public.allocation_session_state)
  returning id into s;
  insert into public.allocation_intake (org_id, session_id, intake_id)
  select 'a1500000-0000-4000-8000-00000000000a', s, pg_temp.id(k) from unnest(p_intakes) k;
  return pg_temp.put(p_k, s);
end $$;
create function pg_temp.box(p_k text, p_session text, p_angler text, p_method text default 'willcall',
  p_shipment text default null)
returns uuid language plpgsql as $$
declare st uuid;
begin
  select id into st from public.settlement where session_id = pg_temp.id(p_session) and angler_name = p_angler;
  if st is null then
    insert into public.settlement (org_id, number, session_id, angler_name)
    values ('a1500000-0000-4000-8000-00000000000a', 'STL-' || lpad(nextval('pg_temp.n_seq')::text, 4, '0'),
            pg_temp.id(p_session), p_angler)
    returning id into st;
  end if;
  insert into public.box_plan (org_id, number, settlement_id, session_id, method, box_size_id, weight_lb, shipment_id)
  values ('a1500000-0000-4000-8000-00000000000a', 'BOX-' || lpad(nextval('pg_temp.n_seq')::text, 4, '0'), st,
          pg_temp.id(p_session), p_method::public.box_plan_method, 'a1500000-0000-4000-8000-0000000000b1', 20,
          pg_temp.id(p_shipment))
  returning id into st;
  return pg_temp.put(p_k, st);
end $$;
create function pg_temp.shipment(p_k text, p_days int, p_service text, p_blockers jsonb default '[]',
  p_state text default 'draft')
returns uuid language sql as $$
  with x as (
    insert into public.shipment (org_id, number, ship_date, service, blockers, state)
    values ('a1500000-0000-4000-8000-00000000000a', 'SHP-' || lpad(nextval('pg_temp.n_seq')::text, 4, '0'),
            app.org_today('a1500000-0000-4000-8000-00000000000a') + p_days, p_service, p_blockers,
            p_state::public.shipment_state)
    returning id)
  insert into t_ids select p_k, id from x returning v
$$;

-- Calls (run as authenticated) -------------------------------------------------------------
-- p_lines: [[vessel key, lbs_left, ticked?], …]; measure is what the wizard saw (current).
create function pg_temp.lines(p_lines jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'vessel_id', pg_temp.id(l ->> 0), 'lbs_left', l -> 1,
    'ticked', coalesce((l ->> 2)::boolean, true),
    'measure', (select weight_lb from public.vessel where id = pg_temp.id(l ->> 0)))), '[]')
  from jsonb_array_elements(p_lines) l
$$;
create function pg_temp.release(p_session text, p_boxes text[], p_lines jsonb default '[]',
  p_ref text default null, p_action text default null)
returns jsonb language sql as $$
  select public.release_party(coalesce(p_action, gen_random_uuid()::text), pg_temp.id(p_session),
    coalesce((select array_agg(pg_temp.id(b)) from unnest(p_boxes) b), '{}'), pg_temp.lines(p_lines), p_ref)
$$;
create function pg_temp.by_tag(p_tag text, p_lbs numeric default 0, p_reason text default 'forgot to tick')
returns jsonb language sql as $$
  select public.release_by_tag(gen_random_uuid()::text, p_tag, p_lbs, p_reason)
$$;
create function pg_temp.vstate(p_k text) returns text language sql as $$
  select format('%s:%s:%s', v.lifecycle_state, v.weight_lb, coalesce(l.code, '-'))
  from public.vessel v left join public.location l on l.id = v.location_id where v.id = pg_temp.id(p_k)
$$;
create function pg_temp.bstate(p_k text) returns text language sql as $$
  select fulfillment_state::text from public.box_plan where id = pg_temp.id(p_k)
$$;
create function pg_temp.istate(p_k text) returns text language sql as $$
  select state::text from public.intake where id = pg_temp.id(p_k)
$$;
create function pg_temp.tag(p_code text) returns text language sql as $$
  select format('%s:%s', t.state, coalesce((select k from t_ids where v = t.current_vessel_id), '-'))
  from public.asset_tag t where t.org_id = 'a1500000-0000-4000-8000-00000000000a' and t.code = p_code
$$;
-- kind:intake key:vessel key:session key, sorted, for the audit rows of the given intakes.
create function pg_temp.audit(p_intakes text[]) returns text[] language sql as $$
  select coalesce(array_agg(r order by r), '{}') from (
    select format('%s:%s:%s:%s', a.event_kind,
             (select k from t_ids where v = a.intake_id), coalesce((select k from t_ids where v = a.vessel_id), '-'),
             coalesce((select k from t_ids where v = a.session_id), '-')) as r
    from public.release_audit a
    where a.intake_id in (select pg_temp.id(k) from unnest(p_intakes) k)) x
$$;
-- 'ok', or the SQLSTATE + message the statement raised (its writes roll back).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
create temp table t_res (k text primary key, r jsonb) on commit drop;
grant all on t_res to authenticated;

-- Scenarios ----------------------------------------------------------------------------------
select pg_temp.intake('i1'); select pg_temp.vessel('v1a', 'i1', 30, '101', 'IF-A-01-1-F');
select pg_temp.vessel('v1b', 'i1', 20, '102', 'IF-A-01-1-R');
select pg_temp.session('s1', '{i1}'); select pg_temp.box('b1a', 's1', 'Ann'); select pg_temp.box('b1b', 's1', 'Ann', 'air');

select pg_temp.intake('i1s'); select pg_temp.vessel('v1s', 'i1s', 10, '103', 'IF-A-02-1-F');
select pg_temp.session('s1s', '{i1s}'); select pg_temp.box('b1s', 's1s', 'Ann');
select pg_temp.session('s1o', '{i1s}'); select pg_temp.box('b1o', 's1o', 'Bea');

select pg_temp.intake('i2'); select pg_temp.vessel('v2a', 'i2', 25, '201'); select pg_temp.vessel('v2b', 'i2', 25, '202');
select pg_temp.session('s2', '{i2}');
select pg_temp.box('b2a', 's2', 'Ann'); select pg_temp.box('b2b', 's2', 'Ben'); select pg_temp.box('b2c', 's2', 'Cy');

select pg_temp.intake('i3'); select pg_temp.vessel('v3', 'i3', 40, '301', 'IF-A-03-1-F');
select pg_temp.session('s3', '{i3}'); select pg_temp.box('b3', 's3', 'Ann');

select pg_temp.intake('i4'); select pg_temp.vessel('vex', 'i4', 12, null); select pg_temp.vessel('v4', 'i4', 18, '401');
select pg_temp.session('s4', '{i4}'); select pg_temp.box('b4', 's4', 'Ann');

select pg_temp.intake('i5'); select pg_temp.vessel('v5', 'i5', 22, '501');
select pg_temp.session('s5', '{i5}'); select pg_temp.box('b5a', 's5', 'Ann'); select pg_temp.box('b5b', 's5', 'Ann');

select pg_temp.intake('i6a'); select pg_temp.intake('i6b');
select pg_temp.vessel('v6a', 'i6a', 15, '601'); select pg_temp.vessel('v6b', 'i6b', 15, '602');
select pg_temp.session('s6', '{i6a,i6b}'); select pg_temp.box('b6', 's6', 'Ann');

select pg_temp.intake('i8'); select pg_temp.vessel('v8', 'i8', 14, '801');
select pg_temp.session('s8', '{i8}'); select pg_temp.box('b8', 's8', 'Ann');
insert into public.storage_intake (id, org_id, number, customer_id, state)
values ('a1500000-0000-4000-8000-0000000008a1', 'a1500000-0000-4000-8000-00000000000a', 'STG-0001',
        'a1500000-0000-4000-8000-0000000002a1', 'stored');
insert into public.storage_box (id, org_id, storage_intake_id, box_no, label)
values ('a1500000-0000-4000-8000-0000000008b1', 'a1500000-0000-4000-8000-00000000000a',
        'a1500000-0000-4000-8000-0000000008a1', 1, 'Box 1');

select pg_temp.intake('i9'); select pg_temp.vessel('v9', 'i9', 10, '901');
select pg_temp.session('s9', '{i9}', 'priced', null);
select pg_temp.intake('i9x', 'olga'); select pg_temp.vessel('v9x', 'i9x', 10, '902');

select pg_temp.shipment('sh10', 3, 'usps_priority');
select pg_temp.intake('i10'); select pg_temp.vessel('v10', 'i10', 20, '1001');
select pg_temp.session('s10', '{i10}'); select pg_temp.box('b10', 's10', 'Ann', 'ship', 'sh10');

select pg_temp.shipment('sh11', 5, null, '["bad_address"]');
select pg_temp.intake('i11'); select pg_temp.vessel('v11', 'i11', 20, '1101');
select pg_temp.session('s11', '{i11}'); select pg_temp.box('b11', 's11', 'Ann', 'ship', 'sh11');

select pg_temp.intake('i13'); select pg_temp.vessel('v13a', 'i13', 10, '1301'); select pg_temp.vessel('v13b', 'i13', 12, '1302');

select pg_temp.intake('i17'); select pg_temp.vessel('v17a', 'i17', 10, '1701'); select pg_temp.vessel('v17b', 'i17', 30, '1702');
select pg_temp.session('s17', '{i17}'); select pg_temp.box('b17', 's17', 'Ann');

select pg_temp.intake('i19'); select pg_temp.vessel('v19a', 'i19', 10, '1901'); select pg_temp.vessel('v19b', 'i19', 10, '1902');
select pg_temp.session('s19', '{i19}'); select pg_temp.box('b19', 's19', 'Ann');

select pg_temp.intake('i20'); select pg_temp.vessel('v20', 'i20', 10, '2001');
select pg_temp.intake('i20x'); select pg_temp.vessel('v20x', 'i20x', 10, '2002');
select pg_temp.session('s20', '{i20}'); select pg_temp.session('s20o', '{i20x}');

select pg_temp.intake('i21'); select pg_temp.intake('i21b'); select pg_temp.vessel('v21', 'i21b', 10, '2101');
select pg_temp.session('s21', '{i21,i21b}'); select pg_temp.box('b21', 's21', 'Ann');

select pg_temp.intake('i22'); select pg_temp.vessel('v22a', 'i22', 10, '2201');
select pg_temp.vessel('v22b', 'i22', 10, '2202'); select pg_temp.vessel('v22c', 'i22', 10, '2203');
select pg_temp.session('s22', '{i22}'); select pg_temp.box('b22a', 's22', 'Ann'); select pg_temp.box('b22b', 's22', 'Ann');

select pg_temp.shipment('sh23', 0, 'usps_priority');
update public.shipment set ship_date = null where id = pg_temp.id('sh23');
select pg_temp.intake('i23'); select pg_temp.vessel('v23', 'i23', 20, '2301');
select pg_temp.session('s23', '{i23}'); select pg_temp.box('b23', 's23', 'Ann', 'ship', 'sh23');

select pg_temp.shipment('sh24', 10, 'usps_priority', '[]', 'label_bought');

select pg_temp.intake('ir'); select pg_temp.vessel('vr', 'ir', 33, '3301', 'IF-A-02-1-R');
select pg_temp.session('sr', '{ir}'); select pg_temp.box('br', 'sr', 'Ann');

select pg_temp.intake('ic'); select pg_temp.vessel('vc', 'ic', 10, '4001');
select pg_temp.session('sc', '{ic}', 'cancelled'); select pg_temp.box('bc', 'sc', 'Ann');

create temp table t_p3 on commit drop as select pg_temp.lines('[["v3", 15]]') as lines;
grant all on t_p3 to authenticated;

set local role authenticated;
select pg_temp.as_user('staff');

-- P1 — party, single angler, whole totes, all boxes ------------------------------------------
select is(pg_temp.release('s1', '{b1a,b1b}', '[["v1a", 0], ["v1b", null]]', 'REF-P1') ->> 'noop', 'false',
  'P1 — Complete applies');
select is(array[pg_temp.bstate('b1a'), pg_temp.bstate('b1b')], '{picked_up,picked_up}',
  'P1 — every ticked will-call / air box finalises (I3)');
select is(array[pg_temp.vstate('v1a'), pg_temp.vstate('v1b')], '{emptied:0.00:-,emptied:0.00:-}',
  'P1 — whole totes emptied: measure → 0, location cleared (I5/I6)');
select is(array[pg_temp.tag('101'), pg_temp.tag('102')], '{available:-,available:-}', 'P1 — tags freed');
select is((select release_snapshot ->> 'location_code' || '/' || (release_snapshot ->> 'weight_lb')
           from public.vessel where id = pg_temp.id('v1a')), 'IF-A-01-1-F/30.00',
  'P1 — release snapshot keeps weight and location for restore');
select is(pg_temp.istate('i1'), 'done', 'P1 — intake closes: its only pooling session is clear (I10)');
select is((select state::text from public.allocation_session where id = pg_temp.id('s1')), 'done',
  'P1 — session done once its fulfillment rollup is released');
select is(pg_temp.audit('{i1}'), '{finalized:i1:-:s1,moved:i1:v1a:s1,moved:i1:v1b:s1}',
  'P1 — audit: one moved row per vessel, one finalized row per party intake (I9)');
select is((select array_agg(coalesce(payment_ref, '-') order by event_kind) from public.release_audit
           where intake_id = pg_temp.id('i1')), '{-,-,REF-P1}',
  'P1 — the payment ref rides the finalized row only; moved rows carry none (I9/D3)');
select is((select released_by from public.release_audit where intake_id = pg_temp.id('i1') limit 1),
  'a1500000-0000-4000-8000-0000000000e2'::uuid, 'P1 — audit names the operator');
select is(pg_temp.release('s1s', '{b1s}', '[["v1s", 0]]') ->> 'noop', 'false', 'P1 — shared-intake party applies');
select is(pg_temp.istate('i1s'), 'stored',
  'P1 — an intake stays open while ANOTHER session pooling it has planned boxes (I10 d)');

-- P2 — angler A only (B, C later) ------------------------------------------------------------
select pg_temp.release('s2', '{b2a}', '[["v2a", 0]]');
select is(array[pg_temp.bstate('b2a'), pg_temp.bstate('b2b'), pg_temp.bstate('b2c')],
  '{picked_up,planned,planned}', 'P2 — only A''s ticked box finalises; B/C untouched (I3)');
select is(pg_temp.istate('i2'), 'stored', 'P2 — intake stays stored (I10)');
select is((select state::text from public.allocation_session where id = pg_temp.id('s2')), 'priced',
  'P2 — session not done while boxes remain planned');

-- P3 — split tote --------------------------------------------------------------------------
select is(public.release_party('wp15-p3-a', pg_temp.id('s3'), '{}', (select lines from t_p3)) -> 'moved' -> 0 ->> 'action',
  'split', 'P3 — Lbs Left below the measure splits');
select is(pg_temp.vstate('v3'), 'occupied:15.00:-', 'P3 — split stays occupied, measure := R, location cleared');
select is(pg_temp.tag('301'), 'in_use:v3', 'P3 — split keeps the tag');
select is(public.release_party('wp15-p3-b', pg_temp.id('s3'), '{}', (select lines from t_p3)) ->> 'noop', 'true',
  'P3 — re-Complete of the same wizard is a no-op (it saw 40 lb; the basket now holds 15) (D0/I16)');
select is(pg_temp.vstate('v3'), 'occupied:15.00:-', 'P3 — no second split');
select is((select (v ->> 'weight_lb')::numeric from jsonb_array_elements(public.boxing_wizard(pg_temp.id('s3')) -> 'vessels') v),
  15.00, 'P3 — a fresh wizard projects the remainder');
select pg_temp.release('s3', '{b3}', '[["v3", 0]]');
select is(pg_temp.vstate('v3') || '/' || pg_temp.istate('i3'), 'emptied:0.00:-/done',
  'P3 — the remainder is re-actionable in a fresh wizard');
select is(pg_temp.audit('{i3}'), '{finalized:i3:-:s3,moved:i3:v3:s3,moved:i3:v3:s3}',
  'P3 — a split writes a moved row like a full pull');

-- P4 — exchange (untagged) basket -----------------------------------------------------------
select ok(exists (select 1 from jsonb_array_elements(public.boxing_wizard(pg_temp.id('s4')) -> 'vessels') v
                  where (v ->> 'vessel_id')::uuid = pg_temp.id('vex') and (v ->> 'is_exchange')::boolean
                    and v ->> 'tag_code' is null),
  'P4 — the untagged exchange basket is projected (occupied, no tag)');
select pg_temp.release('s4', '{b4}', '[["vex", 0], ["v4", 0]]');
select is(pg_temp.vstate('vex'), 'emptied:0.00:-', 'P4 — exchange basket actionable via lifecycle_state (I6/D1)');
select is(pg_temp.istate('i4'), 'done', 'P4 — never dropped: the intake closes');

-- P5 — box-only return trip (fish freed earlier) -------------------------------------------
select pg_temp.release('s5', '{b5a}', '[["v5", 0]]');
select is(pg_temp.release('s5', '{b5b}') ->> 'noop', 'false', 'P5 — box-only return trip allowed (prior movement)');
select is(pg_temp.bstate('b5b'), 'picked_up', 'P5 — the box finalises');
select is(pg_temp.audit('{i5}'), '{finalized:i5:-:s5,finalized:i5:-:s5,moved:i5:v5:s5}',
  'P5 — audit-logs the box''s party intakes (I9)');
select is(pg_temp.istate('i5'), 'done', 'P5 — the last box closes the intake (I10)');

-- P6 — mixed box + tote in one Complete --------------------------------------------------------
select pg_temp.release('s6', '{b6}', '[["v6a", 0]]', 'REF-P6');
select is(pg_temp.audit('{i6a,i6b}'), '{finalized:i6a:-:s6,finalized:i6b:-:s6,moved:i6a:v6a:s6}',
  'P6 — moved row only for the moved intake; finalized rows for every party intake; no over-stamp (I9)');
select is(pg_temp.vstate('v6b'), 'occupied:15.00:-', 'P6 — the unticked tote is untouched (I1/I4)');

-- P7 — multi-party scan into one wizard -------------------------------------------------------
select matches(pg_temp.err($$select pg_temp.release('s6', '{b2b}')$$), '^22023 .*one party per Complete',
  'P7 — a box of another session raises (I11)');
select is(pg_temp.bstate('b2b'), 'planned', 'P7 — nothing written');

-- P8 — passthrough set + plain storage intake, same customer ---------------------------------
select is(pg_temp.release('s8', '{b8}', '[["v8", 0]]') ->> 'noop', 'false', 'P8 — the party release is allowed');
select is(pg_temp.istate('i8'), 'done', 'P8 — the pooled intake closes through I10');
select is((select state::text from public.storage_intake where id = 'a1500000-0000-4000-8000-0000000008a1'), 'stored',
  'P8 — the storage intake is untouched by the party release');
select pg_temp.as_user('manager');
select lives_ok($$select public.force_release_pickup_batch('wp15-p8-force',
    (public.create_pickup_batch('wp15-p8-batch', 'a1500000-0000-4000-8000-0000000008a1',
       '{a1500000-0000-4000-8000-0000000008b1}') ->> 'batch_id')::uuid, 'manual', 'walk-in pickup')$$,
  'P8 — the storage intake releases through its own pickup batch');
select is((select state::text from public.storage_intake where id = 'a1500000-0000-4000-8000-0000000008a1'), 'released',
  'P8 — and closes by its own gate');
select pg_temp.as_user('staff');

-- P9 — partner-mismatch mis-scan, party unset ------------------------------------------------
select matches(pg_temp.err($$select pg_temp.release('s9', '{}', '[["v9x", 0]]')$$),
  '^22023 .*Olga Other.*not this party', 'P9 — party falls back to the first intake''s customer; mismatch raises (I11/D4)');
select is(pg_temp.vstate('v9x'), 'occupied:10.00:-', 'P9 — nothing written');

-- P10 — ship box 2+ days out ------------------------------------------------------------------
insert into t_res select 'p10', pg_temp.release('s10', '{b10}', '[["v10", 0]]');
select is(pg_temp.bstate('b10'), 'packed', 'P10 — the ship box packs');
select is((select r -> 'shipping' -> 0 -> 'gate' from t_res where k = 'p10'),
  '{"held": true, "blockers": [], "can_buy": false, "can_reprint": false}'::jsonb,
  'P10 — the label is held and reported as info');
select ok((select r -> 'shipping' -> 0 ->> 'notice' from t_res where k = 'p10') ~ 'held',
  'P10 — the Complete reply carries the held notice (nothing swallows it)');

-- P11 — held AND a real blocker -----------------------------------------------------------------
insert into t_res select 'p11', pg_temp.release('s11', '{b11}', '[["v11", 0]]');
select is((select r -> 'shipping' -> 0 -> 'gate' from t_res where k = 'p11'),
  '{"held": true, "blockers": ["bad_address", "no_service"], "can_buy": false, "can_reprint": false}'::jsonb,
  'P11 — held and blocked are both reported (I13b)');

-- P12 — manager needs the held label now ---------------------------------------------------------
select matches(pg_temp.err($$select public.shipment_buy_check(pg_temp.id('sh10'), true)$$), '^42501',
  'P12 — staff cannot force a held buy');
select pg_temp.as_user('manager');
select is(public.shipment_buy_check(pg_temp.id('sh10'), true) -> 'gate',
  '{"held": false, "blockers": [], "can_buy": true, "can_reprint": false}'::jsonb,
  'P12 — Buy Now clears the hold (I14)');
select is(public.shipment_buy_check(pg_temp.id('sh11'), true) -> 'gate',
  '{"held": false, "blockers": ["bad_address", "no_service"], "can_buy": false, "can_reprint": false}'::jsonb,
  'P12 — Buy Now preserves every non-date blocker (I14)');
select pg_temp.as_user('staff');

-- P13 — storage-only (no settlement): the base path ---------------------------------------------
select pg_temp.as_user('manager');
select is(pg_temp.by_tag('1301') ->> 'action', 'full_pull', 'P13 — an unpooled basket releases by tag');
select is(pg_temp.istate('i13'), 'stored', 'P13 — intake stays open while a basket remains');
select is(pg_temp.by_tag('1302') -> 'warnings', '[]'::jsonb, 'P13 — no party warning: nothing pools it (I12)');
select is(pg_temp.istate('i13'), 'done', 'P13 — closes through the same I10 gate (zero pooling sessions)');
select is(pg_temp.audit('{i13}'), '{moved:i13:v13a:-,moved:i13:v13b:-}', 'P13 — moved rows carry no session');
select pg_temp.as_user('staff');

-- P14 — re-Complete a completed wizard (browser back) ----------------------------------------------
insert into t_res select 'p14', pg_temp.release('s1', '{b1a,b1b}', '[["v1a", 0], ["v1b", 0]]');
select is((select r ->> 'noop' from t_res where k = 'p14'), 'true',
  'P14 — re-Complete no-ops via current-state actionability (D0/I16)');
select is((select count(*)::int from jsonb_array_elements((select r -> 'stale' from t_res where k = 'p14'))), 4,
  'P14 — the stale selections are reported');
select is(cardinality(pg_temp.audit('{i1}')), 3, 'P14 — no second audit row');
select is(public.release_party('wp15-p14-replay', pg_temp.id('s2'), array[pg_temp.id('b2b')], '[]') ->> 'noop', 'false',
  'P14 — first send of an action id applies');
select is(public.release_party('wp15-p14-replay', pg_temp.id('s2'), array[pg_temp.id('b2b')], '[]') ->> 'noop', 'false',
  'P14 — a replayed action id returns its stored reply');
select is((select count(*)::int from public.release_audit where intake_id = pg_temp.id('i2') and event_kind = 'finalized'),
  2, 'P14 — the replay writes nothing');

-- P15 — additive re-scan mid-tick: the projection drops finalised boxes / non-occupied vessels ---
select is((select array_agg((select k from t_ids where v = (b ->> 'box_id')::uuid) order by b ->> 'number')
           from jsonb_array_elements(public.boxing_wizard(pg_temp.id('s2')) -> 'boxes') b), '{b2c}',
  'P15 — only currently planned boxes are projected (I15)');
select is((select array_agg((select k from t_ids where v = (x ->> 'vessel_id')::uuid))
           from jsonb_array_elements(public.boxing_wizard(pg_temp.id('s2')) -> 'vessels') x), '{v2b}',
  'P15 — only currently occupied vessels are projected (I15)');

-- P16 — reopen from the queue = fresh projection ---------------------------------------------
select is((select fulfillment_status::text from public.allocation_session_list where session_id = pg_temp.id('s2')),
  'partial', 'P16 — the queue shows the party partly released');
select is((select (w ->> 'moved_before')::boolean from (select public.boxing_wizard(pg_temp.id('s2')) w) x), true,
  'P16 — the projection is rebuilt from committed state (nothing transient to lose) (D0)');

-- P17 — tote-only release ----------------------------------------------------------------------
select pg_temp.release('s17', '{}', '[["v17a", 0], ["v17b", 10]]');
select is(array[pg_temp.vstate('v17a'), pg_temp.vstate('v17b')], '{emptied:0.00:-,occupied:10.00:-}',
  'P17 — totes empty / split');
select is(pg_temp.bstate('b17'), 'planned', 'P17 — boxes stay planned (I1)');
select is(pg_temp.audit('{i17}'), '{moved:i17:v17a:s17,moved:i17:v17b:s17}', 'P17 — movement audited');
select is(pg_temp.istate('i17'), 'stored', 'P17 — I10 decides the intake: still a basket and a planned box');

-- P18 — two fresh wizards, same party (sequential loser; the race is in the db suite) -----------
select pg_temp.release('sr', '{br}', '[["vr", 0]]');
select is(pg_temp.release('sr', '{br}', '[["vr", 0]]') ->> 'noop', 'true',
  'P18 — the second wizard re-reads, finds nothing actionable and no-ops (D0/I16)');
select is(cardinality(pg_temp.audit('{ir}')), 2, 'P18 — no double release');

-- P19 — unticked tote carries a remainder ---------------------------------------------------------
select matches(pg_temp.err($$select pg_temp.release('s19', '{b19}', '[["v19a", 0], ["v19b", 5, false]]')$$),
  '^22023 .*Lbs Left on an unticked line', 'P19 — the remainder is rejected, never inferred (I5)');
select is(array[pg_temp.vstate('v19a'), pg_temp.vstate('v19b'), pg_temp.bstate('b19')],
  '{occupied:10.00:-,occupied:10.00:-,planned}', 'P19 — abort writes nothing (I16a)');
select is(pg_temp.release('s19', '{b19}', '[["v19a", 0], ["v19b", 0, false]]') ->> 'noop', 'false',
  'P19 — a cleared unticked line is fine');
select is(pg_temp.vstate('v19b'), 'occupied:10.00:-', 'P19 — the unticked tote is not acted on (I4)');

-- P20 — intake pooled in ANOTHER active session ------------------------------------------------
select matches(pg_temp.err($$select pg_temp.release('s20', '{}', '[["v20x", 0]]')$$), '^22023 .*pooled in ALC-',
  'P20 — rejected: outside this party even though the partner matches (I17)');
select is(pg_temp.vstate('v20x'), 'occupied:10.00:-', 'P20 — nothing written');

-- P21 — intake with zero vessels -----------------------------------------------------------------
select pg_temp.release('s21', '{b21}', '[["v21", 0]]');
select is(array[pg_temp.istate('i21'), pg_temp.istate('i21b')], '{stored,done}',
  'P21 — the zero-vessel intake never auto-closes; its sibling does (I10 b)');

-- P22 — selected record changed before Complete -----------------------------------------------------
reset role;
update public.box_plan set fulfillment_state = 'picked_up' where id = pg_temp.id('b22a');
update public.vessel set weight_lb = 7 where id = pg_temp.id('v22c');
set local role authenticated;
select pg_temp.as_user('manager');
select pg_temp.by_tag('2201');
select pg_temp.as_user('staff');
insert into t_res select 'p22', public.release_party(gen_random_uuid()::text, pg_temp.id('s22'),
  array[pg_temp.id('b22a'), pg_temp.id('b22b')],
  jsonb_build_array(jsonb_build_object('vessel_id', pg_temp.id('v22a'), 'lbs_left', 0, 'measure', 10),
                    jsonb_build_object('vessel_id', pg_temp.id('v22b'), 'lbs_left', 0, 'measure', 10),
                    jsonb_build_object('vessel_id', pg_temp.id('v22c'), 'lbs_left', 5, 'measure', 10)));
select is((select array_agg(k order by k) from jsonb_array_elements((select r -> 'stale' from t_res where k = 'p22')) s
           join t_ids on v = (s ->> 'id')::uuid), '{b22a,v22a,v22c}',
  'P22 — preflight reports each changed record (I16)');
select is(array[pg_temp.bstate('b22b'), pg_temp.vstate('v22b'), pg_temp.vstate('v22c')],
  '{picked_up,emptied:0.00:-,occupied:7.00:-}', 'P22 — the rest applies; the changed basket is not split');
select is((select count(*)::int from public.release_audit where vessel_id = pg_temp.id('v22a')), 1,
  'P22 — no partial write to a stale record');
select is((select detail -> 'box_numbers' from public.release_audit
           where session_id = pg_temp.id('s22') and event_kind = 'finalized'),
  (select jsonb_build_array(number) from public.box_plan where id = pg_temp.id('b22b')),
  'P22 — the finalized row names only the box this Complete finalised');

-- P23 — ship box missing ship date ----------------------------------------------------------------
insert into t_res select 'p23', pg_temp.release('s23', '{b23}', '[["v23", 0]]');
select is(pg_temp.bstate('b23'), 'packed', 'P23 — the pack completes');
select is((select r -> 'shipping' -> 0 -> 'gate' from t_res where k = 'p23'),
  '{"held": false, "blockers": ["missing_ship_date"], "can_buy": false, "can_reprint": false}'::jsonb,
  'P23 — the buy is blocked and reported (I13)');

-- P24 — reprint an already-bought future-dated label ------------------------------------------------
select is(public.shipment_buy_check(pg_temp.id('sh24')) -> 'gate',
  '{"held": false, "blockers": [], "can_buy": false, "can_reprint": true}'::jsonb,
  'P24 — reprint allowed: the hold applies to buying, not printing (I13)');

-- I7 / I8 / I16 / I17 ---------------------------------------------------------------------------
select is(pg_temp.release('s2', '{}') ->> 'noop', 'true', 'I7 — Complete with nothing ticked is a no-op');
select matches(pg_temp.err($$select pg_temp.release('s19', '{}', '[["v19b", -1]]')$$), '^22023 .*negative',
  'I16 — negative Lbs Left aborts');
select matches(pg_temp.err($$select pg_temp.release('s19', '{}', '[["v19b", 0.004]]')$$), '^22023 .*2 decimal',
  'I5 — a remainder finer than hundredths aborts (never split and rounded to 0.00)');
select matches(pg_temp.err($$select pg_temp.release('s19', '{}', '[["v19b", 9.996]]')$$), '^22023 .*2 decimal',
  'I5 — 9.996 of 10 lb aborts rather than a no-change split that counts as movement');
select is(pg_temp.vstate('v19b'), 'occupied:10.00:-', 'I5 — precision aborts write nothing');
select matches(pg_temp.err($$select pg_temp.release('s19', '{}', '[["v19b", 10]]')$$), '^22023 .*less than',
  'I16 — split at the current measure aborts');
select matches(pg_temp.err($$select public.release_party(gen_random_uuid()::text, pg_temp.id('s19'), '{}',
    jsonb_build_array(jsonb_build_object('vessel_id', pg_temp.id('v19b'), 'lbs_left', 0)))$$),
  '^22023 .*measure', 'I16 — a ticked line must carry the weight the screen showed (stale-by-weight check)');
select matches(pg_temp.err($$select pg_temp.release('sc', '{bc}', '[["vc", 0]]')$$), '^55000 .*cancelled',
  'I16/I17 — a cancelled session is never releasable');
reset role;
update public.vessel set lifecycle_state = 'void' where id = pg_temp.id('v2b');
set local role authenticated;
select is((select jsonb_agg(s ->> 'state') from jsonb_array_elements(
             pg_temp.release('s2', '{}', '[["v2b", 0]]') -> 'stale') s), '["void"]'::jsonb,
  'I6 — a void vessel is never actionable (dropped, reported)');

-- I8: box finalisation with no movement for the party
reset role;
select pg_temp.intake('i8b'); select pg_temp.vessel('v8b', 'i8b', 11, '8101');
select pg_temp.session('s8b', '{i8b}'); select pg_temp.box('b8b1', 's8b', 'Ann'); select pg_temp.box('b8b2', 's8b', 'Ann');
set local role authenticated;
select matches(pg_temp.err($$select pg_temp.release('s8b', '{b8b1}')$$), '^55000 .*no fish has moved',
  'I8 — finalising a box with no tote ticked and no prior movement is a hard block');
select is(pg_temp.bstate('b8b1'), 'planned', 'I8 — the block writes nothing');
select pg_temp.release('s8b', '{}', '[["v8b", 0]]');
select pg_temp.as_user('manager');
select is(public.restore_vessel('wp15-i8-restore', pg_temp.id('v8b'), 'wrong basket') ->> 'restored', 'true',
  'RESTORE — a manager restores the emptied basket');
select pg_temp.as_user('staff');
select matches(pg_temp.err($$select pg_temp.release('s8b', '{b8b1}')$$), '^55000 .*no fish has moved',
  'I8 — a restore nets the movement out (moved − restored)');
select is(pg_temp.release('s8b', '{b8b1}', '[["v8b", 0]]') ->> 'noop', 'false', 'I8 — ticking a tote unblocks');
select is(pg_temp.release('s8b', '{b8b2}') ->> 'noop', 'false', 'I8 — later box-only trips ride the net movement');

-- I8 manager override (decided on PR #67): a co-pooling party whose shared intake's last
-- basket was released by another party, or by an unattributed tag release, has no tote left.
reset role;
create function pg_temp.override(p_session text, p_boxes text[], p_reason text) returns jsonb language sql as $$
  select public.release_party(gen_random_uuid()::text, pg_temp.id(p_session),
    (select array_agg(pg_temp.id(b)) from unnest(p_boxes) b), '[]', null, null, p_reason)
$$;
grant execute on function pg_temp.override(text, text[], text) to authenticated;
-- The HINT the boxing screen branches on (never the English message).
create function pg_temp.hint(p_sql text) returns text language plpgsql as $$
declare h text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return h;
end $$;
grant execute on function pg_temp.hint(text) to authenticated;
set local role authenticated;
select pg_temp.as_user('staff');
select is((select count(*)::int from public.vessel where intake_id = pg_temp.id('i1s') and lifecycle_state = 'occupied'),
  0, 'I8 OVERRIDE — s1s released i1s''s only basket: s1o has no tote left to tick');
select matches(pg_temp.err($$select pg_temp.release('s1o', '{b1o}')$$), '^55000 .*ask a manager to override',
  'I8 OVERRIDE — without the override s1o''s box is blocked (I8 as written)');
select is(pg_temp.hint($$select pg_temp.release('s1o', '{b1o}')$$), 'i8_override_available',
  'I8 OVERRIDE — the no-tote refusal carries the machine-readable hint the screen keys on');
select matches(pg_temp.err($$select pg_temp.override('s1o', '{b1o}', 'fish left with ALC s1s')$$), '^42501',
  'I8 OVERRIDE — staff cannot override');
select pg_temp.as_user('manager');
select matches(pg_temp.err($$select pg_temp.override('s1o', '{b1o}', '  ')$$), '^22023 .*reason',
  'I8 OVERRIDE — needs a reason');
select is(pg_temp.override('s1o', '{b1o}', 'fish left with the other party') ->> 'i8_override', 'true',
  'I8 OVERRIDE — a manager completes the remaining co-pooling party');
select is(pg_temp.bstate('b1o') || '/' || pg_temp.istate('i1s'), 'picked_up/done',
  'I8 OVERRIDE — the box finalises and the shared intake closes (I10)');
select is((select concat_ws('/', detail -> 'i8_override' ->> 'reason', detail -> 'i8_override' ->> 'approved_by',
                            detail -> 'i8_override' ->> 'via')
           from public.release_audit where session_id = pg_temp.id('s1o') and event_kind = 'finalized'),
  'fish left with the other party/a1500000-0000-4000-8000-0000000000e1/manager_session',
  'I8 OVERRIDE — who approved, the reason and how are on the finalized audit row');

reset role;
select pg_temp.intake('i_two'); select pg_temp.vessel('v_two', 'i_two', 9, '7201');
select pg_temp.session('s_two_a', '{i_two}'); select pg_temp.box('b_two_a', 's_two_a', 'Ann');
select pg_temp.session('s_two_b', '{i_two}'); select pg_temp.box('b_two_b', 's_two_b', 'Bea');
set local role authenticated;
select pg_temp.as_user('manager');
select ok((pg_temp.by_tag('7201') ->> 'warnings') ~ 'pooled in ALC-.*, ALC-',
  'I8 OVERRIDE — tag release with two active pooling parties warns and attributes no session');
select is(pg_temp.audit('{i_two}'), '{moved:i_two:v_two:-}', 'I8 OVERRIDE — the movement row has no session');
select pg_temp.as_user('staff');
select matches(pg_temp.err($$select pg_temp.release('s_two_a', '{b_two_a}')$$), '^55000 .*I8',
  'I8 OVERRIDE — after an unattributed tag release both parties are blocked');
select pg_temp.as_user('manager');
select lives_ok($$select pg_temp.override('s_two_a', '{b_two_a}', 'released by tag')$$,
  'I8 OVERRIDE — the manager completes the first party');
select is(pg_temp.istate('i_two'), 'stored', 'I8 OVERRIDE — still open while the second party has a planned box (I10 d)');
select lives_ok($$select pg_temp.override('s_two_b', '{b_two_b}', 'released by tag')$$,
  'I8 OVERRIDE — and the second');
select is(pg_temp.istate('i_two'), 'done', 'I8 OVERRIDE — the shared intake closes once both parties are clear');
select pg_temp.as_user('staff');

-- DECISION-23 covers only the dead end: with a tote still in the freezer, I8 stays hard.
reset role;
select pg_temp.intake('i_left'); select pg_temp.vessel('v_left', 'i_left', 6, '7401');
select pg_temp.session('s_left', '{i_left}'); select pg_temp.box('b_left', 's_left', 'Ann');
set local role authenticated;
select pg_temp.as_user('staff');
select matches(pg_temp.err($$select pg_temp.release('s_left', '{b_left}')$$), '^55000 .*tick the totes being handed over before finalising boxes \(I8\)',
  'I8 OVERRIDE — with a tote left, the refusal does not offer an override');
select is(pg_temp.hint($$select pg_temp.release('s_left', '{b_left}')$$), 'i8_tote_left',
  'I8 OVERRIDE — the tote-left refusal carries its own hint (never i8_override_available)');
select pg_temp.as_user('manager');
select matches(pg_temp.err($$select pg_temp.override('s_left', '{b_left}', 'forgot to tick')$$),
  '^55000 .*still has a tote to tick \(Tag 7401 .*DECISION-23',
  'I8 OVERRIDE — refused while the party still has an occupied tote');
select is(pg_temp.hint($$select pg_temp.override('s_left', '{b_left}', 'forgot to tick')$$), 'i8_tote_left',
  'I8 OVERRIDE — a refused override carries the tote-left hint (the screen points at the freezer)');
select is(pg_temp.bstate('b_left') || '/' || pg_temp.vstate('v_left') || '/' || cardinality(pg_temp.audit('{i_left}')),
  'planned/occupied:6.00:-/0', 'I8 OVERRIDE — the refused override writes nothing');
select pg_temp.as_user('staff');

-- I8 override from a station: staff + a manager's PIN elevation (the grant is recorded).
reset role;
select pg_temp.intake('i_el'); select pg_temp.vessel('v_el', 'i_el', 8, '7301');
select pg_temp.session('s_el_a', '{i_el}'); select pg_temp.box('b_el_a', 's_el_a', 'Ann');
select pg_temp.session('s_el_b', '{i_el}'); select pg_temp.box('b_el_b', 's_el_b', 'Bea');
insert into public.elevation_grant (id, org_id, requested_by, manager_member_id, token_hash, expires_at)
values ('a1500000-0000-4000-8000-0000000000d1', 'a1500000-0000-4000-8000-00000000000a',
        'a1500000-0000-4000-8000-0000000000f2', 'a1500000-0000-4000-8000-0000000000e1',
        app.sha256_hex('wp15-i8-elevation'), now() + interval '10 minutes');
create function pg_temp.override_tok(p_session text, p_boxes text[], p_reason text, p_token text) returns jsonb
language sql as $$
  select public.release_party(gen_random_uuid()::text, pg_temp.id(p_session),
    (select array_agg(pg_temp.id(b)) from unnest(p_boxes) b), '[]', null, null, p_reason, p_token)
$$;
grant execute on function pg_temp.override_tok(text, text[], text, text) to authenticated;
set local role authenticated;
select pg_temp.as_user('staff');
select is(pg_temp.release('s_el_a', '{b_el_a}', '[["v_el", 0]]') ->> 'noop', 'false',
  'I8 OVERRIDE — the other party empties the shared intake''s last basket');
select matches(pg_temp.err($$select pg_temp.release('s_el_b', '{b_el_b}')$$), '^55000 .*I8',
  'I8 OVERRIDE — the remaining party is blocked');
select matches(pg_temp.err($$select pg_temp.override_tok('s_el_b', '{b_el_b}', 'other party took it', 'not-a-token')$$),
  '^42501', 'I8 OVERRIDE — a bad elevation token is refused');
select is(pg_temp.override_tok('s_el_b', '{b_el_b}', 'other party took it', 'wp15-i8-elevation') ->> 'i8_override', 'true',
  'I8 OVERRIDE — staff at a station finalise with a manager''s PIN elevation');
select is((select concat_ws('/', detail -> 'i8_override' ->> 'via', detail -> 'i8_override' ->> 'elevation_grant_id',
                            detail -> 'i8_override' ->> 'approved_by', detail -> 'i8_override' ->> 'requested_by')
           from public.release_audit where session_id = pg_temp.id('s_el_b') and event_kind = 'finalized'),
  'elevation/a1500000-0000-4000-8000-0000000000d1/a1500000-0000-4000-8000-0000000000e1/a1500000-0000-4000-8000-0000000000e2',
  'I8 OVERRIDE — the audit row names the elevation grant, the approving manager and the requesting operator');
select ok((select position('wp15-i8-elevation' in detail::text) = 0 from public.release_audit
           where session_id = pg_temp.id('s_el_b') and event_kind = 'finalized'),
  'I8 OVERRIDE — the token itself is never stored');
select is(pg_temp.istate('i_el'), 'done', 'I8 OVERRIDE — the shared intake closes (I10)');

-- Restore -----------------------------------------------------------------------------------------
select is(pg_temp.audit('{i8b}'), '{finalized:i8b:-:s8b,finalized:i8b:-:s8b,moved:i8b:v8b:s8b,moved:i8b:v8b:s8b,restored:i8b:v8b:s8b}',
  'RESTORE — append-only: the restore is its own row, attributed to the netting party');
select pg_temp.as_user('manager');
select is(public.restore_vessel('wp15-restore-1', pg_temp.id('v1a'), 'mis-scan') -> 'warnings', '[]'::jsonb,
  'RESTORE — restores cleanly when the tag and shelf are free');
select is(pg_temp.vstate('v1a') || '/' || pg_temp.tag('101'), 'occupied:30.00:IF-A-01-1-F/in_use:v1a',
  'RESTORE — weight, location and tag come back from the snapshot');
select is(pg_temp.istate('i1'), 'stored', 'RESTORE — a closed intake reopens to stored (a basket is occupied again)');
select is(public.restore_vessel('wp15-restore-1', pg_temp.id('v1a'), 'mis-scan') ->> 'restored', 'true',
  'RESTORE — replay returns the stored reply');
select is(public.restore_vessel('wp15-restore-2', pg_temp.id('v1a'), 'again') ->> 'restored', 'false',
  'RESTORE — an occupied basket is a no-op');
reset role;
select pg_temp.intake('i_rebind'); select pg_temp.vessel('v_rebind', 'i_rebind', 5, null);
set local role authenticated;
select pg_temp.as_user('staff');
select pg_temp.release('s8b', '{}', '[["v8b", 0]]');
reset role;
update public.asset_tag set state = 'in_use', current_vessel_id = pg_temp.id('v_rebind') where code = '8101';
set local role authenticated;
select pg_temp.as_user('manager');
select ok((public.restore_vessel('wp15-restore-3', pg_temp.id('v8b'), 'came back') ->> 'warnings') ~ 'Tag 8101',
  'RESTORE — warn, not block, when the tag went to another basket');
select is((select asset_tag_id from public.vessel where id = pg_temp.id('v8b')), null::uuid,
  'RESTORE — the restored basket is untagged; the tag stays with its new holder');
select pg_temp.as_user('staff');
select matches(pg_temp.err($$select public.restore_vessel('wp15-restore-4', pg_temp.id('v1b'), 'x')$$), '^42501',
  'RESTORE — manager only');

-- Release-by-Tag ------------------------------------------------------------------------------------
select matches(pg_temp.err($$select pg_temp.by_tag('202')$$), '^42501', 'BY TAG — manager only');
select pg_temp.as_user('manager');
select matches(pg_temp.err($$select pg_temp.by_tag('1101', 0, ' ')$$), '^22023 .*reason', 'BY TAG — a reason is required');
reset role;
select pg_temp.intake('it'); select pg_temp.vessel('vt', 'it', 20, '7001'); select pg_temp.session('st', '{it}');
select pg_temp.box('bt', 'st', 'Ann');
set local role authenticated;
select pg_temp.as_user('manager');
insert into t_res select 'bytag', pg_temp.by_tag('07001', 8);
select is((select r ->> 'action' from t_res where k = 'bytag'), 'split', 'BY TAG — splits (padding normalised)');
select ok((select r ->> 'warnings' from t_res where k = 'bytag') ~ 'pooled in ALC-',
  'BY TAG — cross-party is warn-not-block');
select is(pg_temp.audit('{it}'), '{moved:it:vt:st}', 'BY TAG — attributed to the single active pooling party');
select is(pg_temp.by_tag('7001') ->> 'action', 'full_pull', 'BY TAG — full pull');
select is(pg_temp.by_tag('7001') ->> 'noop', 'true', 'BY TAG — an already-freed tag is a no-op (D0)');
select is(pg_temp.release('st', '{bt}') ->> 'noop', 'false', 'BY TAG — its movement unblocks the party''s boxes (I8)');

-- I10 a: state gate; blast_freezer also closes -----------------------------------------------------
reset role;
select pg_temp.intake('ib', 'pat', 'blast_freezer'); select pg_temp.vessel('vb', 'ib', 5, '7101');
set local role authenticated;
select pg_temp.as_user('manager');
select pg_temp.by_tag('7101');
select is(pg_temp.istate('ib'), 'done', 'I10 — blast_freezer closes through the gate too');

-- Tenancy ------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', 'a1500000-0000-4000-8000-0000000000f9',
  'role', 'authenticated', 'org_id', 'b1500000-0000-4000-8000-00000000000b', 'app_role', 'manager')::text, true);
select matches(pg_temp.err($$select pg_temp.release('s2', '{b2c}')$$), '^P0002', 'TENANCY — another org cannot release');
select matches(pg_temp.err($$select public.boxing_wizard(pg_temp.id('s2'))$$), '^P0002',
  'TENANCY — another org cannot project');

select * from finish();
rollback;
