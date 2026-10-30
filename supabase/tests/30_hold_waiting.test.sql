-- Issue #93 (docs/08 DECISION-27): an order whose own hold is still active, though it is back
-- within the limit, is refused with what the hold waits on: each blocking neighbour, in
-- rollstock order, and why it blocks (not at reconcile yet / not weighed yet / its variance).
-- The list and text are rules (variance.ts holdWaitingOn / holdWaitingMessage), generated.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Fixture ------------------------------------------------------------------------------------
-- INT-0001..0004 each expect 50 lb (100 lb × 0.5): ±15% is 42.5–57.5 lb. Opened at rollstock
-- INT-0001, INT-0002, INT-0004, INT-0003; INT-0003 is still open at rollstock.
insert into public.org(id,slug,name,timezone) values
 ('a3000000-0000-4000-8000-00000000000a','hold-waiting','Hold waiting','UTC');
insert into public.site(id,org_id,name) values ('a3000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a3000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-00000000000a','Hold customer');
insert into public.species(org_id,code,name,"group") values ('a3000000-0000-4000-8000-00000000000a','salmon','Salmon','salmon');
insert into public.incoming_condition(org_id,code,name) values ('a3000000-0000-4000-8000-00000000000a','whole','Whole');
insert into public.processing_method(org_id,code,name) values ('a3000000-0000-4000-8000-00000000000a','fillets','Fillets');
insert into auth.users(id,email) values ('a3000000-0000-4000-8000-0000000000a1','hold-waiting-manager@example.test');
insert into public.org_member(id,org_id,user_id,role,display_name) values
 ('a3000000-0000-4000-8000-0000000000b1','a3000000-0000-4000-8000-00000000000a','a3000000-0000-4000-8000-0000000000a1','manager','Hold manager');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count)
select ('a3000000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,'a3000000-0000-4000-8000-00000000000a',
  'INT-000'||n,'a3000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000001',1
from generate_series(1,4) n;
insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
select org_id,id,'salmon','whole','fillets',100,0.5 from public.intake where org_id='a3000000-0000-4000-8000-00000000000a';
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr)
select org_id,id,1,1,'FL:TOTE:'||number||':1' from public.intake where org_id='a3000000-0000-4000-8000-00000000000a';
update public.intake set state='holding' where org_id='a3000000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a3000000-0000-4000-8000-00000000000a';

create temp table ids(k text primary key, v uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v from ids where k=p_k $$;
create function pg_temp.intake(p_number text) returns uuid language sql as $$
  select id from public.intake where number=p_number and org_id='a3000000-0000-4000-8000-00000000000a' $$;
-- One reconcile basket (exchange, no tag needed) weighed manually.
create function pg_temp.weigh(p_number text, p_lb numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.reconcile_action('v93-hw-ex-'||p_number,pg_temp.intake(p_number),'exchange');
  insert into ids values ('vessel-'||p_number,(r->>'vessel_id')::uuid);
  return public.reconcile_action('v93-hw-w-'||p_number,pg_temp.intake(p_number),'manual',p_vessel_id=>(r->>'vessel_id')::uuid,p_weight=>p_lb);
end $$;
create function pg_temp.reweigh(p_number text, p_lb numeric, p_key text) returns jsonb language sql as $$
  select public.reconcile_action(p_key,pg_temp.intake(p_number),'manual',p_vessel_id=>pg_temp.id('vessel-'||p_number),p_weight=>p_lb)
$$;
create function pg_temp.send(p_number text, p_key text) returns jsonb language sql as $$
  select public.send_to_blast(p_key,pg_temp.intake(p_number))
$$;
create function pg_temp.scan(p_raw text, p_open text, p_key text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.rollstock_scan_advance(p_raw,pg_temp.intake(p_open),p_key);
  if r->>'scan_id' is not null then insert into ids values (p_key,(r->>'scan_id')::uuid); end if;
  return r;
end $$;

select set_config('request.jwt.claims','{"sub":"a3000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a3000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select pg_temp.scan('FL:TOTE:INT-0001:1',null,'v93-hw-rs-1');
select pg_temp.scan('FL:TOTE:INT-0002:1','INT-0001','v93-hw-rs-2');
select pg_temp.scan('FL:TOTE:INT-0004:1','INT-0002','v93-hw-rs-3');
select pg_temp.scan('FL:TOTE:INT-0003:1','INT-0004','v93-hw-rs-4');
reset role;
update public.scan_log s set scanned_at='2026-08-01 08:00Z'::timestamptz+(substr(k,11)::int*interval '1 minute')
from ids where ids.v=s.id and ids.k like 'v93-hw-rs-_';
set local role authenticated;
select is((select array_agg(number order by number) from public.intake where state='reconcile' and org_id='a3000000-0000-4000-8000-00000000000a'),
  '{INT-0001,INT-0002,INT-0004}'::text[],'HW0 INT-0003 is still open at rollstock');

-- HW1: the issue's case ------------------------------------------------------------------------
select pg_temp.weigh('INT-0001',50);
select pg_temp.weigh('INT-0002',40);
select pg_temp.weigh('INT-0004',61);
create temp table flag as select pg_temp.send('INT-0002','v93-hw-send-1') r;
select is((select r->>'ok' from flag),'false','HW1 INT-0002 at −20% is held');
select is((select array_agg(intake_number order by position) from public.variance_hold_member where hold_id=((select r from flag)->>'variance_hold_id')::uuid),
  '{INT-0001,INT-0002,INT-0004,INT-0003}'::text[],'HW1 its group, in rollstock order');
select pg_temp.reweigh('INT-0002',50,'v93-hw-fix-1');
select is(pg_temp.send('INT-0002','v93-hw-send-2')->>'reason',
  'INT-0002 is within the limit. Hold waits on INT-0004 (+22%) and INT-0003 (not at reconcile yet). It clears when they are at reconcile within the limit, or a manager signs off.',
  'HW1 a fixed order with an uncleared group is told each blocking neighbour and why it blocks');

-- HW2: only what still blocks is named ---------------------------------------------------------
select pg_temp.reweigh('INT-0004',55,'v93-hw-fix-4');
select is(pg_temp.send('INT-0002','v93-hw-send-3')->>'reason',
  'INT-0002 is within the limit. Hold waits on INT-0003 (not at reconcile yet). It clears when they are at reconcile within the limit, or a manager signs off.',
  'HW2 a neighbour back within the limit drops off the list');
select is((select array_agg(signed_off order by position) from public.variance_hold_member where hold_id=((select r from flag)->>'variance_hold_id')::uuid),
  '{f,f,f,f}'::boolean[],'HW2 variance_hold_member says no member is signed off');

-- HW3: the generated pieces -------------------------------------------------------------------
select is(app.variance_hold_waiting_message('INT-0002','over','{}'),null,'HW3 over the limit is not a waiting message');
select is(app.variance_hold_waiting_message('INT-0002','near','{}'),
  'INT-0002 is within the limit. The rest of its hold group is within the limit too. Send to Blast clears the hold.',
  'HW3 nothing left to wait on');
select is(app.variance_hold_wait_list('{A,B,C}'),'A, B and C','HW3 three waits');

-- HW4: the group clears once the last neighbour reaches reconcile within the limit -------------
select pg_temp.scan(null,'INT-0003','v93-hw-rs-finish');
select pg_temp.weigh('INT-0003',50);
select is(pg_temp.send('INT-0002','v93-hw-send-4')->>'ok','true','HW4 nothing left to wait on: INT-0002 goes to blast');

select * from finish();
rollback;
