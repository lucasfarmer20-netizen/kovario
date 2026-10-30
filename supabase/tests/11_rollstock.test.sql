begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into public.org(id,slug,name,timezone) values ('a0000000-0000-4000-8000-00000000000a','rollstock-a','Wave A','UTC'),('b0000000-0000-4000-8000-00000000000b','rollstock-b','Wave B','UTC');
insert into public.site(id,org_id,name) values ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a','Wave customer');
insert into auth.users(id,email) values ('a0000000-0000-4000-8000-0000000000a1','rollstock-test@example.test');
insert into public.org_member(org_id,user_id,role,display_name) values ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-0000000000a1','manager','Wave operator');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a0000000-0000-4000-8000-000000000011','a0000000-0000-4000-8000-00000000000a','INT-0001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001',2),
 ('a0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-00000000000a','INT-0002','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001',1);
update public.intake set state='holding';
-- Master text represents labels produced by rules/qr.encode, not a SQL QR parser.
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr) values
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000011',1,2,'FL:TOTE:INT-0001:1'),
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000011',2,2,'FL:TOTE:INT-0001:2'),
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000012',1,1,'FL:TOTE:INT-0002:1');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
create temp table first_scan as select public.rollstock_scan_advance('FL:TOTE:INT-0001:1',null,'rs-first-001') r;
select is((select r->>'ok' from first_scan),'true','WP11 holding bypass opens first intake');
select is((select state::text from public.intake where number='INT-0001'),'rollstock','WP11 holding bypass traverses processing to rollstock');
select ok((select pulled_at is not null and rollstock_at is not null from public.intake where number='INT-0001'),'WP11 bypass stamps processing and rollstock');
select is((select count(*)::int from public.domain_event where kind='rollstock.holding_bypass'),1,'WP11 bypass audited');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0001:1',null,'rs-first-001'),(select r from first_scan),'WP11 lost response replay returns stored result');
select is((select count(*)::int from public.scan_log),1,'WP11 replay never duplicates scan');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0002:1','a0000000-0000-4000-8000-000000000011','rs-gap-001')->>'reason','Missing totes: 1 of 2 scanned','WP11 incomplete totes block advance with X of X gap');
select is((select state::text from public.intake where number='INT-0001'),'rollstock','WP11 incomplete intake stays open');
select is((select state::text from public.intake where number='INT-0002'),'holding','WP11 gap does not open next intake');
select is(public.rollstock_scan_advance(null,'a0000000-0000-4000-8000-000000000011','rs-finish-gap')->>'ok','false','WP11 finish also enforces completeness');
select public.rollstock_scan_advance('FL:TOTE:INT-0001:1','a0000000-0000-4000-8000-000000000011','rs-repeat-001');
select is((select scanned from public.rollstock_tote_progress where intake_id='a0000000-0000-4000-8000-000000000011'),1,'WP11 repeat tote cannot inflate parity');
select public.rollstock_scan_advance('FL:TOTE:INT-0001:2','a0000000-0000-4000-8000-000000000011','rs-second-tote');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0002:1','a0000000-0000-4000-8000-000000000011','rs-next-001')->>'ok','true','WP11 two-scan loop opens next and advances previous');
select is((select state::text from public.intake where number='INT-0001'),'reconcile','WP11 previous enters reconcile');
select ok((select rollstock_done_at is not null from public.intake where number='INT-0001'),'WP11 advance stamps rollstock done');
select is((select state::text from public.intake where number='INT-0002'),'rollstock','WP11 next intake opens');
select is(public.rollstock_scan_advance(null,'a0000000-0000-4000-8000-000000000012','rs-finish-001')->>'ok','true','WP11 finish queue closes last order');
select is((select state::text from public.intake where number='INT-0002'),'reconcile','WP11 last order enters reconcile');
select is(public.rollstock_scan_advance('phantom',null,'rs-unknown-001')->>'ok','false','WP11 unknown code rejected');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0001:1',null,'rs-stale-001')->>'ok','false','WP11 downstream intake cannot reopen');
reset role;
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a0000000-0000-4000-8000-000000000013','a0000000-0000-4000-8000-00000000000a','INT-0003','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001',2);
update public.intake set state='holding' where number='INT-0003';
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr) values
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000013',1,2,'FL:TOTE:INT-0003:1');
set local role authenticated;
create temp table verifying as select (public.create_wave(array['a0000000-0000-4000-8000-000000000013'::uuid],'rs-wave-create')->>'wave_id')::uuid id;
select public.advance_wave((select id from verifying),'rs-wave-start');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0003:1',null,'rs-verifying-001')->>'reason','This order is in a wave being checked. Remove it from the wave first.','WP11 verifying wave refuses holding bypass');
select public.cancel_wave((select id from verifying),'rs-wave-cancel');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0003:1',null,'rs-bypass-003')->>'ok','true','WP11 bypass allowed after removal from verifying wave');
reset role;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"staff"}',true);
set local role authenticated;
select is(public.rollstock_scan_advance(null,'a0000000-0000-4000-8000-000000000013','rs-no-manager',null,'Missing tote')->>'ok','false','WP11 staff cannot override without elevation');
reset role;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select is(public.rollstock_scan_advance(null,'a0000000-0000-4000-8000-000000000013','rs-manager-001',null,'Damaged tote label')->>'ok','true','WP11 manager override advances incomplete intake');
select is((select count(*)::int from public.domain_event where kind='rollstock.completeness_override' and payload->>'reason'='Damaged tote label'),1,'WP11 manager override audit contains reason');
reset role;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"b0000000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is_empty('select * from public.rollstock_tote_progress','WP11 progress RLS hides other tenant');
select is(public.rollstock_scan_advance('FL:TOTE:INT-0001:1',null,'rs-cross-tenant')->>'ok','false','WP11 cross tenant tote rejected');
reset role;
insert into public.intake(id,org_id,number,customer_id,tote_count) values
 ('a0000000-0000-4000-8000-000000000014','a0000000-0000-4000-8000-00000000000a','INT-0004','a0000000-0000-4000-8000-000000000002',2);
update public.intake set state='holding' where number='INT-0004';
update public.intake set state='processing' where number='INT-0004';
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr) values
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000014',1,2,'FL:TOTE:INT-0004:1');
insert into public.wave_scan(org_id,wave_id,intake_id,tote_no) select 'a0000000-0000-4000-8000-00000000000a',id,'a0000000-0000-4000-8000-000000000014',n from verifying cross join generate_series(1,2) n;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select is(public.rollstock_scan_advance('FL:TOTE:INT-0004:1',null,'rs-processing-001')->>'ok','true','WP11 processing intake opens directly');
select is((select scanned from public.rollstock_tote_progress where intake_id='a0000000-0000-4000-8000-000000000014'),2,'WP11 wave plus rollstock distinct tote union avoids double counting');
select is(public.rollstock_scan_advance(null,'a0000000-0000-4000-8000-000000000014','rs-wave-finish')->>'ok','true','WP11 wave verification satisfies finish completeness');
reset role;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"station"}',true);
set local role authenticated;
select is(public.rollstock_scan_advance('FL:TOTE:INT-0004:1',null,'rs-pin-required')->>'reason','operator_pin_required','WP11 station requires live operator proof');
select is((select reason from public.scan_log where raw='FL:TOTE:INT-0004:1' and result='rejected'),'operator_pin_required','WP11 missing PIN scan is audited');
reset role;
-- A bypass must release only its draft reservation, leaving the rest usable.
insert into public.intake(id,org_id,number,customer_id,tote_count) values
 ('a0000000-0000-4000-8000-000000000015','a0000000-0000-4000-8000-00000000000a','INT-0005','a0000000-0000-4000-8000-000000000002',1),
 ('a0000000-0000-4000-8000-000000000016','a0000000-0000-4000-8000-00000000000a','INT-0006','a0000000-0000-4000-8000-000000000002',1);
update public.intake set state='holding' where number in ('INT-0005','INT-0006');
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr) values
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000015',1,1,'FL:TOTE:INT-0005:1'),
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000016',1,1,'FL:TOTE:INT-0006:1');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
create temp table draft_bypass as select (public.create_wave(array['a0000000-0000-4000-8000-000000000015'::uuid,'a0000000-0000-4000-8000-000000000016'::uuid],'rs-draft-create')->>'wave_id')::uuid id;
select is(public.rollstock_scan_advance('FL:TOTE:INT-0005:1',null,'rs-draft-bypass')->>'ok','true','WP11 draft-wave holding bypass succeeds');
select ok((select wave_id is null and state='rollstock' from public.intake where number='INT-0005'),'WP11 bypass clears draft wave pointer');
select is((select count(*)::int from public.wave_intake where intake_id='a0000000-0000-4000-8000-000000000015'),0,'WP11 bypass removes draft membership');
select ok((select wave_id=(select id from draft_bypass) and state='holding' from public.intake where number='INT-0006'),'WP11 bypass preserves other draft intake reservation');
select is((select count(*)::int from public.wave_intake where wave_id=(select id from draft_bypass)),1,'WP11 draft retains remaining member');
select is(public.advance_wave((select id from draft_bypass),'rs-draft-verify')->>'ok','true','WP11 remaining draft intakes can start verification after bypass');
select is(public.scan_wave_tote((select id from draft_bypass),'FL:TOTE:INT-0006:1','rs-draft-scan')->>'ok','true','WP11 remaining draft tote can verify');
select is(public.advance_wave((select id from draft_bypass),'rs-draft-complete')->>'ok','true','WP11 remaining draft intakes can complete after bypass');
select is((select state::text from public.intake where number='INT-0006'),'processing','WP11 remaining intake reaches processing');
select is((select state::text from public.intake where number='INT-0005'),'rollstock','WP11 wave completion leaves bypassed intake open');
reset role;
select * from finish();
rollback;
