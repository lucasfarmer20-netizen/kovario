begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into public.org(id,slug,name,timezone) values ('a0000000-0000-4000-8000-00000000000a','rollstock-a','Wave A','UTC'),('b0000000-0000-4000-8000-00000000000b','rollstock-b','Wave B','UTC');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b');
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

update public.intake set state='processing';
update public.intake set state='rollstock';
update public.intake set state='reconcile';
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select public.admin_asset_tags('wp12-rc-pool','[{"code":"042","qr":"FL:TAG:rollstock-a:042"},{"code":"043","qr":"FL:TAG:rollstock-a:043"}]');
select is((select count(*)::int from public.asset_tag),2,'WP12 create tag range');
select public.admin_asset_tags('wp12-rc-pool-repeat','[{"code":"042","qr":"FL:TAG:rollstock-a:042"}]');
select is((select count(*)::int from public.asset_tag),2,'WP12 create range is repeat-safe');
select is(public.send_to_blast('wp12-rc-empty','a0000000-0000-4000-8000-000000000011')->>'ok','false','WP12 send gate rejects empty vessel list');
create temp table binding as select public.bind_tag('wp12-rc-bind','0042','a0000000-0000-4000-8000-000000000011') r;
select is((select r->>'ok' from binding),'true','WP12 scan binds tag immediately');
select is((select state::text from public.asset_tag where code='042'),'in_use','WP12 tag becomes in use at scan');
select is((select lifecycle_state::text from public.vessel),'occupied','WP12 scanned vessel is occupied');
select is(public.bind_tag('wp12-rc-bind','042','a0000000-0000-4000-8000-000000000011'),(select r from binding),'WP12 bind action replay returns same vessel');
select is((select count(*)::int from public.vessel),1,'WP12 replay never duplicates vessel');
select is(public.bind_tag('wp12-rc-conflict','042','a0000000-0000-4000-8000-000000000012')->>'reason','Tag 042 in use by INT-0001','WP12 in-use tag rejected naming holder');
select is(public.bind_tag('wp12-padding-42','42','a0000000-0000-4000-8000-000000000012')->>'reason','Tag 042 in use by INT-0001','WP12 direct RPC padding variants resolve to same holder');
select is(public.bind_tag('wp12-rc-unknown','999','a0000000-0000-4000-8000-000000000011')->>'reason','Unknown tag','WP12 unknown tag rejected');
select is(public.send_to_blast('wp12-rc-zero','a0000000-0000-4000-8000-000000000011')->>'ok','false','WP12 send gate rejects zero weight');
select public.reconcile_action('wp12-rc-manual','a0000000-0000-4000-8000-000000000011','manual',p_vessel_id=>(select (r->>'vessel_id')::uuid from binding),p_weight=>12);
select ok((select manual and weight_lb=12 from public.vessel),'WP12 manual entry flagged');
select public.reconcile_action('wp12-rc-remove','a0000000-0000-4000-8000-000000000011','remove',p_vessel_id=>(select (r->>'vessel_id')::uuid from binding));
select is((select state::text from public.asset_tag where code='042'),'available','WP12 remove before send frees tag');
select is((select count(*)::int from public.vessel),0,'WP12 remove deletes unsent row');
select public.admin_asset_tags('wp12-rc-retire',p_tag_id=>(select id from public.asset_tag where code='042'),p_retire_reason=>'Damaged');
select is(public.bind_tag('wp12-rc-retired','042','a0000000-0000-4000-8000-000000000011')->>'reason','Tag retired','WP12 retired tags rejected');
select public.admin_asset_tags('wp12-rc-reactivate',p_tag_id=>(select id from public.asset_tag where code='042'));
select is((select state::text from public.asset_tag where code='042'),'available','WP12 reactivate tag');
create temp table exchange as select public.reconcile_action('wp12-rc-exchange','a0000000-0000-4000-8000-000000000011','exchange') r;
select ok((select is_exchange and asset_tag_id is null and lifecycle_state='occupied' from public.vessel),'WP12 exchange vessel allowed without tag and remains occupied');
select public.reconcile_action('wp12-rc-exchange-weight','a0000000-0000-4000-8000-000000000011','manual',p_vessel_id=>(select (r->>'vessel_id')::uuid from exchange),p_weight=>10);
select is(public.send_to_blast('wp12-rc-send','a0000000-0000-4000-8000-000000000011')->>'ok','true','WP12 exchange sends without tag');
select is((select state::text from public.intake where number='INT-0001'),'blast_freezer','WP12 send transitions intake to blast');
select is(public.reconcile_action('wp12-rc-after-send','a0000000-0000-4000-8000-000000000011','remove',p_vessel_id=>(select (r->>'vessel_id')::uuid from exchange))->>'ok','false','WP12 edits refused after send');
select is(public.reconcile_action('wp12-rc-scan-unknown','a0000000-0000-4000-8000-000000000012','bind',p_code=>'999',p_raw=>'999')->>'ok','false','WP12 rejected scan is audited');
select is((select count(*)::int from public.scan_log where station='reconcile' and result='rejected'),1,'WP12 rejected scan log');
reset role;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"b0000000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is_empty('select * from public.vessel','WP12 cross tenant vessels hidden');
select is(public.bind_tag('wp12-rc-cross','043','a0000000-0000-4000-8000-000000000012')->>'ok','false','WP12 cross tenant bind refused');
reset role;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"station"}',true);
set local role authenticated;
select is(public.bind_tag('wp12-rc-pin','043','a0000000-0000-4000-8000-000000000012')->>'reason','operator_pin_required','WP12 station requires live PIN proof');
reset role;

insert into public.vessel(id,org_id,intake_id,weight_lb) values('a0000000-0000-4000-8000-000000000031','a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000012',10);
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;
select is(public.send_to_blast('wp12-no-tag-gate','a0000000-0000-4000-8000-000000000012')->>'ok','false','WP12 positive non-exchange vessel still requires tag');
reset role;
delete from public.vessel where id='a0000000-0000-4000-8000-000000000031';
insert into public.print_agent(id,org_id,name,auth_user_id) values ('a0000000-0000-4000-8000-000000000021','a0000000-0000-4000-8000-00000000000a','Scale agent','a0000000-0000-4000-8000-0000000000a1');
insert into public.scale(id,org_id,name,agent_id,protocol,port) values
 ('a0000000-0000-4000-8000-000000000022','a0000000-0000-4000-8000-00000000000a','Assigned','a0000000-0000-4000-8000-000000000021','toledo_8217','COM3'),
 ('a0000000-0000-4000-8000-000000000023','a0000000-0000-4000-8000-00000000000a','Other',null,'manual',null);
insert into public.device(id,org_id,name,station,auth_user_id,scale_id) values ('a0000000-0000-4000-8000-000000000024','a0000000-0000-4000-8000-00000000000a','Reconcile device','reconcile','a0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-000000000022');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"agent","agent_id":"a0000000-0000-4000-8000-000000000021"}',true);
set local role authenticated;
select lives_ok($q$select public.record_scale_reading('wp12-scale-write','a0000000-0000-4000-8000-000000000022',15,true)$q$,'WP12 agent writes assigned scale');
select public.record_scale_reading('wp12-scale-write','a0000000-0000-4000-8000-000000000022',15,true);
select is((select count(*)::int from public.scale_reading),1,'WP12 scale action replay does not duplicate');
select is((select count(*)::int from public.scale),1,'WP12 agent reads only assigned scales');
select throws_ok($q$select public.record_scale_reading('wp12-scale-other','a0000000-0000-4000-8000-000000000023',100,true)$q$,'42501','Scale not assigned to agent','WP12 agent cannot write unassigned scale');
reset role;
insert into public.scale_reading(org_id,scale_id,weight_lb,stable,read_at) values
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000022',99,false,now()+interval '1 second'),
 ('a0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000023',999,true,now()+interval '2 seconds');
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager","device_id":"a0000000-0000-4000-8000-000000000024"}',true);
set local role authenticated;
create temp table scaled as select public.bind_tag('wp12-scaled-bind','43','a0000000-0000-4000-8000-000000000012') r;
select is(public.reconcile_action('wp12-scale-accept','a0000000-0000-4000-8000-000000000012','accept',p_vessel_id=>(select (r->>'vessel_id')::uuid from scaled))->>'ok','true','WP12 Accept uses stable reading');
select ok((select weight_lb=15 and not manual and scale_reading_id is not null from public.vessel where intake_id='a0000000-0000-4000-8000-000000000012'),'WP12 Accept ignores unstable and other-device readings, flags scale provenance');
select throws_ok($q$select public.admin_asset_tags('wp12-retire-inuse',p_tag_id=>(select id from public.asset_tag where code='043'),p_retire_reason=>'Damaged')$q$,'P0001','Tag in use','WP12 in-use tag cannot retire');
select is(public.send_to_blast('wp12-scaled-send','a0000000-0000-4000-8000-000000000012')->>'ok','true','WP12 tagged positive vessel passes send gate');
reset role;
insert into public.printer(id,org_id,name,agent_id,kind,address) values('a0000000-0000-4000-8000-000000000032','a0000000-0000-4000-8000-00000000000a','Tag printer','a0000000-0000-4000-8000-000000000021','label_zpl','printer.local:9100');
set local role authenticated;
select lives_ok($q$select public.enqueue_print_job('wp12-tag-sheet-print','a0000000-0000-4000-8000-000000000032','asset_tag_sheet','zpl','^XA^XZ')$q$,'WP12 asset tag sheet queues to configured label printer');
reset role;
select * from finish(); rollback;
