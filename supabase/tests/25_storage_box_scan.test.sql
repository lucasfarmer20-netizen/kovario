-- Issue #84 (review): freezer-pickup box codes are checked against the storage master and
-- logged in scan_log, typed ones as manual.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Fixture: STG-0001 has box 1 (stored) and box 2 (picked up); STG-0002 belongs to another customer.
insert into public.org(id,slug,name,timezone) values
 ('a2500000-0000-4000-8000-00000000000a','storage-scan','Storage scan','UTC'),
 ('b2500000-0000-4000-8000-00000000000b','storage-other','Storage other','UTC');
insert into public.customer(id,org_id,name) values ('a2500000-0000-4000-8000-000000000002','a2500000-0000-4000-8000-00000000000a','Sam Store');
insert into auth.users(id,email) values ('a2500000-0000-4000-8000-0000000000a1','storage-scan@example.test');
insert into public.org_member(org_id,user_id,role,display_name) values ('a2500000-0000-4000-8000-00000000000a','a2500000-0000-4000-8000-0000000000a1','staff','Freezer crew');
insert into public.storage_intake(id,org_id,number,customer_id,state) values
 ('a2500000-0000-4000-8000-000000000081','a2500000-0000-4000-8000-00000000000a','STG-0001','a2500000-0000-4000-8000-000000000002','stored'),
 ('a2500000-0000-4000-8000-000000000082','a2500000-0000-4000-8000-00000000000a','STG-0002','a2500000-0000-4000-8000-000000000002','stored');
insert into public.storage_box(id,org_id,storage_intake_id,box_no,label) values
 ('a2500000-0000-4000-8000-000000000091','a2500000-0000-4000-8000-00000000000a','a2500000-0000-4000-8000-000000000081',1,'Box 1'),
 ('a2500000-0000-4000-8000-000000000092','a2500000-0000-4000-8000-00000000000a','a2500000-0000-4000-8000-000000000081',2,'Box 2'),
 ('a2500000-0000-4000-8000-000000000093','a2500000-0000-4000-8000-00000000000a','a2500000-0000-4000-8000-000000000082',1,'Box 1');
update public.storage_box set state='released', released_at=now() where id='a2500000-0000-4000-8000-000000000092';

select set_config('request.jwt.claims','{"sub":"a2500000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2500000-0000-4000-8000-00000000000a","app_role":"staff"}',true);
set local role authenticated;
select set_config('request.headers','{"x-filletry-entry-method":"manual"}',true);

create temp table typed_ok as select public.storage_box_scan('sb-typed-ok','FL:SBOX:STG-0001:1','a2500000-0000-4000-8000-000000000081','STG-0001',1) r;
select is((select r - 'scan_id' from typed_ok),
  jsonb_build_object('ok',true,'reason','Box 1 selected for pickup.',
    'box_id','a2500000-0000-4000-8000-000000000091'::uuid,'box_no',1),
  'S-M1 a typed box code of this intake is accepted with its box');
select is((select (r->>'scan_id')::uuid from typed_ok),(select id from public.scan_log where raw='FL:SBOX:STG-0001:1'),'S-M1 the reply names its scan_log row');
select is(public.storage_box_scan('sb-typed-other','FL:SBOX:STG-0002:1','a2500000-0000-4000-8000-000000000081','STG-0002',1)->>'reason','STG-0002-1 is not on STG-0001.','S-M2 another intake''s box is refused');
select is(public.storage_box_scan('sb-typed-phantom','FL:SBOX:STG-0001:9','a2500000-0000-4000-8000-000000000081','STG-0001',9)->>'reason','No box 9 on STG-0001.','S-M2 a phantom box is refused (PRD rule 6)');
select is(public.storage_box_scan('sb-typed-released','FL:SBOX:STG-0001:2','a2500000-0000-4000-8000-000000000081','STG-0001',2)->>'reason','Box 2 is already picked up.','S-M2 a picked-up box is refused');
select is(public.storage_box_scan('sb-typed-junk','hello','a2500000-0000-4000-8000-000000000081')->>'reason','Not a box code. Enter it as printed, e.g. STG-0001-2.','S-M2 an unreadable code is refused');
select is(public.storage_box_scan('sb-typed-intake','FL:SBOX:STG-0001:1','c2500000-0000-4000-8000-000000000089','STG-0001',1)->>'reason','Storage order not found.','S-M2 an unknown intake is refused');
select set_config('request.headers','',true);
select is(public.storage_box_scan('sb-scanned-ok','FL:SBOX:STG-0001:1','a2500000-0000-4000-8000-000000000081','STG-0001',1)->>'ok','true','S-M3 a scanned code takes the same path');

select results_eq(
  $q$select raw, result::text, entry_method::text, parsed->>'storageBoxId' from public.scan_log where station='storage' order by raw, result::text, entry_method::text$q$,
  $q$values ('FL:SBOX:STG-0001:1','ok','manual','a2500000-0000-4000-8000-000000000091'),
    ('FL:SBOX:STG-0001:1','ok','scan','a2500000-0000-4000-8000-000000000091'),
    ('FL:SBOX:STG-0001:1','rejected','manual',null),
    ('FL:SBOX:STG-0001:2','rejected','manual','a2500000-0000-4000-8000-000000000092'),
    ('FL:SBOX:STG-0001:9','rejected','manual',null),
    ('FL:SBOX:STG-0002:1','rejected','manual',null),
    ('hello','rejected','manual',null)$q$,
  'S-M4 accepted and rejected codes are all logged at storage; typed ones as manual');
select is((select operator_id from public.scan_log where raw='hello'),(select id from public.org_member where display_name='Freezer crew'),'S-M4 the signed-in member is the operator');
select is((select manual_count::int from public.report_manual_entries where station='storage'),6,'S-M4 storage contributes to the manual-entry report');
-- Idempotent replay.
select is(public.storage_box_scan('sb-typed-ok','FL:SBOX:STG-0001:1','a2500000-0000-4000-8000-000000000081','STG-0001',1)->>'ok','true','S-M5 replay returns the stored result');
select is((select count(*)::int from public.scan_log where station='storage'),7,'S-M5 replay logs nothing new');
-- Tenancy.
select set_config('request.jwt.claims','{"role":"authenticated","org_id":"b2500000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
select is(public.storage_box_scan('sb-other-org','FL:SBOX:STG-0001:1','a2500000-0000-4000-8000-000000000081','STG-0001',1)->>'reason','Storage order not found.','S-M6 another org cannot resolve this intake');
reset role;
set local role anon;
select throws_ok($q$select public.storage_box_scan('sb-anon-01','x','a2500000-0000-4000-8000-000000000081')$q$,'42501',null,'S-M6 anonymous callers are denied');
reset role;
select * from finish();
rollback;
