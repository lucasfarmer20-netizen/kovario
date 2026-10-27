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
create temp table accepted as select public.station_scan('scan-accept-001','KV:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null) r;
select is((select r->>'ok' from accepted),'true','known tote is accepted');
select is((select count(*)::int from public.scan_log where result='ok'),1,'accepted scan writes audit row');
select is(public.station_scan('scan-accept-001','KV:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null),(select r from accepted),'lost-response replay returns stored reply');
select is((select count(*)::int from public.scan_log),1,'replay does not duplicate scan audit');
select is(public.station_scan('scan-reject-001','unknown','wave',null,'unknown_format',null)->>'ok','false','unknown scan is rejected');
select is((select reason from public.scan_log where raw='unknown'),'unknown_format','reject reason is audited');
select is(public.station_scan('scan-phantom-001','KV:TOTE:INT-9999:1','wave','{"kind":"TOTE","intakeNumber":"INT-9999","toteNo":1}',null,null)->>'reason','unknown_tote','phantom tote is rejected against master');
select is(public.station_scan('scan-extra-001','KV:TOTE:INT-0001:2','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":2}',null,null)->>'ok','false','out-of-range tote is rejected');
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
select is(public.station_scan('scan-no-pin-001','KV:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,null)->>'reason','operator_pin_required','station requires verified operator session');
select is(public.station_scan('scan-with-pin-001','KV:TOTE:INT-0001:1','wave','{"kind":"TOTE","intakeNumber":"INT-0001","toteNo":1}',null,'a0000000-0000-4000-8000-000000000004')->>'ok','true','verified operator session accepts known tote');
select is((select operator_id from public.scan_log where id = (select (result->>'scan_id')::uuid from public.action_log where client_action_id='scan-with-pin-001')),'a0000000-0000-4000-8000-000000000003'::uuid,'scan attributes verified operator');
select throws_ok('select id from public.station_operator_session','42501',null,'session proofs cannot be enumerated by devices');
reset role;
update public.station_operator_session set expires_at = now() - interval '1 second';
set local role authenticated;
select is(public.station_scan('scan-expired-pin-001','unknown','wave',null,'unknown_format','a0000000-0000-4000-8000-000000000004')->>'reason','operator_pin_required','expired operator session requires identification');
reset role;
select * from finish();
rollback;
