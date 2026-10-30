-- Issue #86: an exchange (untagged) vessel goes reconcile → blast-in → locate → boxing through
-- the id-keyed RPCs (blast_vessel_by_id, locate_vessel_by_id + locate_scan by pending id).
-- Same operator proof, action_log replay and scan_log as the tag path; a tagged vessel, a
-- vessel in another org or a vessel in the wrong state is refused.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Fixture ------------------------------------------------------------------------------
insert into public.org(id,slug,name,timezone) values
 ('a2600000-0000-4000-8000-00000000000a','exchange-a','Exchange A','UTC'),
 ('b2600000-0000-4000-8000-00000000000b','exchange-b','Exchange B','UTC');
-- An org from before v1.1 (#85): 3-digit asset tags; new orgs default to 4.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id in ('a2600000-0000-4000-8000-00000000000a', 'b2600000-0000-4000-8000-00000000000b');
insert into public.site(id,org_id,name) values ('a2600000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a2600000-0000-4000-8000-000000000002','a2600000-0000-4000-8000-00000000000a','Exchange customer');
insert into auth.users(id,email) values ('a2600000-0000-4000-8000-0000000000a1','exchange-test@example.test');
insert into public.org_member(org_id,user_id,role,display_name) values ('a2600000-0000-4000-8000-00000000000a','a2600000-0000-4000-8000-0000000000a1','manager','Exchange operator');
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count) values
 ('a2600000-0000-4000-8000-000000000011','a2600000-0000-4000-8000-00000000000a','INT-0001','a2600000-0000-4000-8000-000000000002','a2600000-0000-4000-8000-000000000001',1),
 ('a2600000-0000-4000-8000-000000000012','a2600000-0000-4000-8000-00000000000a','INT-0002','a2600000-0000-4000-8000-000000000002','a2600000-0000-4000-8000-000000000001',1);
update public.intake set state='holding';
update public.intake set state='processing';
update public.intake set state='rollstock';
update public.intake set state='reconcile';
insert into public.location(org_id,zone,kind,"row",bay,level,depth,code,qr)
select 'a2600000-0000-4000-8000-00000000000a','IF','rack','A',b,1,d::public.location_depth,
  format('IF-A-%s-1-%s',lpad(b::text,2,'0'),d),format('FL:LOC:exchange-a:IF-A-%s-1-%s',lpad(b::text,2,'0'),d)
from generate_series(1,2) b, unnest('{F,R}'::text[]) d;
update public.location set is_active=false where code='IF-A-02-1-R';
insert into public.box_size(id,org_id,name,max_lb,fee) values ('a2600000-0000-4000-8000-0000000000b1','a2600000-0000-4000-8000-00000000000a','Medium',50,10);
insert into public.rate_card(id,org_id,name,is_default) values ('a2600000-0000-4000-8000-0000000000c1','a2600000-0000-4000-8000-00000000000a','Standard',true);

create temp table ids(k text primary key, v uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v from ids where k=p_k $$;
create function pg_temp.keep(p_k text, p_r jsonb) returns jsonb language sql as $$
  insert into ids values (p_k,(p_r->>'vessel_id')::uuid); select p_r
$$;

select set_config('request.jwt.claims','{"sub":"a2600000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2600000-0000-4000-8000-00000000000a","app_role":"manager"}',true);
set local role authenticated;

-- Reconcile: one exchange basket and one tagged vessel on INT-0001; an exchange basket on
-- INT-0002, which stays at reconcile.
select pg_temp.keep('ex',public.reconcile_action('x86-rc-ex','a2600000-0000-4000-8000-000000000011','exchange'));
select public.reconcile_action('x86-rc-ex-w','a2600000-0000-4000-8000-000000000011','manual',p_vessel_id=>pg_temp.id('ex'),p_weight=>10);
select public.admin_asset_tags('x86-pool','[{"code":"042","qr":"FL:TAG:exchange-a:042"}]');
select pg_temp.keep('tagged',public.bind_tag('x86-bind','042','a2600000-0000-4000-8000-000000000011'));
select public.reconcile_action('x86-rc-tag-w','a2600000-0000-4000-8000-000000000011','manual',p_vessel_id=>pg_temp.id('tagged'),p_weight=>12);
select pg_temp.keep('ex2',public.reconcile_action('x86-rc-ex2','a2600000-0000-4000-8000-000000000012','exchange'));
select is(public.send_to_blast('x86-send','a2600000-0000-4000-8000-000000000011')->>'ok','true','#86 exchange intake sent to blast');

-- Released, waiting for blast-in (the blast screen's query) ----------------------------
select is((select array_agg(coalesce(t.code,'Exchange') order by t.code nulls first) from public.vessel v
  join public.intake i on i.id=v.intake_id left join public.asset_tag t on t.id=v.asset_tag_id
  where v.lifecycle_state='occupied' and v.blast_in_at is null and v.stored_at is null and i.state in ('blast_freezer','stored')),
 '{Exchange,042}'::text[],'#86 released-not-blasted vessels are listed, exchange included');

-- Blast in by id: rejections ------------------------------------------------------------
select is(public.blast_vessel_by_id('x86-blast-tagged',pg_temp.id('tagged'))->>'reason','Vessel 042 has a tag; scan the tag','#86 a tagged vessel is never blasted in by id');
select is(public.blast_vessel_by_id('x86-blast-recon',pg_temp.id('ex2'))->>'reason','Intake INT-0002 has not been sent to blast','#86 blast by id refuses an intake still at reconcile');
select is(public.blast_vessel_by_id('x86-blast-unknown','a2600000-0000-4000-8000-0000000000ff')->>'reason','Unknown vessel','#86 blast by id refuses an unknown vessel');
select ok((select blast_in_at is null from public.vessel where id=pg_temp.id('tagged')) and (select blast_in_at is null from public.vessel where id=pg_temp.id('ex2')),'#86 rejected blast-ins stamp nothing');

-- Blast in by id: accepted and idempotent -----------------------------------------------
create temp table blast as select public.blast_vessel_by_id('x86-blast',pg_temp.id('ex')) r;
select is((select r->>'reason' from blast),'In blast: Exchange basket · INT-0001','#86 exchange basket blasted in by id');
select ok((select (r->>'is_exchange')::boolean and r->'tag_code'='null'::jsonb from blast),'#86 blast reply names the basket as exchange, no tag');
create temp table first_in as select blast_in_at from public.vessel where id=pg_temp.id('ex');
select isnt((select blast_in_at from first_in),null,'#86 blast by id stamps blast_in_at');
create temp table scans_before as select count(*)::int n from public.scan_log;
select is(public.blast_vessel_by_id('x86-blast',pg_temp.id('ex')),(select r from blast),'#86 blast by id replay returns the stored result');
select is((select count(*)::int from public.scan_log),(select n from scans_before),'#86 replay writes no second scan_log row');
select is(public.blast_vessel_by_id('x86-blast-again',pg_temp.id('ex'))->>'reason','Already in blast: Exchange basket · INT-0001','#86 repeat tap keeps the first time-in');
select is((select blast_in_at from public.vessel where id=pg_temp.id('ex')),(select blast_in_at from first_in),'#86 blast_in_at unchanged by a repeat');
select ok(exists(select 1 from public.scan_log where station='blast' and result='ok' and vessel_id=pg_temp.id('ex')
  and intake_id='a2600000-0000-4000-8000-000000000011' and parsed->>'kind'='TAP'),'#86 blast tap audited in scan_log');
select is((select count(*)::int from public.scan_log where station='blast' and result='rejected'),3,'#86 rejected blast taps audited');
select is((select action from public.action_log where client_action_id='x86-blast'),'blast.tap','#86 blast tap recorded in action_log');
select throws_ok($q$select public.blast_vessel('x86-blast','042')$q$,null,null,'#86 a tap''s client_action_id cannot be replayed as a different action');

-- Locate: step 1 by tap, step 2 by location scan ----------------------------------------
select is(public.locate_vessel_by_id('x86-loc-tagged',pg_temp.id('tagged'))->>'reason','Vessel 042 has a tag; scan the tag','#86 a tagged vessel is never selected by id at locate');
create temp table step1 as select public.locate_vessel_by_id('x86-loc-1',pg_temp.id('ex')) r;
select is((select r->>'reason' from step1),'Exchange basket · INT-0001 — scan a location','#86 locate step 1 by tap names the basket and intake');
select ok((select r->>'pending_vessel_id'=pg_temp.id('ex')::text and r->'pending_vessel_raw'='null'::jsonb and not (r->>'placed')::boolean from step1),'#86 locate step 1 holds the vessel by id, no tag text');
select is(public.locate_vessel_by_id('x86-loc-1',pg_temp.id('ex')),(select r from step1),'#86 locate tap replay returns the stored result');
create temp table archived as select public.locate_scan('x86-loc-archived','FL:LOC:exchange-a:IF-A-02-1-R',null,p_pending_vessel_id=>pg_temp.id('ex')) r;
select ok((select not (r->>'ok')::boolean and not (r->>'reset')::boolean and r->>'pending_vessel_id'=pg_temp.id('ex')::text from archived),'#86 an archived location keeps the exchange basket pending');
select is((select count(*)::int from public.location_placement),0,'#86 rejected location writes no placement');
-- A tagged vessel's id with no tag text is a stale selection: the tag scan cannot be skipped.
create temp table skip as select public.locate_scan('x86-loc-skip','IF-A-01-1-F',null,p_pending_vessel_id=>pg_temp.id('tagged')) r;
select ok((select r->>'reason'='Selected basket changed since it was chosen; choose it again' and (r->>'reset')::boolean from skip),'#86 a tagged vessel cannot be placed by id alone');
select is((select location_id from public.vessel where id=pg_temp.id('tagged')),null,'#86 the tagged vessel stays unplaced');
create temp table step2 as select public.locate_scan('x86-loc-2','FL:LOC:exchange-a:IF-A-01-1-F',null,p_pending_vessel_id=>pg_temp.id('ex')) r;
select is((select r->>'reason' from step2),'Placed Exchange basket → IF-A-01-1-F','#86 location scan places the exchange basket');
select ok((select (r->>'placed')::boolean and (r->>'reset')::boolean and r->'pending_vessel_id'='null'::jsonb from step2),'#86 placement resets the loop');
select is((select l.code from public.vessel v join public.location l on l.id=v.location_id where v.id=pg_temp.id('ex')),'IF-A-01-1-F','#86 vessel.location_id mirrors the placement');
select ok((select stored_at is not null and blast_out_at is not null from public.vessel where id=pg_temp.id('ex')),'#86 placement stamps stored_at and blast_out_at');
select is((select state::text from public.intake where number='INT-0001'),'stored','#86 first exchange placement moves the intake to stored');
select is(public.locate_scan('x86-loc-2','FL:LOC:exchange-a:IF-A-01-1-F',null,p_pending_vessel_id=>pg_temp.id('ex')),(select r from step2),'#86 placement replay returns the stored result');
select is((select count(*)::int from public.location_placement),1,'#86 placement replay never duplicates history');
select is(public.blast_vessel_by_id('x86-blast-after',pg_temp.id('ex'))->>'reason','Exchange basket already left blast','#86 a located exchange basket cannot re-enter blast');
-- The tagged vessel still uses the tag scan path.
select is(public.blast_vessel('x86-blast-tag','042')->>'reason','In blast: 042 · INT-0001','#86 tagged vessel blasts in by scan as before');
select is(public.place_vessel('042','IF-A-01-1-R','x86-place-tag')->>'reason','Placed 042 → IF-A-01-1-R','#86 tagged vessel located by scan as before');

-- Boxing: the exchange basket is on the pick list and released by tick -------------------
reset role;
insert into public.allocation_session(id,org_id,number,party_customer_id,state) values
 ('a2600000-0000-4000-8000-000000000051','a2600000-0000-4000-8000-00000000000a','ALC-0001','a2600000-0000-4000-8000-000000000002','priced');
insert into public.allocation_intake(org_id,session_id,intake_id) values
 ('a2600000-0000-4000-8000-00000000000a','a2600000-0000-4000-8000-000000000051','a2600000-0000-4000-8000-000000000011');
insert into public.settlement(id,org_id,number,session_id,angler_name) values
 ('a2600000-0000-4000-8000-000000000052','a2600000-0000-4000-8000-00000000000a','STL-0001','a2600000-0000-4000-8000-000000000051','Ann');
insert into public.box_plan(id,org_id,number,settlement_id,session_id,method,box_size_id,weight_lb) values
 ('a2600000-0000-4000-8000-000000000053','a2600000-0000-4000-8000-00000000000a','BOX-0001','a2600000-0000-4000-8000-000000000052',
  'a2600000-0000-4000-8000-000000000051','willcall','a2600000-0000-4000-8000-0000000000b1',20);
set local role authenticated;
select ok(exists(select 1 from public.vessel_walk_order where session_id='a2600000-0000-4000-8000-000000000051'
  and vessel_id=pg_temp.id('ex') and is_exchange and tag_code is null and location_code='IF-A-01-1-F'),'#86 exchange basket on the pick list at its location');
select is(public.release_party('x86-release','a2600000-0000-4000-8000-000000000051','{a2600000-0000-4000-8000-000000000053}',
  jsonb_build_array(
    jsonb_build_object('vessel_id',pg_temp.id('ex'),'lbs_left',0,'ticked',true,'measure',10),
    jsonb_build_object('vessel_id',pg_temp.id('tagged'),'lbs_left',0,'ticked',true,'measure',12)))->>'ok','true','#86 boxing releases the ticked exchange basket');
select is((select lifecycle_state::text from public.vessel where id=pg_temp.id('ex')),'emptied','#86 exchange basket emptied by the release');
select is((select state::text from public.intake where number='INT-0001'),'done','#86 the exchange intake closes (reconcile → blast → locate → boxing)');
select is(public.blast_vessel_by_id('x86-blast-emptied',pg_temp.id('ex'))->>'reason','Exchange basket is not in the freezer','#86 an emptied basket is refused by id (occupancy from lifecycle_state)');
select is(public.locate_vessel_by_id('x86-loc-emptied',pg_temp.id('ex'))->>'reason','Exchange basket is not in the freezer','#86 an emptied basket cannot be selected at locate');

-- Tenancy and operator proof -----------------------------------------------------------
reset role;
select set_config('request.jwt.claims','{"sub":"a2600000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"b2600000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is(public.blast_vessel_by_id('x86-cross-blast',(select v from ids where k='ex2'))->>'reason','Unknown vessel','#86 another org''s vessel is refused at blast');
select is(public.locate_vessel_by_id('x86-cross-locate',(select v from ids where k='ex2'))->>'reason','Unknown vessel','#86 another org''s vessel is refused at locate');
reset role;
select is((select blast_in_at from public.vessel where id=(select v from ids where k='ex2')),null,'#86 cross-org tap stamps nothing');
select set_config('request.jwt.claims','{"sub":"a2600000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2600000-0000-4000-8000-00000000000a","app_role":"station"}',true);
set local role authenticated;
select is(public.blast_vessel_by_id('x86-pin-tap',(select v from ids where k='ex2'))->>'reason','operator_pin_required','#86 station requires live PIN proof for a tap');
reset role;
select * from finish(); rollback;
