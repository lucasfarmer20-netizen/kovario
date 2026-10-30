-- Issue #87: variance hold at reconcile. Send to Blast over the org's limit (default ±15%) is
-- refused and flags the intake; the 1-before / 2-after rollstock neighbours not yet in blast are
-- blocked until the hold clears, by a manager sign-off (single SQL function, action_log,
-- report) or automatically once the group is back within the limit. Every intake sent to blast
-- shows as a "now in blast" line, in rollstock order, colour-banded.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Fixture ------------------------------------------------------------------------------------
-- Org A (new: carries reconcile.variance_hold_pct = 15) and org B (from before v1.1: no key).
insert into public.org(id,slug,name,timezone) values
 ('a2700000-0000-4000-8000-00000000000a','variance-a','Variance A','UTC'),
 ('b2700000-0000-4000-8000-00000000000b','variance-b','Variance B','UTC');
update public.org set settings = settings - 'reconcile' where id='b2700000-0000-4000-8000-00000000000b';
insert into public.site(id,org_id,name) values ('a2700000-0000-4000-8000-000000000001','a2700000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a2700000-0000-4000-8000-000000000002','a2700000-0000-4000-8000-00000000000a','Variance customer');
insert into public.species(org_id,code,name,"group") values ('a2700000-0000-4000-8000-00000000000a','salmon','Salmon','salmon');
insert into public.incoming_condition(org_id,code,name) values ('a2700000-0000-4000-8000-00000000000a','whole','Whole');
insert into public.processing_method(org_id,code,name) values ('a2700000-0000-4000-8000-00000000000a','fillets','Fillets');
insert into auth.users(id,email) values
 ('a2700000-0000-4000-8000-0000000000a1','variance-manager@example.test'),
 ('a2700000-0000-4000-8000-0000000000a2','variance-staff@example.test');
insert into public.org_member(id,org_id,user_id,role,display_name) values
 ('a2700000-0000-4000-8000-0000000000b1','a2700000-0000-4000-8000-00000000000a','a2700000-0000-4000-8000-0000000000a1','manager','Variance manager'),
 ('a2700000-0000-4000-8000-0000000000b2','a2700000-0000-4000-8000-00000000000a','a2700000-0000-4000-8000-0000000000a2','staff','Variance staff');
-- Two waves. INT-0001..0003 in wave 1, INT-0004..0006 in wave 2; INT-0011..0013 bypass the cooler
-- later. Every intake expects 50 lb (100 lb × 0.5), so ±15% is 42.5–57.5 lb.
insert into public.wave(id,org_id,number) values
 ('a2700000-0000-4000-8000-0000000000e1','a2700000-0000-4000-8000-00000000000a','WAV-0001'),
 ('a2700000-0000-4000-8000-0000000000e2','a2700000-0000-4000-8000-00000000000a','WAV-0002');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count,wave_id)
select ('a2700000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,'a2700000-0000-4000-8000-00000000000a',
  'INT-00'||lpad(n::text,2,'0'),'a2700000-0000-4000-8000-000000000002','a2700000-0000-4000-8000-000000000001',1,
  case when n<=3 then 'a2700000-0000-4000-8000-0000000000e1'::uuid when n<=6 then 'a2700000-0000-4000-8000-0000000000e2'::uuid end
from unnest('{1,2,3,4,5,6,11,12,13}'::int[]) n;
insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
select org_id,id,'salmon','whole','fillets',100,0.5 from public.intake where org_id='a2700000-0000-4000-8000-00000000000a';
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr)
select org_id,id,1,1,'FL:TOTE:'||number||':1' from public.intake where org_id='a2700000-0000-4000-8000-00000000000a';
update public.intake set state='holding' where org_id='a2700000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a2700000-0000-4000-8000-00000000000a';

create temp table ids(k text primary key, v uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v from ids where k=p_k $$;
create function pg_temp.intake(p_number text) returns uuid language sql as $$
  select id from public.intake where number=p_number and org_id='a2700000-0000-4000-8000-00000000000a' $$;
-- One reconcile vessel (exchange, no tag needed) weighed manually.
create function pg_temp.weigh(p_number text, p_lb numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.reconcile_action('v87-ex-'||p_number,pg_temp.intake(p_number),'exchange');
  insert into ids values ('vessel-'||p_number,(r->>'vessel_id')::uuid);
  return public.reconcile_action('v87-w-'||p_number,pg_temp.intake(p_number),'manual',p_vessel_id=>(r->>'vessel_id')::uuid,p_weight=>p_lb);
end $$;
create function pg_temp.reweigh(p_number text, p_lb numeric, p_key text) returns jsonb language sql as $$
  select public.reconcile_action(p_key,pg_temp.intake(p_number),'manual',p_vessel_id=>pg_temp.id('vessel-'||p_number),p_weight=>p_lb)
$$;
create function pg_temp.send(p_number text, p_key text) returns jsonb language sql as $$
  select public.send_to_blast(p_key,pg_temp.intake(p_number))
$$;
create function pg_temp.state(p_number text) returns text language sql as $$
  select state::text from public.intake where id=pg_temp.intake(p_number) $$;
-- A rollstock scan; its scan_log id is kept so the test can space scans one minute apart (each
-- scan is its own transaction on the floor; here they share now()).
create function pg_temp.scan(p_raw text, p_open text, p_key text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.rollstock_scan_advance(p_raw,pg_temp.intake(p_open),p_key);
  if r->>'scan_id' is not null then insert into ids values (p_key,(r->>'scan_id')::uuid); end if;
  return r;
end $$;

select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2700000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;

-- Rollstock: opened out of intake-number order and across the wave boundary:
-- INT-0002, INT-0001, INT-0003 (wave 1) then INT-0005, INT-0004, INT-0006 (wave 2).
select pg_temp.scan('FL:TOTE:INT-0002:1',null,'v87-rs-1');
select pg_temp.scan('FL:TOTE:INT-0001:1','INT-0002','v87-rs-2');
select pg_temp.scan('FL:TOTE:INT-0003:1','INT-0001','v87-rs-3');
select pg_temp.scan('FL:TOTE:INT-0005:1','INT-0003','v87-rs-4');
select pg_temp.scan('FL:TOTE:INT-0004:1','INT-0005','v87-rs-5');
select pg_temp.scan('FL:TOTE:INT-0006:1','INT-0004','v87-rs-6');
select pg_temp.scan(null,'INT-0006','v87-rs-finish');
reset role;
update public.scan_log s set scanned_at='2026-07-20 08:00Z'::timestamptz+(substr(k,8)::int*interval '1 minute')
from ids where ids.v=s.id and ids.k like 'v87-rs-_';
set local role authenticated;
select is((select array_agg(i.number order by r.opened_at,r.scan_id) from public.rollstock_open r join public.intake i on i.id=r.intake_id),
  '{INT-0002,INT-0001,INT-0003,INT-0005,INT-0004,INT-0006}'::text[],'V0 rollstock order is the first accepted rollstock scan per intake');

-- V1: over the limit is refused and flags the hold --------------------------------------------
select pg_temp.weigh('INT-0002',50);
select pg_temp.weigh('INT-0001',50);
select is(pg_temp.send('INT-0001','v87-send-0001')->>'ok','true','V1 within the limit goes to blast');
select pg_temp.weigh('INT-0003',70);
create temp table flag as select pg_temp.send('INT-0003','v87-send-0003') r;
select is((select r->>'ok' from flag),'false','V1 Send to Blast at +40% (limit ±15%) is refused');
select is((select r->>'reason' from flag),'Variance hold: INT-0003 is +40.0% (limit ±15%). Held with its rollstock neighbours until fixed or signed off','V1 refusal names the intake, its variance and the limit');
select is(pg_temp.state('INT-0003'),'reconcile','V1 the refused intake stays at reconcile');
select ok((select state='active' and intake_id=pg_temp.intake('INT-0003') and limit_pct=15 and variance_pct=40
  and actual_lb=70 and expected_lb=50 and flagged_by='a2700000-0000-4000-8000-0000000000b1'
  and id=((select r from flag)->>'variance_hold_id')::uuid from public.variance_hold),'V1 the intake is flagged with its variance, the limit and who');
select ok(exists(select 1 from public.domain_event where kind='variance_hold_flagged' and subject_id=pg_temp.intake('INT-0003')),'V1 flag recorded as a domain event');
select is(pg_temp.send('INT-0003','v87-send-0003'),(select r from flag),'V1 replaying the refused send returns the stored result');
select is(pg_temp.send('INT-0003','v87-send-0003-again')->>'reason','Variance hold: INT-0003 is +40.0% (limit ±15%). Fix the bins or get a manager sign-off','V1 sending again is still refused');
select is((select count(*)::int from public.variance_hold),1,'V1 one hold per flagged intake (replay and retry flag nothing new)');

-- V2: the hold group follows rollstock order across the wave boundary ---------------------------
select is((select array_agg(intake_number order by position) from public.variance_hold_member),
  '{INT-0001,INT-0003,INT-0005,INT-0004}'::text[],'V2 group = 1 before and 2 after in rollstock order, across waves');
select is((select array_agg(position order by position) from public.variance_hold_member),'{-1,0,1,2}'::int[],'V2 positions relative to the flagged intake');
select is((select array_agg(intake_number order by position) from public.variance_hold_member where blocked),
  '{INT-0003,INT-0005,INT-0004}'::text[],'V2 members not yet in blast are blocked; INT-0001 already in blast is not');

-- V3: neighbours not in blast are blocked; everything else keeps moving -------------------------
select pg_temp.weigh('INT-0005',50);
select pg_temp.weigh('INT-0004',50);
select is(pg_temp.send('INT-0005','v87-send-0005')->>'reason','Variance hold on INT-0003: INT-0005 is its rollstock neighbour and waits for the hold to clear','V3 a within-limit neighbour after the flag is blocked');
select is(pg_temp.send('INT-0004','v87-send-0004')->>'ok','false','V3 the second neighbour after is blocked');
select ok(pg_temp.state('INT-0005')='reconcile' and pg_temp.state('INT-0004')='reconcile','V3 blocked neighbours stay at reconcile');
select is(pg_temp.send('INT-0002','v87-send-0002')->>'ok','true','V3 two before the flag is outside the group and goes to blast');
select pg_temp.weigh('INT-0006',56);
select is(pg_temp.send('INT-0006','v87-send-0006')->>'ok','true','V3 three after the flag is outside the group; +12% (near) is not held');
select is((select count(*)::int from public.variance_hold),1,'V3 blocked neighbours flag no hold of their own');
select ok(exists(select 1 from public.domain_event where kind='intake_sent_to_blast' and subject_id=pg_temp.intake('INT-0006')
  and (payload->>'variance_pct')::numeric=12 and payload->>'band'='near'),'V3 every send records its variance');

-- V4: manager sign-off ------------------------------------------------------------------------
create temp table hold as select id from public.variance_hold;
grant select on hold to authenticated;
-- Non-manager without a manager PIN elevation.
reset role;
select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a2","role":"authenticated","org_id":"a2700000-0000-4000-8000-00000000000a","app_role":"staff"}',true);
set local role authenticated;
select throws_ok($q$select public.variance_hold_signoff('v87-staff',(select id from hold),'spoilage')$q$,'42501','manager approval required','V4 a non-manager cannot sign off');
select throws_ok($q$select public.variance_hold_signoff('v87-staff-bad',(select id from hold),'spoilage',null,'not-a-token')$q$,'42501','manager approval required','V4 an invalid elevation token is refused');
select is((select state::text from public.variance_hold),'active','V4 the refused sign-off changes nothing');
reset role;
select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2700000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select throws_ok($q$select public.variance_hold_signoff('v87-other',(select id from hold),'other','  ')$q$,'22023','Other needs a note','V4 "other" needs a note');
select throws_ok($q$select public.variance_hold_signoff('v87-guess',(select id from hold),'guess')$q$,'22023','Choose a sign-off reason','V4 the reason is the enum');
create temp table signoff as select public.variance_hold_signoff('v87-signoff',(select id from hold),'trim_heavy','Heavy trim on kings') r;
select is((select r->>'reason' from signoff),'Hold signed off','V4 a manager signs off with a reason');
select ok((select state='cleared' and clear_kind='signoff' and reason='trim_heavy' and note='Heavy trim on kings'
  and cleared_by='a2700000-0000-4000-8000-0000000000b1' and cleared_at is not null and cleared_actual_lb=70 and cleared_variance_pct=40
  from public.variance_hold),'V4 sign-off records who, when, reason and variance');
select is((select action from public.action_log where client_action_id='v87-signoff'),'variance_hold.signoff','V4 sign-off logged in action_log');
select is(public.variance_hold_signoff('v87-signoff',(select id from hold),'trim_heavy','Heavy trim on kings'),(select r from signoff),'V4 replaying the sign-off returns the stored result');
create temp table cleared_at as select cleared_at from public.variance_hold;
select is(public.variance_hold_signoff('v87-signoff-2',(select id from hold),'spoilage')->>'reason','Hold already cleared','V4 signing off a cleared hold is a no-op');
select ok((select reason='trim_heavy' and cleared_at=(select cleared_at from cleared_at) from public.variance_hold),'V4 the first sign-off stands');
select ok(exists(select 1 from public.report_variance_holds where intake_number='INT-0003' and outcome='signoff'
  and signed_off_by='Variance manager' and reason='trim_heavy' and variance_pct=40 and cleared_at is not null),'V4 report shows who, when, reason and variance');

-- V5: once cleared, the group moves -------------------------------------------------------------
select is(pg_temp.send('INT-0005','v87-send-0005-2')->>'ok','true','V5 a neighbour goes to blast once the hold clears');
select is(pg_temp.send('INT-0004','v87-send-0004-2')->>'ok','true','V5 the other neighbour too');
select is(pg_temp.send('INT-0003','v87-send-0003-3')->>'ok','true','V5 the signed-off intake goes to blast at the weight signed off');

-- V6: now in blast ------------------------------------------------------------------------------
select is((select array_agg(intake_number||' '||band||' '||variance_pct order by rollstock_opened_at,rollstock_scan_id) from public.now_in_blast),
  '{"INT-0002 within 0.00","INT-0001 within 0.00","INT-0003 over 40.00","INT-0005 within 0.00","INT-0004 within 0.00","INT-0006 near 12.00"}'::text[],
  'V6 every intake sent to blast has a line with its variance, in rollstock order, banded');
reset role;
update public.vessel set stored_at=now() where id=pg_temp.id('vessel-INT-0002');
update public.intake set state='stored' where id=pg_temp.intake('INT-0002');
set local role authenticated;
select ok(not exists(select 1 from public.now_in_blast where intake_number='INT-0002'),'V6 an intake whose vessels are all on a shelf leaves the list');

-- V7: auto-clear when the whole group is back within the limit (#88's bin move) -----------------
-- INT-0011..0013 open after INT-0006. INT-0011 at 40 lb (−20%) is flagged; INT-0012 (+20%) is its
-- neighbour. Moving fish between them (reweigh both to 50) clears the hold with no sign-off.
select pg_temp.scan('FL:TOTE:INT-0011:1',null,'v87-rs-7');
select pg_temp.scan('FL:TOTE:INT-0012:1','INT-0011','v87-rs-8');
select pg_temp.scan('FL:TOTE:INT-0013:1','INT-0012','v87-rs-9');
select pg_temp.scan(null,'INT-0013','v87-rs-finish-2');
reset role;
update public.scan_log s set scanned_at='2026-07-20 08:00Z'::timestamptz+(substr(k,8)::int*interval '1 minute')
from ids where ids.v=s.id and ids.k like 'v87-rs-_';
set local role authenticated;
select pg_temp.weigh('INT-0011',40);
select pg_temp.weigh('INT-0012',60);
select is(pg_temp.send('INT-0011','v87-send-0011')->>'ok','false','V7 INT-0011 at −20% is held');
select is((select array_agg(intake_number order by position) from public.variance_hold_member where hold_state='active'),
  '{INT-0006,INT-0011,INT-0012,INT-0013}'::text[],'V7 group of INT-0011');
select is(pg_temp.send('INT-0012','v87-send-0012')->>'reason','Variance hold on INT-0011: INT-0012 is its rollstock neighbour and waits for the hold to clear','V7 INT-0012 is blocked by its neighbour''s hold, not flagged itself');
select pg_temp.reweigh('INT-0011',50,'v87-move-1');
select pg_temp.reweigh('INT-0012',50,'v87-move-2');
select is((select state::text from public.variance_hold where intake_id=pg_temp.intake('INT-0011')),'active','V7 the hold stays while a member (INT-0013) is unreconciled');
select pg_temp.weigh('INT-0013',50);
select ok((select state='cleared' and clear_kind='auto' and cleared_by is null and reason is null and cleared_actual_lb=50
  from public.variance_hold where intake_id=pg_temp.intake('INT-0011')),'V7 the hold clears automatically when every member is within the limit');
select ok(exists(select 1 from public.domain_event where kind='variance_hold_cleared' and subject_id=pg_temp.intake('INT-0011') and payload->>'kind'='auto'),'V7 auto clear recorded as a domain event');
select is(pg_temp.send('INT-0012','v87-send-0012-2')->>'ok','true','V7 the neighbour goes to blast after the auto clear');
select is(pg_temp.send('INT-0011','v87-send-0011-2')->>'ok','true','V7 the flagged intake goes to blast now within');
select ok(exists(select 1 from public.report_variance_holds where intake_number='INT-0011' and outcome='auto' and signed_off_by is null),'V7 report shows the auto clear');

-- V8: a staff caller signs off with a manager PIN elevation -----------------------------------------
-- A hold on INT-0013 (reweighed out of range after it was reconciled).
select pg_temp.reweigh('INT-0013',30,'v87-0013-light');
create temp table flag13 as select pg_temp.send('INT-0013','v87-send-0013') r;
reset role;
insert into public.elevation_grant(org_id,requested_by,manager_member_id,token_hash,expires_at) values
 ('a2700000-0000-4000-8000-00000000000a','a2700000-0000-4000-8000-0000000000a2','a2700000-0000-4000-8000-0000000000b1',app.sha256_hex('v87-elevation'),now()+interval '5 minutes');
select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a2","role":"authenticated","org_id":"a2700000-0000-4000-8000-00000000000a","app_role":"staff"}',true);
set local role authenticated;
select is(public.variance_hold_signoff('v87-staff-pin',((select r from flag13)->>'variance_hold_id')::uuid,'other','Short-weighted at intake',p_elevation_token=>'v87-elevation')->>'reason','Hold signed off','V8 staff with a manager PIN elevation signs off');
select is((select cleared_by from public.variance_hold where intake_id=pg_temp.intake('INT-0013')),'a2700000-0000-4000-8000-0000000000b1'::uuid,'V8 the approving manager is recorded, not the staff caller');

-- V9: setting -------------------------------------------------------------------------------------
reset role;
select is((select settings #>> '{reconcile,variance_hold_pct}' from public.org where id='a2700000-0000-4000-8000-00000000000a'),'15','V9 a new org defaults to ±15%');
select is((select app.variance_hold_limit(settings) from public.org where id='b2700000-0000-4000-8000-00000000000b'),15,'V9 an org from before v1.1 reads the default');
select is(app.org_settings_problem((select settings from public.org where id='b2700000-0000-4000-8000-00000000000b')),null,'V9 settings without the key stay valid');
select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a2","role":"authenticated","org_id":"a2700000-0000-4000-8000-00000000000a","app_role":"staff"}',true);
set local role authenticated;
select throws_ok($q$select public.admin_update_org('v87-staff-settings','Variance A','UTC',
  jsonb_set((select settings from public.org),'{reconcile,variance_hold_pct}','20'))$q$,'42501',null,'V9 staff cannot edit the setting');
reset role;
select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2700000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select throws_ok($q$select public.admin_update_org('v87-settings-0','Variance A','UTC',
  jsonb_set((select settings from public.org),'{reconcile,variance_hold_pct}','0'))$q$,'22023',
  'Invalid settings: reconcile.variance_hold_pct must be a whole percent between 1 and 100','V9 below 1 is refused');
select throws_ok($q$select public.admin_update_org('v87-settings-101','Variance A','UTC',
  jsonb_set((select settings from public.org),'{reconcile,variance_hold_pct}','101'))$q$,'22023',null,'V9 above 100 is refused');
select throws_ok($q$select public.admin_update_org('v87-settings-frac','Variance A','UTC',
  jsonb_set((select settings from public.org),'{reconcile,variance_hold_pct}','12.5'))$q$,'22023',null,'V9 a fraction is refused');
select lives_ok($q$select public.admin_update_org('v87-settings-20','Variance A','UTC',
  jsonb_set((select settings from public.org),'{reconcile,variance_hold_pct}','20'))$q$,'V9 a manager sets ±20%');
select is((select distinct limit_pct from public.intake_variance),20,'V9 the new limit applies to every intake');
select is((select band from public.intake_variance where number='INT-0003'),'over','V9 bands follow the limit (+40% over ±20%)');
select is((select band from public.intake_variance where number='INT-0006'),'within','V9 +12% is within ±20% (near starts at 13.3%)');

-- V10: tenancy -----------------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims','{"sub":"a2700000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"b2700000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is((select count(*)::int from public.variance_hold),0,'V10 another org sees no holds');
select is((select count(*)::int from public.now_in_blast),0,'V10 another org sees no blast lines');
select throws_ok($q$select public.variance_hold_signoff('v87-cross',(select v from ids limit 0),'spoilage')$q$,'22023','Unknown variance hold','V10 an unknown hold is refused');
select throws_ok(format($q$select public.variance_hold_signoff('v87-cross-2',%L,'spoilage')$q$,(select id from hold)),'22023','Unknown variance hold','V10 another org''s hold cannot be signed off');

select * from finish();
rollback;
