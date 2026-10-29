begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Fixture ------------------------------------------------------------------------------
insert into public.org(id,slug,name,timezone) values
 ('a1300000-0000-4000-8000-00000000000a','freezer-a','Freezer A','UTC'),
 ('b1300000-0000-4000-8000-00000000000b','freezer-b','Freezer B','UTC');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('a1300000-0000-4000-8000-00000000000a', 'b1300000-0000-4000-8000-00000000000b');
insert into public.site(id,org_id,name) values ('a1300000-0000-4000-8000-000000000001','a1300000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a1300000-0000-4000-8000-000000000002','a1300000-0000-4000-8000-00000000000a','Freezer customer');
insert into auth.users(id,email) values ('a1300000-0000-4000-8000-0000000000a1','freezer-test@example.test');
insert into public.org_member(org_id,user_id,role,display_name) values ('a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-0000000000a1','manager','Freezer operator');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a1300000-0000-4000-8000-000000000011','a1300000-0000-4000-8000-00000000000a','INT-0001','a1300000-0000-4000-8000-000000000002','a1300000-0000-4000-8000-000000000001',1),
 ('a1300000-0000-4000-8000-000000000012','a1300000-0000-4000-8000-00000000000a','INT-0002','a1300000-0000-4000-8000-000000000002','a1300000-0000-4000-8000-000000000001',1);
update public.intake set state='holding';
update public.intake set state='processing';
update public.intake set state='rollstock';
update public.intake set state='reconcile';
update public.intake set state='blast_freezer' where number='INT-0001';
-- Tag master text as rules/qr.encode produces it; vessels as reconcile leaves them.
insert into public.vessel(id,org_id,intake_id,weight_lb,species_summary) values
 ('a1300000-0000-4000-8000-000000000041','a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-000000000011',20,'Reds'),
 ('a1300000-0000-4000-8000-000000000042','a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-000000000011',18,null),
 ('a1300000-0000-4000-8000-000000000043','a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-000000000012',9,null);
insert into public.asset_tag(org_id,code,qr,state,current_vessel_id) values
 ('a1300000-0000-4000-8000-00000000000a','041','FL:TAG:freezer-a:041','in_use','a1300000-0000-4000-8000-000000000041'),
 ('a1300000-0000-4000-8000-00000000000a','042','FL:TAG:freezer-a:042','in_use','a1300000-0000-4000-8000-000000000042'),
 ('a1300000-0000-4000-8000-00000000000a','043','FL:TAG:freezer-a:043','in_use','a1300000-0000-4000-8000-000000000043');
update public.vessel v set asset_tag_id=t.id from public.asset_tag t where t.current_vessel_id=v.id;

select set_config('request.jwt.claims','{"sub":"a1300000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a1300000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;

-- Generator (rows as rules/locations.generateRackLocations emits them) -----------------
create temp table rack as select jsonb_agg(jsonb_build_object('kind','rack','zone','IF','row',r,'bay',b,'level',lv,'depth',d,
  'code',format('IF-%s-%s-%s-%s',r,lpad(b::text,2,'0'),lv,d),'qr',format('FL:LOC:freezer-a:IF-%s-%s-%s-%s',r,lpad(b::text,2,'0'),lv,d))) j
 from (values ('A',2,2),('AA',1,1)) rows(r,nb,nl), generate_series(1,nb) b, generate_series(1,nl) lv, unnest('{F,R}'::text[]) d;
select is(public.admin_locations('wp13-gen-1','generate',(select j from rack)),'{"inserted":10,"existing":0}'::jsonb,'WP13 generator upserts every rack position');
select is(public.admin_locations('wp13-gen-2','generate',(select j from rack)),'{"inserted":0,"existing":10}'::jsonb,'WP13 generator idempotent: rerun inserts nothing');
select is((select count(*)::int from public.location),10,'WP13 generator idempotent: no duplicate rows');
select is(public.admin_locations('wp13-pallet','pallet','[{"kind":"pallet","zone":"IF","code":"IF-PALLET-01","qr":"FL:LOC:freezer-a:IF-PALLET-01"}]')->>'inserted','1','WP13 pallet/quarantine location created');
select throws_ok($q$select public.admin_locations('wp13-pallet-dup','pallet','[{"kind":"pallet","zone":"IF","code":"IF-PALLET-01","qr":"FL:LOC:freezer-a:IF-PALLET-01"}]')$q$,
 'P0001','Location IF-PALLET-01 already exists','WP13 duplicate pallet rejected');
select throws_ok($q$select public.admin_locations('wp13-pallet-grid','pallet','[{"kind":"pallet","zone":"IF","code":"IF-A-09-1-F","qr":"FL:LOC:freezer-a:IF-A-09-1-F"}]')$q$,
 '23514',null,'WP13 pallet code never grid-shaped');
select throws_ok($q$select public.admin_locations('wp13-rack-pallet','generate','[{"kind":"rack","zone":"IF","row":"A","bay":1,"level":1,"depth":"F","code":"IF-PALLET-02","qr":"FL:LOC:freezer-a:IF-PALLET-02"}]')$q$,
 '23514',null,'WP13 generator never stores a pallet-shaped rack code');
select throws_ok($q$select public.admin_locations('wp13-rack-row-pallet','generate','[{"kind":"rack","zone":"IF","row":"PALLET","bay":1,"level":1,"depth":"F","code":"IF-PALLET-01-1-F","qr":"FL:LOC:freezer-a:IF-PALLET-01-1-F"}]')$q$,
 '23514',null,'WP13 rack row can never be PALLET');
select throws_ok($q$select public.admin_locations('wp13-gen-mixed','generate','[{"kind":"pallet","zone":"IF","code":"IF-PALLET-05","qr":"x"}]')$q$,
 'P0001',null,'WP13 generator refuses pallet rows');
select is((select count(*)::int from public.location),11,'WP13 rejected rows leave master unchanged');

-- Archive guard ------------------------------------------------------------------------
select is(public.admin_locations('wp13-archive','archive',p_location_id=>(select id from public.location where code='IF-A-02-2-R'))->>'is_active','false','WP13 archive location');
reset role;
select throws_ok($q$delete from public.location where code='IF-A-02-2-R'$q$,'55000','locations are archived, not deleted','WP13 locations are archived, not deleted');
set local role authenticated;

-- Blast --------------------------------------------------------------------------------
create temp table blast as select public.blast_vessel('wp13-blast','FL:TAG:freezer-a:041') r;
select is((select r->>'ok' from blast),'true','WP13 blast scan accepted');
select isnt((select blast_in_at from public.vessel where id='a1300000-0000-4000-8000-000000000041'),null,'WP13 blast scan stamps blast_in_at');
select is(public.blast_vessel('wp13-blast','FL:TAG:freezer-a:041'),(select r from blast),'WP13 blast replay returns stored result');
select is(public.blast_vessel('wp13-blast-again','41')->>'reason','Already in blast: 041 · INT-0001','WP13 bare padded tag accepted; repeat scan keeps first time-in');
select is(public.blast_vessel('wp13-blast-recon','043')->>'reason','Intake INT-0002 has not been sent to blast','WP13 blast refuses vessel still at reconcile');
select is(public.blast_vessel('wp13-blast-unknown','999')->>'reason','Unknown tag','WP13 unknown tag rejected at blast');

-- Locate: rejections -------------------------------------------------------------------
select is(public.place_vessel('042','FL:LOC:freezer-a:IF-A-02-2-R','wp13-place-archived')->>'reason','location IF-A-02-2-R is archived and cannot be bound','WP13 archived location rejected');
select is(public.place_vessel('042','FL:LOC:freezer-a:IF-Z-01-1-F','wp13-place-unknown')->>'reason','Unknown location','WP13 unknown location rejected');
select is(public.place_vessel('042','FL:LOC:freezer-b:IF-A-01-1-F','wp13-place-other-org-qr')->>'reason','Unknown location','WP13 another org''s location QR rejected');
select is(public.place_vessel('043','IF-A-01-1-F','wp13-place-recon')->>'reason','Intake INT-0002 has not been sent to blast','WP13 locate refuses intake not sent to blast');
select is((select count(*)::int from public.location_placement),0,'WP13 rejected placements write no history');
select is((select count(*)::int from public.scan_log where station='locate' and result='rejected'),4,'WP13 rejected locate scans audited');
select is((select state::text from public.intake where number='INT-0001'),'blast_freezer','WP13 rejection leaves intake in blast');

-- Locate: placement --------------------------------------------------------------------
create temp table placed as select public.place_vessel('FL:TAG:freezer-a:041','FL:LOC:freezer-a:IF-A-01-1-F','wp13-place-1') r;
select is((select r->>'reason' from placed),'Placed 041 → IF-A-01-1-F','WP13 place_vessel accepted');
select is((select count(*)::int from public.location_placement),1,'WP13 place appends location_placement');
select is((select l.code from public.vessel v join public.location l on l.id=v.location_id where v.id='a1300000-0000-4000-8000-000000000041'),'IF-A-01-1-F','WP13 vessel.location_id mirrors placement');
select is((select state::text from public.intake where number='INT-0001'),'stored','WP13 first placement moves intake to stored');
select isnt((select stored_at from public.intake where number='INT-0001'),null,'WP13 stored_at stamped');
select ok((select stored_at is not null and blast_out_at is not null from public.vessel where id='a1300000-0000-4000-8000-000000000041'),'WP13 placement stamps vessel stored_at and blast_out_at');
select is((select count(*)::int from public.domain_event where kind='intake_stored'),1,'WP13 intake_stored event emitted');
select is(public.place_vessel('FL:TAG:freezer-a:041','FL:LOC:freezer-a:IF-A-01-1-F','wp13-place-1'),(select r from placed),'WP13 place replay returns stored result');
select is((select count(*)::int from public.location_placement),1,'WP13 place replay never duplicates history');
select is(public.blast_vessel('wp13-blast-after','041')->>'reason','Vessel 041 already left blast','WP13 located vessel cannot re-enter blast');
-- Two baskets on one position, capacity notwithstanding (DECISION-14).
reset role;
update public.location set capacity=1 where code='IF-A-01-1-F';
set local role authenticated;
select is(public.place_vessel('042','IF-A-01-1-F','wp13-place-2')->>'ok','true','WP13 no capacity gating');
select is((select count(*)::int from public.domain_event where kind='intake_stored'),1,'WP13 intake moves to stored only once');
select is(public.place_vessel('042','if-pallet-01','wp13-relocate')->>'reason','Placed 042 → IF-PALLET-01','WP13 relocate by bare code appends history');
select is((select array_agg(l.code order by p.placed_at, p.created_at) from public.location_placement p join public.location l on l.id=p.location_id where p.vessel_id='a1300000-0000-4000-8000-000000000042'),
 '{IF-A-01-1-F,IF-PALLET-01}'::text[],'WP13 placement history is append-only per vessel');
select is(public.place_vessel('042','IF-PALLET-01','wp13-same-spot')->>'reason','042 already at IF-PALLET-01','WP13 rescan at current location writes no duplicate');
select is(public.admin_locations('wp13-archive-occupied','archive',p_location_id=>(select id from public.location where code='IF-PALLET-01'))->>'occupied_vessels','1','WP13 archive reports occupied vessels left in place');
select is((select l.code from public.vessel v join public.location l on l.id=v.location_id where v.id='a1300000-0000-4000-8000-000000000042'),'IF-PALLET-01','WP13 archiving never strands a placed vessel');
select is(public.admin_locations('wp13-unarchive','unarchive',p_location_id=>(select id from public.location where code='IF-PALLET-01'))->>'is_active','true','WP13 unarchive location');

-- Locate: two-step loop ----------------------------------------------------------------
select is(public.locate_scan('wp13-loop-noves','FL:LOC:freezer-a:IF-A-01-2-F')->>'reason','Scan a vessel tag first','WP13 loop needs a vessel before a location');
create temp table step1 as select public.locate_scan('wp13-loop-1','FL:TAG:freezer-a:041') r;
select is((select r->>'pending_vessel_raw' from step1),'FL:TAG:freezer-a:041','WP13 loop step 1 holds the vessel');
select is((select r->>'pending_vessel_id' from step1),'a1300000-0000-4000-8000-000000000041','WP13 loop step 1 returns the selected vessel identity');
select is((select r->>'intake_number' || ' ' || (r->>'species') from step1),'INT-0001 Reds','WP13 loop step 1 shows intake and species');
select is(public.locate_scan('wp13-loop-archived','FL:LOC:freezer-a:IF-A-02-2-R','FL:TAG:freezer-a:041',p_pending_vessel_id=>'a1300000-0000-4000-8000-000000000041')->>'pending_vessel_raw','FL:TAG:freezer-a:041','WP13 loop keeps vessel pending after a rejected location');
create temp table step2 as select public.locate_scan('wp13-loop-2','FL:LOC:freezer-a:IF-A-01-2-F','FL:TAG:freezer-a:041',p_pending_vessel_id=>'a1300000-0000-4000-8000-000000000041') r;
select ok((select (r->>'placed')::boolean and r->'pending_vessel_raw'='null'::jsonb from step2),'WP13 loop step 2 places and resets');
create temp table noid as select public.locate_scan('wp13-loop-noid','FL:LOC:freezer-a:IF-A-01-2-F','FL:TAG:freezer-a:042') r;
select ok((select r->>'reason'='Vessel selection expired; scan the tag again' and (r->>'reset')::boolean and r->'pending_vessel_raw'='null'::jsonb from noid),'WP13 loop refuses a pending tag without its selected vessel');
select is(public.locate_scan('wp13-loop-bad','NOT-A-THING')->>'reason','Unknown tag','WP13 loop rejects unknown scan');

-- Walk order (boxing pick list) --------------------------------------------------------
reset role;
insert into public.allocation_session(id,org_id,number) values ('a1300000-0000-4000-8000-000000000051','a1300000-0000-4000-8000-00000000000a','ALC-0001');
insert into public.allocation_intake(org_id,session_id,intake_id) values ('a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-000000000051','a1300000-0000-4000-8000-000000000011');
-- Untagged exchange baskets fill out the sample; one emptied basket must not appear.
insert into public.vessel(org_id,intake_id,is_exchange,weight_lb,location_id,lifecycle_state)
select 'a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-000000000011',true,5,(select id from public.location where code=c),s::public.vessel_lifecycle_state
from (values ('IF-AA-01-1-F','occupied'),('IF-A-02-1-F','occupied'),('IF-A-01-1-R','occupied'),(null,'occupied'),('IF-A-01-1-R','emptied')) x(c,s);
set local role authenticated;
select is((select array_agg(coalesce(location_code,'-') order by walk_seq) from public.vessel_walk_order where session_id='a1300000-0000-4000-8000-000000000051'),
 '{IF-A-01-1-R,IF-A-01-2-F,IF-A-02-1-F,IF-AA-01-1-F,IF-PALLET-01,-}'::text[],'WP13 walk order: row → bay → level → F before R, A before AA, pallets then unlocated last');
select is((select count(*)::int from public.vessel_walk_order where location_code='IF-A-01-1-R'),1,'WP13 walk order lists occupied vessels only');
select ok((select sort_key from public.location where code='IF-A-01-1-F') < (select sort_key from public.location where code='IF-A-01-1-R')
  and (select sort_key from public.location where code='IF-A-01-2-R') < (select sort_key from public.location where code='IF-A-02-1-F'),'WP13 sort_key F before R, level before bay');

-- Stale selection: tag released and rebound between the two scans -----------------------
set local role authenticated;
create temp table stale1 as select public.locate_scan('wp13-stale-1','FL:TAG:freezer-a:041') r;
reset role;
-- Vessel A (041's holder at step 1) is fully pulled; tag 041 is rebound to a new vessel B.
update public.vessel set lifecycle_state='emptied',location_id=null where id='a1300000-0000-4000-8000-000000000041';
update public.asset_tag set state='available',current_vessel_id=null where code='041';
insert into public.vessel(id,org_id,intake_id,weight_lb,asset_tag_id)
 select 'a1300000-0000-4000-8000-000000000044','a1300000-0000-4000-8000-00000000000a','a1300000-0000-4000-8000-000000000011',7,id
 from public.asset_tag where code='041';
update public.asset_tag set state='in_use',current_vessel_id='a1300000-0000-4000-8000-000000000044' where code='041';
create temp table placements_before as select count(*)::int n from public.location_placement;
grant select on placements_before to authenticated;
set local role authenticated;
create temp table stale2 as select public.locate_scan('wp13-stale-2','FL:LOC:freezer-a:IF-A-01-1-F',
 (select r->>'pending_vessel_raw' from stale1),p_pending_vessel_id=>(select (r->>'pending_vessel_id')::uuid from stale1)) r;
select is((select r->>'reason' from stale2),'Selected vessel changed since its tag was scanned; scan the tag again','WP13 release/rebind between scans rejects the stale selection');
select ok((select (r->>'reset')::boolean and r->'pending_vessel_raw'='null'::jsonb and r->'pending_vessel_id'='null'::jsonb from stale2),'WP13 stale selection resets the loop');
select is((select location_id from public.vessel where id='a1300000-0000-4000-8000-000000000044'),null,'WP13 stale selection never places the tag''s new holder');
select is((select count(*)::int from public.location_placement),(select n from placements_before),'WP13 stale selection writes no placement');
select is(public.place_vessel('041','IF-A-01-1-F','wp13-stale-direct',p_expected_vessel_id=>'a1300000-0000-4000-8000-000000000041')->>'ok','false','WP13 place_vessel honours an expected vessel identity');
reset role;

-- Tenancy and operator proof -----------------------------------------------------------
reset role;
select set_config('request.jwt.claims','{"sub":"a1300000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"b1300000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is(public.place_vessel('FL:TAG:freezer-a:041','FL:LOC:freezer-a:IF-A-01-1-F','wp13-cross')->>'reason','Unknown tag','WP13 cross tenant placement refused');
select is_empty('select * from public.location','WP13 cross tenant locations hidden');
reset role;
select set_config('request.jwt.claims','{"sub":"a1300000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a1300000-0000-4000-8000-00000000000a","app_role":"station"}',true);
set local role authenticated;
select is(public.blast_vessel('wp13-pin','041')->>'reason','operator_pin_required','WP13 station requires live PIN proof');
select throws_ok($q$select public.admin_locations('wp13-station-admin','archive',p_location_id=>(select id from public.location limit 1))$q$,'42501',null,'WP13 stations cannot manage locations');
reset role;
select * from finish(); rollback;
