-- Issue #96: the "now in blast" lines are scoped to the station's site. A paired device bound to
-- a site sees only its site's intakes; a manager in Admin (no device) sees every site. The view
-- stays security_invoker and filters by site; no RLS rule is added.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Fixture ------------------------------------------------------------------------------------
-- One org, two sites (North, South), a station device at each, a device with no site, a manager.
insert into public.org(id,slug,name,timezone) values
 ('a9600000-0000-4000-8000-00000000000a','blast-site-a','Blast site A','UTC');
insert into public.site(id,org_id,name) values
 ('a9600000-0000-4000-8000-000000000001','a9600000-0000-4000-8000-00000000000a','North'),
 ('a9600000-0000-4000-8000-000000000002','a9600000-0000-4000-8000-00000000000a','South');
insert into public.customer(id,org_id,name) values
 ('a9600000-0000-4000-8000-000000000003','a9600000-0000-4000-8000-00000000000a','Blast site customer');
insert into auth.users(id,email) values
 ('a9600000-0000-4000-8000-0000000000a1','blast-site-manager@example.test');
insert into public.org_member(id,org_id,user_id,role,display_name) values
 ('a9600000-0000-4000-8000-0000000000b1','a9600000-0000-4000-8000-00000000000a','a9600000-0000-4000-8000-0000000000a1','manager','Blast site manager');
insert into public.device(id,org_id,name,station,site_id) values
 ('a9600000-0000-4000-8000-0000000000d1','a9600000-0000-4000-8000-00000000000a','North blast','blast','a9600000-0000-4000-8000-000000000001'),
 ('a9600000-0000-4000-8000-0000000000d2','a9600000-0000-4000-8000-00000000000a','South reconcile','reconcile','a9600000-0000-4000-8000-000000000002'),
 ('a9600000-0000-4000-8000-0000000000d3','a9600000-0000-4000-8000-00000000000a','Spare tablet','blast',null);

-- INT-0001, INT-0002 at North and INT-0003 at South in the blast; INT-0004 at North still at
-- reconcile (never a line).
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a9600000-0000-4000-8000-000000000011','a9600000-0000-4000-8000-00000000000a','INT-0001','a9600000-0000-4000-8000-000000000003','a9600000-0000-4000-8000-000000000001',1),
 ('a9600000-0000-4000-8000-000000000012','a9600000-0000-4000-8000-00000000000a','INT-0002','a9600000-0000-4000-8000-000000000003','a9600000-0000-4000-8000-000000000001',1),
 ('a9600000-0000-4000-8000-000000000013','a9600000-0000-4000-8000-00000000000a','INT-0003','a9600000-0000-4000-8000-000000000003','a9600000-0000-4000-8000-000000000002',1),
 ('a9600000-0000-4000-8000-000000000014','a9600000-0000-4000-8000-00000000000a','INT-0004','a9600000-0000-4000-8000-000000000003','a9600000-0000-4000-8000-000000000001',1);
update public.intake set state='holding' where org_id='a9600000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a9600000-0000-4000-8000-00000000000a';
update public.intake set state='rollstock' where org_id='a9600000-0000-4000-8000-00000000000a';
update public.intake set state='reconcile' where org_id='a9600000-0000-4000-8000-00000000000a';
update public.intake set state='blast_freezer' where org_id='a9600000-0000-4000-8000-00000000000a' and number<>'INT-0004';

create function pg_temp.lines() returns text[] language sql as $$
  select coalesce(array_agg(intake_number order by intake_number),'{}') from public.now_in_blast $$;
create function pg_temp.as_device(p_device text) returns void language sql as $$
  select set_config('request.jwt.claims','{"sub":"a9600000-0000-4000-8000-0000000000ff","role":"authenticated","org_id":"a9600000-0000-4000-8000-00000000000a","app_role":"station","device_id":"'||p_device||'"}',true) $$;

set local role authenticated;

-- Stations ----------------------------------------------------------------------------------
select pg_temp.as_device('a9600000-0000-4000-8000-0000000000d1');
select is(pg_temp.lines(),'{INT-0001,INT-0002}'::text[],'NB1 the North station sees only North''s lines');
select is(app.station_site_id(),'a9600000-0000-4000-8000-000000000001'::uuid,'NB1 the station''s site is its device''s site');

select pg_temp.as_device('a9600000-0000-4000-8000-0000000000d2');
select is(pg_temp.lines(),'{INT-0003}'::text[],'NB2 the South station sees only South''s lines');

select pg_temp.as_device('a9600000-0000-4000-8000-0000000000d3');
select is(pg_temp.lines(),'{INT-0001,INT-0002,INT-0003}'::text[],'NB3 a device with no site sees every site');

-- Admin -------------------------------------------------------------------------------------
select set_config('request.jwt.claims','{"sub":"a9600000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a9600000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
select is(pg_temp.lines(),'{INT-0001,INT-0002,INT-0003}'::text[],'NB4 a manager in Admin sees both sites');
select is(app.station_site_id(),null::uuid,'NB4 a caller with no device has no station site');

-- Another org's device never reads this org's lines (RLS, unchanged).
select set_config('request.jwt.claims','{"sub":"b9600000-0000-4000-8000-0000000000ff","role":"authenticated","org_id":"b9600000-0000-4000-8000-00000000000b","app_role":"station","device_id":"a9600000-0000-4000-8000-0000000000d1"}',true);
select is(pg_temp.lines(),'{}'::text[],'NB5 another org sees no lines, even naming this org''s device');

reset role;

-- Shape -------------------------------------------------------------------------------------
select ok((select 'security_invoker=true'=any(reloptions) from pg_class where oid='public.now_in_blast'::regclass),
  'NB6 now_in_blast stays security_invoker');
select ok(not (select prosecdef from pg_proc where oid='app.station_site_id()'::regprocedure),
  'NB6 the site filter reads under the caller''s RLS (not security definer)');

select * from finish();
rollback;
