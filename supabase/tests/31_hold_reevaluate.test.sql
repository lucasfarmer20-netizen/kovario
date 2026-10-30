-- Issue #95 (docs/08 DECISION-27): a variance hold is re-evaluated whenever its inputs change,
-- not only when one of its intakes is weighed: an intake entering or leaving reconcile, a
-- cancellation, and a change to variance_hold_pct. Each case below checks the hold clears (or
-- stays) with no reconcile mutation on its members after the change. Re-evaluation runs in the
-- same transaction as the change: a trigger on intake.state (rules: holdReevaluateOn, generated)
-- and admin_update_org.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Fixture ------------------------------------------------------------------------------------
-- INT-0001..0016 each expect 50 lb (100 lb × 0.5): ±15% is 42.5–57.5 lb, except INT-0012, which
-- has no lines and so no expected yield (band unknown). Opened at rollstock in number order, in
-- four runs; the last of each run stays open at rollstock. Four hold groups, one per scenario:
-- A INT-0001..0004, B INT-0005..0008, C INT-0009..0012, D INT-0013..0016.
insert into public.org(id,slug,name,timezone) values
 ('a3100000-0000-4000-8000-00000000000a','hold-reevaluate','Hold reevaluate','UTC');
insert into public.site(id,org_id,name) values ('a3100000-0000-4000-8000-000000000001','a3100000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a3100000-0000-4000-8000-000000000002','a3100000-0000-4000-8000-00000000000a','Hold customer');
insert into public.species(org_id,code,name,"group") values ('a3100000-0000-4000-8000-00000000000a','salmon','Salmon','salmon');
insert into public.incoming_condition(org_id,code,name) values ('a3100000-0000-4000-8000-00000000000a','whole','Whole');
insert into public.processing_method(org_id,code,name) values ('a3100000-0000-4000-8000-00000000000a','fillets','Fillets');
insert into auth.users(id,email) values ('a3100000-0000-4000-8000-0000000000a1','hold-reevaluate-manager@example.test');
insert into public.org_member(id,org_id,user_id,role,display_name) values
 ('a3100000-0000-4000-8000-0000000000b1','a3100000-0000-4000-8000-00000000000a','a3100000-0000-4000-8000-0000000000a1','manager','Hold manager');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count)
select ('a3100000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,'a3100000-0000-4000-8000-00000000000a',
  'INT-'||lpad(n::text,4,'0'),'a3100000-0000-4000-8000-000000000002','a3100000-0000-4000-8000-000000000001',1
from generate_series(1,16) n;
insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
select org_id,id,'salmon','whole','fillets',100,0.5 from public.intake
where org_id='a3100000-0000-4000-8000-00000000000a' and number<>'INT-0012';
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr)
select org_id,id,1,1,'FL:TOTE:'||number||':1' from public.intake where org_id='a3100000-0000-4000-8000-00000000000a';
update public.intake set state='holding' where org_id='a3100000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a3100000-0000-4000-8000-00000000000a';

create temp table ids(k text primary key, v uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v from ids where k=p_k $$;
create function pg_temp.intake(p_number text) returns uuid language sql as $$
  select id from public.intake where number=p_number and org_id='a3100000-0000-4000-8000-00000000000a' $$;
-- One reconcile basket (exchange, no tag needed) weighed manually.
create function pg_temp.weigh(p_number text, p_lb numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.reconcile_action('v95-re-ex-'||p_number,pg_temp.intake(p_number),'exchange');
  insert into ids values ('vessel-'||p_number,(r->>'vessel_id')::uuid);
  return public.reconcile_action('v95-re-w-'||p_number,pg_temp.intake(p_number),'manual',p_vessel_id=>(r->>'vessel_id')::uuid,p_weight=>p_lb);
end $$;
create function pg_temp.reweigh(p_number text, p_lb numeric, p_key text) returns jsonb language sql as $$
  select public.reconcile_action(p_key,pg_temp.intake(p_number),'manual',p_vessel_id=>pg_temp.id('vessel-'||p_number),p_weight=>p_lb)
$$;
create function pg_temp.send(p_number text, p_key text) returns jsonb language sql as $$
  select public.send_to_blast(p_key,pg_temp.intake(p_number))
$$;
create function pg_temp.scan(p_n int, p_open int) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.rollstock_scan_advance('FL:TOTE:INT-'||lpad(p_n::text,4,'0')||':1',
    case when p_open is not null then pg_temp.intake('INT-'||lpad(p_open::text,4,'0')) end,'v95-re-rs-'||p_n);
  insert into ids values ('rs-'||lpad(p_n::text,2,'0'),(r->>'scan_id')::uuid);
  return r;
end $$;
create function pg_temp.finish(p_number text) returns jsonb language sql as $$
  select public.rollstock_scan_advance(null,pg_temp.intake(p_number),'v95-re-finish-'||p_number)
$$;
create function pg_temp.cancel(p_number text, p_key text) returns jsonb language sql as $$
  select public.force_transition(p_key,'intake',pg_temp.intake(p_number),'cancelled','Customer withdrew the order')
$$;
create function pg_temp.limit_to(p_pct int, p_key text) returns jsonb language sql as $$
  select public.admin_update_org(p_key,'Hold reevaluate','UTC',
    jsonb_set(o.settings,'{reconcile}',jsonb_build_object('variance_hold_pct',p_pct)))
  from public.org o where o.id='a3100000-0000-4000-8000-00000000000a'
$$;
create function pg_temp.hold_of(p_number text) returns public.variance_hold language sql as $$
  select * from public.variance_hold where intake_id=pg_temp.intake(p_number) order by flagged_at desc, id limit 1
$$;
-- app.variance_hold_waits is internal (not granted); the test reads it as the owner.
create function pg_temp.waits(p_number text) returns text[] language sql security definer as $$
  select app.variance_hold_waits(pg_temp.hold_of(p_number)) $$;
create function pg_temp.state_of(p_number text) returns text language sql as $$
  select (pg_temp.hold_of(p_number)).state::text $$;
create function pg_temp.cleared_events(p_number text) returns bigint language sql as $$
  select count(*) from public.domain_event where kind='variance_hold_cleared'
    and payload->>'hold_id'=(pg_temp.hold_of(p_number)).id::text $$;
create function pg_temp.reconcile_writes() returns bigint language sql as $$
  select count(*) from public.action_log where action like 'reconcile.%'
    and org_id='a3100000-0000-4000-8000-00000000000a' $$;

select set_config('request.jwt.claims','{"sub":"a3100000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a3100000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select pg_temp.scan(n,case when n%4<>1 then n-1 end) from generate_series(1,16) n;
reset role;
update public.scan_log s set scanned_at='2026-08-01 08:00Z'::timestamptz+(substr(k,4)::int*interval '1 minute')
from ids where ids.v=s.id and ids.k like 'rs-__';
set local role authenticated;
select is((select array_agg(number order by number) from public.intake where state='rollstock' and org_id='a3100000-0000-4000-8000-00000000000a'),
  '{INT-0004,INT-0008,INT-0012,INT-0016}'::text[],'RE0 the last of each run is still open at rollstock');

-- RE1 (A): cancellations at reconcile -----------------------------------------------------------
select pg_temp.weigh('INT-0001',50);
select pg_temp.weigh('INT-0002',40);
select pg_temp.weigh('INT-0003',61);
select is(pg_temp.send('INT-0002','v95-re-send-2')->>'ok','false','RE1 INT-0002 at −20% is held');
select is((select array_agg(intake_number order by position) from public.variance_hold_member where hold_id=(pg_temp.hold_of('INT-0002')).id),
  '{INT-0001,INT-0002,INT-0003,INT-0004}'::text[],'RE1 its group');
select pg_temp.reweigh('INT-0002',50,'v95-re-fix-2');
select is(pg_temp.state_of('INT-0002'),'active','RE1 fixed, it still waits on INT-0003 and INT-0004');
create temp table re1 as select pg_temp.reconcile_writes() n;
grant select on re1 to authenticated;

select pg_temp.finish('INT-0004');
select is(pg_temp.state_of('INT-0002'),'active','RE1 a neighbour entering reconcile with nothing weighed keeps the hold');
select is(pg_temp.waits('INT-0002'),'{"INT-0003 (+22%)","INT-0004 (not weighed yet)"}'::text[],
  'RE1 the hold waits on what holds it now');
select pg_temp.cancel('INT-0003','v95-re-cancel-3');
select is(pg_temp.state_of('INT-0002'),'active','RE1 cancelling one neighbour while another is unweighed keeps the hold');
create temp table re1_cancel as select pg_temp.cancel('INT-0004','v95-re-cancel-4') r;
grant select on re1_cancel to authenticated;
select is(pg_temp.state_of('INT-0002'),'cleared','RE1 cancelling the last open neighbour at reconcile clears the hold');
select is((select concat_ws(' ',h.clear_kind,h.cleared_actual_lb,h.cleared_variance_pct) from pg_temp.hold_of('INT-0002') h),
  'auto 50.00 0.00','RE1 an auto clear at the flagged intake''s current weight');
select is(pg_temp.reconcile_writes(),(select n from re1),'RE1 with no reconcile mutation on any member');
select is(pg_temp.cancel('INT-0004','v95-re-cancel-4'),(select r from re1_cancel),'RE1 replaying the cancel returns the stored result');
select is(pg_temp.cleared_events('INT-0002'),1::bigint,'RE1 replay clears nothing twice');
select is(pg_temp.send('INT-0002','v95-re-send-2b')->>'ok','true','RE1 INT-0002 goes to blast');

-- RE2 (B): variance_hold_pct, and a cancellation before reconcile -------------------------------
select pg_temp.weigh('INT-0005',50);
select pg_temp.weigh('INT-0006',40);
select pg_temp.weigh('INT-0007',50);
select is(pg_temp.send('INT-0006','v95-re-send-6')->>'ok','false','RE2 INT-0006 at −20% is held');
create temp table re2 as select pg_temp.reconcile_writes() n;
grant select on re2 to authenticated;
select pg_temp.cancel('INT-0008','v95-re-cancel-8');
select is(pg_temp.state_of('INT-0006'),'active','RE2 cancelling a neighbour not yet at reconcile keeps a hold whose order is over');
select is(pg_temp.limit_to(18,'v95-re-limit-18')->'variance_holds_cleared','0'::jsonb,'RE2 raising the limit to ±18% clears nothing');
select is(pg_temp.state_of('INT-0006'),'active','RE2 −20% is still over ±18%');
create temp table re2_limit as select pg_temp.limit_to(25,'v95-re-limit-25') r;
grant select on re2_limit to authenticated;
select is((select r->'variance_holds_cleared' from re2_limit),'1'::jsonb,'RE2 raising the limit to ±25% clears one hold');
select is(pg_temp.state_of('INT-0006'),'cleared','RE2 −20% is within ±25%: the hold clears');
select is((select concat_ws(' ',h.clear_kind,h.limit_pct) from pg_temp.hold_of('INT-0006') h),'auto 15',
  'RE2 an auto clear; the hold keeps its flag-time limit for reports');
select is(pg_temp.reconcile_writes(),(select n from re2),'RE2 with no reconcile mutation on any member');
select is(pg_temp.limit_to(25,'v95-re-limit-25'),(select r from re2_limit),'RE2 replaying the settings save returns the stored result');
select is(pg_temp.cleared_events('INT-0006'),1::bigint,'RE2 replay clears nothing twice');
select is(pg_temp.limit_to(15,'v95-re-limit-15')->'variance_holds_cleared','0'::jsonb,'RE2 lowering the limit again clears nothing');
select is(pg_temp.state_of('INT-0006'),'cleared','RE2 and re-flags nothing before Send to Blast (DECISION-30)');

-- RE3 (C): entering reconcile clears ------------------------------------------------------------
select pg_temp.weigh('INT-0009',50);
select pg_temp.weigh('INT-0010',40);
select pg_temp.weigh('INT-0011',50);
select is(pg_temp.send('INT-0010','v95-re-send-10')->>'ok','false','RE3 INT-0010 at −20% is held');
select pg_temp.reweigh('INT-0010',50,'v95-re-fix-10');
select is(pg_temp.state_of('INT-0010'),'active','RE3 fixed, it still waits on INT-0012 (not at reconcile yet)');
create temp table re3 as select pg_temp.reconcile_writes() n;
grant select on re3 to authenticated;
select pg_temp.finish('INT-0012');
select is(pg_temp.state_of('INT-0010'),'cleared','RE3 the last neighbour reaching reconcile, with no expected yield to judge, clears the hold');
select is(pg_temp.reconcile_writes(),(select n from re3),'RE3 with no reconcile mutation on any member');
select is(pg_temp.finish('INT-0012')->>'ok','true','RE3 replaying the rollstock finish returns the stored result');
select is(pg_temp.cleared_events('INT-0010'),1::bigint,'RE3 replay clears nothing twice');

-- RE4 (D): pull back into reconcile, then leaving reconcile -------------------------------------
select pg_temp.weigh('INT-0013',50);
select is(pg_temp.send('INT-0013','v95-re-send-13')->>'ok','true','RE4 INT-0013 goes to blast before any hold');
select pg_temp.weigh('INT-0014',40);
select pg_temp.weigh('INT-0015',61);
select is(pg_temp.send('INT-0014','v95-re-send-14')->>'ok','false','RE4 INT-0014 at −20% is held');
select pg_temp.finish('INT-0016');
select pg_temp.weigh('INT-0016',50);
select pg_temp.reweigh('INT-0014',50,'v95-re-fix-14');
select is(pg_temp.waits('INT-0014'),'{"INT-0015 (+22%)"}'::text[],'RE4 the hold waits on INT-0015 only');
create temp table re4 as select pg_temp.reconcile_writes() n;
grant select on re4 to authenticated;
select is(public.intake_pull_back('v95-re-pull-13',pg_temp.intake('INT-0013'),'Recheck the bins')->>'ok','true',
  'RE4 INT-0013 is pulled back to reconcile');
select is(pg_temp.state_of('INT-0014'),'active','RE4 a neighbour pulled back within the limit keeps a hold another neighbour holds');
select is(pg_temp.waits('INT-0014'),'{"INT-0015 (+22%)"}'::text[],'RE4 still waiting on INT-0015 only');
select is(public.force_transition('v95-re-force-15','intake',pg_temp.intake('INT-0015'),'blast_freezer','Sent on the floor before the hold')->>'to_state',
  'blast_freezer','RE4 a manager moves INT-0015 on to blast');
select is(pg_temp.state_of('INT-0014'),'cleared','RE4 its last open neighbour leaving reconcile clears the hold');
select is(pg_temp.reconcile_writes(),(select n from re4),'RE4 with no reconcile mutation on any member');

-- RE5: the trigger fires only for changes that alter how a hold judges a member -----------------
reset role;
select is((select tgenabled::text from pg_trigger where tgname='variance_holds_reevaluate' and tgrelid='public.intake'::regclass),
  'O','RE5 the re-evaluation trigger is on public.intake');
select ok(pg_get_triggerdef((select oid from pg_trigger where tgname='variance_holds_reevaluate' and tgrelid='public.intake'::regclass))
  ~ 'AFTER UPDATE OF state ON public.intake FOR EACH ROW WHEN \(app\.variance_hold_reevaluate_on\(old\.state, new\.state\)\)',
  'RE5 after each state update, when holdReevaluateOn says the change matters');

select * from finish();
rollback;
