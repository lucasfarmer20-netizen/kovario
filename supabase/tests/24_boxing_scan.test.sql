-- Issue #84 (review): boxing scans, typed or scanned, are validated server-side and logged.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Fixture: party ALC-0001 owns INT-0001 (vessel on tag 042); ALC-0002 is another party.
insert into public.org(id,slug,name,timezone) values ('a2400000-0000-4000-8000-00000000000a','boxing-scan','Boxing scan','UTC');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('a2400000-0000-4000-8000-00000000000a');
insert into public.site(id,org_id,name) values ('a2400000-0000-4000-8000-000000000001','a2400000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a2400000-0000-4000-8000-000000000002','a2400000-0000-4000-8000-00000000000a','Party');
insert into auth.users(id,email) values ('a2400000-0000-4000-8000-0000000000a1','boxing-scan@example.test');
insert into public.org_member(org_id,user_id,role,display_name) values ('a2400000-0000-4000-8000-00000000000a','a2400000-0000-4000-8000-0000000000a1','manager','Boxer');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a2400000-0000-4000-8000-000000000011','a2400000-0000-4000-8000-00000000000a','INT-0001','a2400000-0000-4000-8000-000000000002','a2400000-0000-4000-8000-000000000001',1);
update public.intake set state='holding' where org_id='a2400000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a2400000-0000-4000-8000-00000000000a';
update public.intake set state='rollstock' where org_id='a2400000-0000-4000-8000-00000000000a';
update public.intake set state='reconcile' where org_id='a2400000-0000-4000-8000-00000000000a';
insert into public.vessel(id,org_id,intake_id,weight_lb) values
 ('a2400000-0000-4000-8000-000000000041','a2400000-0000-4000-8000-00000000000a','a2400000-0000-4000-8000-000000000011',20);
insert into public.asset_tag(org_id,code,qr,state,current_vessel_id) values
 ('a2400000-0000-4000-8000-00000000000a','042','FL:TAG:boxing-scan:042','in_use','a2400000-0000-4000-8000-000000000041'),
 ('a2400000-0000-4000-8000-00000000000a','077','FL:TAG:boxing-scan:077','available',null);
update public.vessel v set asset_tag_id=t.id from public.asset_tag t where t.current_vessel_id=v.id;
insert into public.allocation_session(id,org_id,number) values
 ('a2400000-0000-4000-8000-000000000061','a2400000-0000-4000-8000-00000000000a','ALC-0001'),
 ('a2400000-0000-4000-8000-000000000062','a2400000-0000-4000-8000-00000000000a','ALC-0002');
insert into public.allocation_intake(org_id,session_id,intake_id) values
 ('a2400000-0000-4000-8000-00000000000a','a2400000-0000-4000-8000-000000000061','a2400000-0000-4000-8000-000000000011');
insert into public.settlement(org_id,number,session_id,angler_name,boxing_token) values
 ('a2400000-0000-4000-8000-00000000000a','STL-0001','a2400000-0000-4000-8000-000000000061','Ann','partytoken'),
 ('a2400000-0000-4000-8000-00000000000a','STL-0002','a2400000-0000-4000-8000-000000000062','Bo','othertoken');

select set_config('request.jwt.claims','{"sub":"a2400000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2400000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;

-- Queue: a receipt's boxing QR opens its party; anything else is refused. All logged.
select is(public.boxing_scan('bx-queue-box','FL:BOX:partytoken')->>'session_id','a2400000-0000-4000-8000-000000000061','B1 queue: boxing QR resolves its party');
select is(public.boxing_scan('bx-queue-tag','042')->>'reason','Scan the boxing QR on a settlement receipt','B1 queue: a tag is refused');
select is(public.boxing_scan('bx-queue-phantom','FL:BOX:nosuchtoken')->>'reason','That boxing QR does not match a settlement','B1 queue: a phantom boxing QR is refused');

-- Party screen: tags must be on this party's pick list; another party's receipt is refused.
select is(public.boxing_scan('bx-party-tag','FL:TAG:boxing-scan:042','a2400000-0000-4000-8000-000000000061')->>'vessel_id','a2400000-0000-4000-8000-000000000041','B2 party: a scanned tag on the pick list is accepted');
select set_config('request.headers','{"x-filletry-entry-method":"manual"}',true);
select is(public.boxing_scan('bx-party-typed','42','a2400000-0000-4000-8000-000000000061')->>'ok','true','B2 party: a typed tag (bare, unpadded) is accepted');
select is(public.boxing_scan('bx-party-phantom','999','a2400000-0000-4000-8000-000000000061')->>'reason','Basket 999 is not on ALC-0001''s pick list','B3 party: a typed phantom tag is rejected');
select is(public.boxing_scan('bx-party-free','077','a2400000-0000-4000-8000-000000000061')->>'reason','Basket 077 is not on ALC-0001''s pick list','B3 party: a real tag with no vessel in scope is rejected');
select is(public.boxing_scan('bx-party-other','FL:BOX:othertoken','a2400000-0000-4000-8000-000000000061')->>'reason','That receipt belongs to another party; one party per Complete. Finish ALC-0001 first.','B3 party: another party''s receipt is refused (I11)');
select is(public.boxing_scan('bx-party-junk','hello','a2400000-0000-4000-8000-000000000061')->>'reason','Scan a basket or the boxing QR','B3 party: junk is refused');
select is(public.boxing_scan('bx-party-same','FL:BOX:partytoken','a2400000-0000-4000-8000-000000000061')->>'kind','BOX','B2 party: its own receipt re-projects');

-- Every entry is logged at station boxing, with result and entry method.
select results_eq(
  $q$select result::text, entry_method::text, count(*)::int from public.scan_log where station='boxing' group by 1,2 order by 1,2$q$,
  $q$values ('ok','manual',2),('ok','scan',2),('rejected','manual',4),('rejected','scan',2)$q$,
  'B4 every boxing entry is logged; typed ones as manual');
select is((select vessel_id from public.scan_log where raw='42'),'a2400000-0000-4000-8000-000000000041'::uuid,'B4 accepted tag logs its vessel');
select is((select count(*)::int from public.report_manual_entries where station='boxing' and manual_count=6),1,'B4 boxing contributes to the manual-entry report');
-- Replay is idempotent.
select is(public.boxing_scan('bx-party-typed','42','a2400000-0000-4000-8000-000000000061')->>'ok','true','B5 replay returns the stored result');
select is((select count(*)::int from public.scan_log where station='boxing'),10,'B5 replay logs nothing new');
reset role;
set local role anon;
select throws_ok($q$select public.boxing_scan('bx-anon-001','042')$q$,'42501',null,'B6 anonymous callers are denied');
reset role;
select * from finish();
rollback;
