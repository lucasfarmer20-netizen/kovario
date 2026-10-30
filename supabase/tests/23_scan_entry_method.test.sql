-- Issue #84: typed codes take the scan path and are logged as manual; manual counts report.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Fixture ------------------------------------------------------------------------------
insert into public.org(id,slug,name,timezone) values
 ('a2300000-0000-4000-8000-00000000000a','manual-a','Manual A','UTC'),
 ('b2300000-0000-4000-8000-00000000000b','manual-b','Manual B','UTC');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('a2300000-0000-4000-8000-00000000000a', 'b2300000-0000-4000-8000-00000000000b');
insert into public.site(id,org_id,name) values ('a2300000-0000-4000-8000-000000000001','a2300000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a2300000-0000-4000-8000-000000000002','a2300000-0000-4000-8000-00000000000a','Manual customer');
insert into auth.users(id,email) values ('a2300000-0000-4000-8000-0000000000a1','manual-test@example.test');
insert into public.org_member(org_id,user_id,role,display_name) values ('a2300000-0000-4000-8000-00000000000a','a2300000-0000-4000-8000-0000000000a1','manager','Manual operator');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a2300000-0000-4000-8000-000000000011','a2300000-0000-4000-8000-00000000000a','INT-0001','a2300000-0000-4000-8000-000000000002','a2300000-0000-4000-8000-000000000001',1);
update public.intake set state='holding' where org_id='a2300000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a2300000-0000-4000-8000-00000000000a';
update public.intake set state='rollstock' where org_id='a2300000-0000-4000-8000-00000000000a';
update public.intake set state='reconcile', reconcile_at='2026-10-27 10:00Z' where org_id='a2300000-0000-4000-8000-00000000000a';
update public.intake set state='blast_freezer' where org_id='a2300000-0000-4000-8000-00000000000a';
insert into public.scale(id,org_id,name,site_id) values ('a2300000-0000-4000-8000-000000000051','a2300000-0000-4000-8000-00000000000a','Floor scale','a2300000-0000-4000-8000-000000000001');
insert into public.scale_reading(id,org_id,scale_id,weight_lb,stable) values ('a2300000-0000-4000-8000-000000000052','a2300000-0000-4000-8000-00000000000a','a2300000-0000-4000-8000-000000000051',18,true);
insert into public.vessel(id,org_id,intake_id,weight_lb,manual,scale_reading_id) values
 ('a2300000-0000-4000-8000-000000000041','a2300000-0000-4000-8000-00000000000a','a2300000-0000-4000-8000-000000000011',20,true,null),
 ('a2300000-0000-4000-8000-000000000042','a2300000-0000-4000-8000-00000000000a','a2300000-0000-4000-8000-000000000011',18,false,'a2300000-0000-4000-8000-000000000052'),
 ('a2300000-0000-4000-8000-000000000043','a2300000-0000-4000-8000-00000000000a','a2300000-0000-4000-8000-000000000011',0,false,null);
insert into public.asset_tag(org_id,code,qr,state,current_vessel_id) values
 ('a2300000-0000-4000-8000-00000000000a','041','FL:TAG:manual-a:041','in_use','a2300000-0000-4000-8000-000000000041');
update public.vessel v set asset_tag_id=t.id from public.asset_tag t where t.current_vessel_id=v.id;

select set_config('request.jwt.claims','{"sub":"a2300000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2300000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;

-- A phantom tag: scanned, then typed. Same RPC, same rejection; only entry_method differs.
create temp table phantom as select
  public.blast_vessel('m-phantom-scan','999') as scanned,
  null::jsonb as typed;
select set_config('request.headers','{"x-filletry-entry-method":"manual"}',true);
update phantom set typed=public.blast_vessel('m-phantom-typed','999');
select is((select typed->>'reason' from phantom),(select scanned->>'reason' from phantom),'M-SQL1 a typed phantom tag is rejected exactly like a scanned one');
select is((select typed->>'ok' from phantom),'false','M-SQL1 typed phantom tag is not accepted');
select results_eq(
  $q$select raw,result::text,reason,entry_method::text from public.scan_log where raw='999' order by entry_method::text desc$q$,
  $q$values ('999','rejected',(select scanned->>'reason' from phantom),'scan'),('999','rejected',(select scanned->>'reason' from phantom),'manual')$q$,
  'M-SQL2 both rejections are logged; the typed one as manual');

-- A real tag typed: accepted through the same RPC, logged manual.
select is(public.blast_vessel('m-real-typed','041')->>'ok','true','M-SQL3 a typed real tag is accepted');
select is((select entry_method::text from public.scan_log where raw='041'),'manual','M-SQL3 typed tag logged manual');
-- Replay of the typed action id returns the stored result and logs nothing new.
select is((select count(*)::int from public.scan_log),3,'M-SQL3 three scans logged');
select is(public.blast_vessel('m-real-typed','041')->>'ok','true','M-SQL4 typed replay returns stored result');
select is((select count(*)::int from public.scan_log),3,'M-SQL4 replay logs no second row');

-- No header, another header, or an unreadable header → scan; the scan is never blocked.
select set_config('request.headers','{"x-other":"manual"}',true);
select is(public.blast_vessel('m-other-header','FL:TAG:manual-a:041')->>'reason','Basket 041 already in blast · INT-0001','M-SQL5 other headers scan normally');
select set_config('request.headers','not json',true);
select is(public.blast_vessel('m-garbled','41')->>'ok','true','M-SQL5 an unreadable header never blocks a scan');
select set_config('request.headers','',true);
select is(public.blast_vessel('m-empty-header','041')->>'ok','true','M-SQL5 no header scans normally');
select is((select count(*)::int from public.scan_log where entry_method='scan'),4,'M-SQL5 header-less scans default to scan');

-- Report: manual codes by station/day, and manual reconcile weights.
select results_eq(
  $q$select station,entry,entry_count::int,manual_count::int from public.report_manual_entries order by entry$q$,
  $q$values ('blast','code',6,2),('reconcile','weight',2,1)$q$,
  'M-SQL6 report counts manual codes per station and manual weights over weighed vessels');
select is((select day from public.report_manual_entries where entry='weight'),'2026-10-27'::date,'M-SQL6 manual weights dated by reconcile day');
reset role;
select ok((select reloptions @> array['security_invoker=true'] from pg_class where relname='report_manual_entries'),'M-SQL7 report is a security invoker view');
select set_config('request.jwt.claims','{"role":"authenticated","org_id":"b2300000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is((select count(*)::int from public.report_manual_entries),0,'M-SQL7 tenancy: another org sees none of these entries');
reset role;
set local role anon;
select throws_ok('select * from public.report_manual_entries','42501',null,'M-SQL7 anonymous query denied');
reset role;
select * from finish();
rollback;
