begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into public.org(id,slug,name,timezone) values
 ('a0000000-0000-4000-8000-00000000000a','station-a','Station A','UTC'),
 ('b0000000-0000-4000-8000-00000000000b','station-b','Station B','UTC');
insert into public.site(id,org_id,name) values ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name,phone) values ('a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a','Test customer','+19075550111');
insert into public.intake(org_id,number,customer_id,site_id,tote_count) values
 ('a0000000-0000-4000-8000-00000000000a','INT-0001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001',1);
insert into auth.users(id,email) values ('a0000000-0000-4000-8000-0000000000a1','station-test@example.test');
insert into public.org_member(id,org_id,user_id,role,display_name) values
 ('a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-0000000000a1','manager','Test operator');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
create temp table accepted as select public.station_scan('scan-accept-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null) r;
select is((select r->>'ok' from accepted),'true','known tote is accepted');
select is((select count(*)::int from public.scan_log where result='ok'),1,'accepted scan writes audit row');
select is(public.station_scan('scan-accept-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null),(select r from accepted),'lost-response replay returns stored reply');
select is((select count(*)::int from public.scan_log),1,'replay does not duplicate scan audit');
select is(public.station_scan('scan-reject-001','unknown','wave',null,'unknown_format',null)->>'ok','false','unknown scan is rejected');
select is((select reason from public.scan_log where raw='unknown'),'unknown_format','reject reason is audited');
select is(public.station_scan('scan-phantom-001','FL:TOTE:INT-9999:1','wave','{"kind":"TOTE","intakeNumber":"INT-9999","toteNo":1}',null,null)->>'reason','unknown_tote','phantom tote is rejected against master');
select is(public.station_scan('scan-extra-001','FL:TOTE:INT-0001:2','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":2}',null,null)->>'ok','false','out-of-range tote is rejected');
-- Canonical QR safe integers extend beyond Postgres int4; rejects must commit, not poison replay.
select is(public.station_scan('scan-large-tote-001','FL:TOTE:INT-0001:2147483648','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":2147483648}',null,null)->>'reason','unknown_tote','int4-overflow tote is an audited business rejection');
select is((select result::text from public.scan_log where raw='FL:TOTE:INT-0001:2147483648'),'rejected','large tote writes rejected scan_log row');
select ok((select completed_at is not null from public.action_log where client_action_id='scan-large-tote-001'),'large tote completes action_log instead of retrying forever');
select is(public.station_scan('scan-max-safe-tote-001','FL:TOTE:INT-0001:9007199254740991','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":9007199254740991}',null,null)->>'reason','unknown_tote','maximum parser-safe integer is rejected without overflow');
select is(public.station_scan('scan-after-large-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null)->>'ok','true','valid scan after large totes is accepted');
select is((select result::text from public.scan_log where id=(select (result->>'scan_id')::uuid from public.action_log where client_action_id='scan-after-large-001')),'ok','valid scan after large totes is audited');
reset role;
select set_config('request.jwt.claims','{"sub":"b0000000-0000-4000-8000-0000000000b1","role":"authenticated","org_id":"b0000000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is_empty('select id from public.scan_log','other tenant cannot see scans');
select throws_ok($$select public.station_scan('scan-accept-001','unknown','wave',null,'unknown_format',null)$$,'23505',null,'other tenant cannot replay action');
reset role;
insert into public.station_operator_session(id,org_id,user_id,operator_id) values
 ('a0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"station"}',true);
set local role authenticated;
select is(public.station_scan('scan-no-pin-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null)->>'reason','operator_pin_required','station requires verified operator session');
select is(public.station_scan('scan-with-pin-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,'a0000000-0000-4000-8000-000000000004')->>'ok','true','verified operator session accepts known tote');
select is((select operator_id from public.scan_log where id = (select (result->>'scan_id')::uuid from public.action_log where client_action_id='scan-with-pin-001')),'a0000000-0000-4000-8000-000000000003'::uuid,'scan attributes verified operator');
select throws_ok('select id from public.station_operator_session','42501',null,'session proofs cannot be enumerated by devices');
reset role;
update public.station_operator_session set expires_at = now() - interval '1 second';
set local role authenticated;
select is(public.station_scan('scan-expired-pin-001','unknown','wave',null,'unknown_format','a0000000-0000-4000-8000-000000000004')->>'reason','operator_pin_required','expired operator session requires identification');
reset role;
-- A manager may reassign a device while older station scans remain queued.
insert into auth.users(id,email) values ('a0000000-0000-4000-8000-0000000000d1','reassigned-device@example.test');
insert into public.device(id,org_id,name,station,auth_user_id) values
 ('a0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-00000000000a','Reassigned station','locate','a0000000-0000-4000-8000-0000000000d1');
insert into public.station_operator_session(id,org_id,user_id,operator_id) values
 ('a0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-0000000000d1','a0000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000d1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"station","device_id":"a0000000-0000-4000-8000-000000000006"}',true);
set local role authenticated;
create temp table mismatch as select public.station_scan('scan-mismatch-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,'a0000000-0000-4000-8000-000000000007') r;
select is((select r->>'reason' from mismatch),'station_mismatch','station mismatch is a business rejection instead of a thrown permission error');
select is((select result::text from public.scan_log where id=(select (r->>'scan_id')::uuid from mismatch)),'rejected','station mismatch writes a rejected scan_log row');
select is((select device_id from public.scan_log where id=(select (r->>'scan_id')::uuid from mismatch)),'a0000000-0000-4000-8000-000000000006'::uuid,'mismatch audit identifies the org-owned device');
select ok((select completed_at is not null from public.action_log where client_action_id='scan-mismatch-001'),'station mismatch completes its action atomically');
select is(public.station_scan('scan-mismatch-001','FL:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,'a0000000-0000-4000-8000-000000000007'),(select r from mismatch),'station mismatch replay returns its audited rejection');
select is((select count(*)::int from public.scan_log where reason='station_mismatch'),1,'station mismatch replay does not duplicate the audit');
select is(public.station_scan('scan-after-mismatch-001','FL:TOTE:INT-0001:1','locate','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,'a0000000-0000-4000-8000-000000000007')->>'ok','true','a valid scan at the reassigned station succeeds after the rejected scan');
reset role;
select * from finish();
rollback;
