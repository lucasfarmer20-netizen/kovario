-- Issue #88: suspect picker, move bin between orders, pull back from blast. The picker shows the
-- hold group (flagged intake, 1 before, 2 after in rollstock order) with each member's variance,
-- species, size and status; a manager moves a vessel (tag and weight) between group intakes at
-- reconcile in one SQL function (lock order, action_log, intake_history on both intakes), and a
-- group back within the limit clears its hold automatically; a manager pulls an intake in blast
-- back to reconcile (reason, intake_history), clearing its vessels' blast time.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Fixture ------------------------------------------------------------------------------------
insert into public.org(id,slug,name,timezone) values
 ('a2800000-0000-4000-8000-00000000000a','suspect-a','Suspect A','UTC'),
 ('b2800000-0000-4000-8000-00000000000b','suspect-b','Suspect B','UTC');
insert into public.site(id,org_id,name) values ('a2800000-0000-4000-8000-000000000001','a2800000-0000-4000-8000-00000000000a','Main');
insert into public.customer(id,org_id,name) values ('a2800000-0000-4000-8000-000000000002','a2800000-0000-4000-8000-00000000000a','Suspect customer');
insert into public.species(org_id,code,name,"group") values
 ('a2800000-0000-4000-8000-00000000000a','salmon','Salmon','salmon'),
 ('a2800000-0000-4000-8000-00000000000a','halibut','Halibut','whitefish');
insert into public.incoming_condition(org_id,code,name) values ('a2800000-0000-4000-8000-00000000000a','whole','Whole');
insert into public.processing_method(org_id,code,name) values ('a2800000-0000-4000-8000-00000000000a','fillets','Fillets');
insert into auth.users(id,email) values
 ('a2800000-0000-4000-8000-0000000000a1','suspect-manager@example.test'),
 ('a2800000-0000-4000-8000-0000000000a2','suspect-staff@example.test');
insert into public.org_member(id,org_id,user_id,role,display_name) values
 ('a2800000-0000-4000-8000-0000000000b1','a2800000-0000-4000-8000-00000000000a','a2800000-0000-4000-8000-0000000000a1','manager','Suspect manager'),
 ('a2800000-0000-4000-8000-0000000000b2','a2800000-0000-4000-8000-00000000000a','a2800000-0000-4000-8000-0000000000a2','staff','Suspect staff');
-- Org B's own intake: a real id from another org (review #99).
insert into public.customer(id,org_id,name) values ('b2800000-0000-4000-8000-000000000002','b2800000-0000-4000-8000-00000000000b','Other customer');
insert into public.intake(id,org_id,number,customer_id,tote_count) values
 ('b2800000-0000-4000-8000-0000000000ff','b2800000-0000-4000-8000-00000000000b','INT-0001','b2800000-0000-4000-8000-000000000002',1);
insert into public.asset_tag(org_id,code,qr) values ('a2800000-0000-4000-8000-00000000000a','0042','FL:TAG:suspect-a:0042');
-- INT-0001..0005 each expect 50 lb (100 lb × 0.5); INT-0002 also carries halibut (expects 60 lb).
insert into public.intake(id,org_id,number,customer_id,site_id,tote_count)
select ('a2800000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,'a2800000-0000-4000-8000-00000000000a',
  'INT-00'||lpad(n::text,2,'0'),'a2800000-0000-4000-8000-000000000002','a2800000-0000-4000-8000-000000000001',1
from generate_series(1,5) n;
insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
select org_id,id,'salmon','whole','fillets',100,0.5 from public.intake where org_id='a2800000-0000-4000-8000-00000000000a';
insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
select org_id,id,'halibut','whole','fillets',20,0.5 from public.intake where number='INT-0002' and org_id='a2800000-0000-4000-8000-00000000000a';
insert into public.tote_tag(org_id,intake_id,tote_no,of_count,qr)
select org_id,id,1,1,'FL:TOTE:'||number||':1' from public.intake where org_id='a2800000-0000-4000-8000-00000000000a';
update public.intake set state='holding' where org_id='a2800000-0000-4000-8000-00000000000a';
update public.intake set state='processing' where org_id='a2800000-0000-4000-8000-00000000000a';

create temp table ids(k text primary key, v uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select v from ids where k=p_k $$;
create function pg_temp.intake(p_number text) returns uuid language sql as $$
  select id from public.intake where number=p_number and org_id='a2800000-0000-4000-8000-00000000000a' $$;
create function pg_temp.state(p_number text) returns text language sql as $$
  select state::text from public.intake where id=pg_temp.intake(p_number) $$;
-- An exchange bin weighed manually, kept as ids[p_key].
create function pg_temp.bin(p_number text, p_key text, p_lb numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.reconcile_action('v88-ex-'||p_key,pg_temp.intake(p_number),'exchange');
  insert into ids values (p_key,(r->>'vessel_id')::uuid);
  return public.reconcile_action('v88-w-'||p_key,pg_temp.intake(p_number),'manual',p_vessel_id=>(r->>'vessel_id')::uuid,p_weight=>p_lb);
end $$;
create function pg_temp.send(p_number text, p_key text) returns jsonb language sql as $$
  select public.send_to_blast(p_key,pg_temp.intake(p_number))
$$;
create function pg_temp.move(p_key text, p_bin text, p_to text, p_center text, p_token text default null) returns jsonb language sql as $$
  select public.variance_move_vessel(p_key,pg_temp.id(p_bin),pg_temp.intake(p_to),pg_temp.intake(p_center),p_token)
$$;
create function pg_temp.group_of(p_number text) returns text[] language sql as $$
  select array_agg(intake_number||' '||position||' '||status order by position)
  from public.variance_suspect_group(pg_temp.intake(p_number)) $$;
create function pg_temp.scan(p_raw text, p_open text, p_key text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r:=public.rollstock_scan_advance(p_raw,pg_temp.intake(p_open),p_key);
  if r->>'scan_id' is not null then insert into ids values (p_key,(r->>'scan_id')::uuid); end if;
  return r;
end $$;
create function pg_temp.as_manager() returns void language sql as $$
  select set_config('request.jwt.claims','{"sub":"a2800000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2800000-0000-4000-8000-00000000000a","app_role":"manager"}',true) $$;
create function pg_temp.as_staff() returns void language sql as $$
  select set_config('request.jwt.claims','{"sub":"a2800000-0000-4000-8000-0000000000a2","role":"authenticated","org_id":"a2800000-0000-4000-8000-00000000000a","app_role":"staff"}',true) $$;

select pg_temp.as_manager();
set local role authenticated;

-- Rollstock opens INT-0001..0004 in order; INT-0004 is still on the line (rollstock).
select pg_temp.scan('FL:TOTE:INT-0001:1',null,'v88-rs-1');
select pg_temp.scan('FL:TOTE:INT-0002:1','INT-0001','v88-rs-2');
select pg_temp.scan('FL:TOTE:INT-0003:1','INT-0002','v88-rs-3');
select pg_temp.scan('FL:TOTE:INT-0004:1','INT-0003','v88-rs-4');
reset role;
update public.scan_log s set scanned_at='2026-07-20 08:00Z'::timestamptz+(substr(k,8)::int*interval '1 minute')
from ids where ids.v=s.id and ids.k like 'v88-rs-_';
set local role authenticated;

-- INT-0001 within → blast. INT-0002: a 64 lb bin and tag 0042 at 20 lb = 84 lb against 60 (+40%).
-- INT-0003: 30 lb against 50 (−40%).
select pg_temp.bin('INT-0001','b1',50);
select is(pg_temp.send('INT-0001','v88-send-1')->>'ok','true','fixture: INT-0001 within the limit goes to blast');
select pg_temp.bin('INT-0002','b2a',64);
create temp table bound as select public.reconcile_action('v88-bind',pg_temp.intake('INT-0002'),'bind',p_code=>'0042') r;
insert into ids select 'b2tag',(r->>'vessel_id')::uuid from bound;
select public.reconcile_action('v88-w-tag',pg_temp.intake('INT-0002'),'manual',p_vessel_id=>pg_temp.id('b2tag'),p_weight=>20);
create temp table flag as select pg_temp.send('INT-0002','v88-send-2') r;
select is((select r->>'ok' from flag),'false','fixture: INT-0002 at +40% is held');
insert into ids select 'hold',((select r from flag)->>'variance_hold_id')::uuid;
select pg_temp.bin('INT-0003','b3',30);

-- PK-G: the picker's group -------------------------------------------------------------------------
select is(pg_temp.group_of('INT-0002'),
  '{"INT-0001 -1 in_blast","INT-0002 0 reconciled","INT-0003 1 reconciled","INT-0004 2 upstream"}'::text[],
  'PK-G1 the hold group in rollstock order, with each member''s status');
select ok((select bool_and(center_intake_id=pg_temp.intake('INT-0002') and hold_id=pg_temp.id('hold'))
  from public.variance_suspect_group(pg_temp.intake('INT-0002'))),'PK-G1 centred on the flagged intake, with its hold');
select is((select array_agg(intake_number order by position) from public.variance_suspect_group(pg_temp.intake('INT-0002')) where waiting),
  '{INT-0004}'::text[],'PK-G1 the unreconciled member is waiting');
select ok((select expected_lb=60 and actual_lb=84 and variance_pct=40 and band='over' and species='{halibut,salmon}'
  and vessels=2 and unweighed=0 and blocked from public.variance_suspect_group(pg_temp.intake('INT-0002')) where position=0),
  'PK-G1 each member carries variance, species, size (expected yield) and whether it is blocked');
select ok((select expected_lb=50 and actual_lb=50 and variance_pct=0 and species='{salmon}' and not blocked
  from public.variance_suspect_group(pg_temp.intake('INT-0002')) where position=-1),'PK-G1 a member in blast reads its sent weight and is not blocked');
select is(pg_temp.group_of('INT-0003'),pg_temp.group_of('INT-0002'),'PK-G2 a neighbour opens the same hold group, centred on the flagged intake');
select is((select array_agg(intake_number order by position) from public.variance_suspect_group(pg_temp.intake('INT-0002'))),
  (select array_agg(intake_number order by position) from public.variance_hold_member where hold_id=pg_temp.id('hold')),
  'PK-G2 the picker group is #87''s variance_hold_member group');

-- INT-0005 opens (INT-0004 reaches reconcile, unweighed), then rollstock finishes.
select pg_temp.scan('FL:TOTE:INT-0005:1','INT-0004','v88-rs-5');
select pg_temp.scan(null,'INT-0005','v88-rs-finish');
reset role;
update public.scan_log s set scanned_at='2026-07-20 08:00Z'::timestamptz+(substr(k,8)::int*interval '1 minute')
from ids where ids.v=s.id and ids.k='v88-rs-5';
set local role authenticated;
select is(pg_temp.group_of('INT-0002'),
  '{"INT-0001 -1 in_blast","INT-0002 0 reconciled","INT-0003 1 reconciled","INT-0004 2 at_reconcile"}'::text[],
  'PK-G3 at reconcile with no weighed vessel is still waiting; INT-0005 (3 after) is outside the group');

-- PK-M: move bin, refusals ------------------------------------------------------------------------
reset role;
select pg_temp.as_staff();
set local role authenticated;
select throws_ok($q$select pg_temp.move('v88-m-staff','b2tag','INT-0003','INT-0002')$q$,'42501','manager approval required','PK-M1 a non-manager cannot move a bin without a manager PIN');
reset role;
select pg_temp.as_manager();
set local role authenticated;
select throws_ok($q$select pg_temp.move('v88-m-blast','b2tag','INT-0001','INT-0002')$q$,'22023',
  'INT-0001 is in the blast freezer; pull it back to reconcile first','PK-M1 a bin cannot move into an intake in blast');
select throws_ok($q$select pg_temp.move('v88-m-out','b2tag','INT-0005','INT-0002')$q$,'22023',
  'INT-0002 and INT-0005 are not in the same hold group','PK-M1 a bin moves only within the group');
select throws_ok($q$select public.variance_move_vessel('v88-m-unknown',gen_random_uuid(),pg_temp.intake('INT-0003'),pg_temp.intake('INT-0002'))$q$,'22023',
  'Basket not found','PK-M1 an unknown vessel is refused');
-- Review (#99): an unknown or other-org centre has no group; the move must fail closed, even
-- between two otherwise valid intakes at reconcile in different groups (INT-0002, INT-0005).
select throws_ok(format($q$select public.variance_move_vessel('v88-m-nocenter',%L,%L,%L)$q$,
  pg_temp.id('b2tag'),pg_temp.intake('INT-0005'),gen_random_uuid()),'22023','Unknown hold group','PK-M1 an unknown centre is refused');
select throws_ok(format($q$select public.variance_move_vessel('v88-m-xorg',%L,%L,%L)$q$,
  pg_temp.id('b2tag'),pg_temp.intake('INT-0005'),'b2800000-0000-4000-8000-0000000000ff'),'22023','Unknown hold group','PK-M1 another org''s id as centre is refused');
select throws_ok(format($q$select public.variance_move_vessel('v88-m-nullcenter',%L,%L,null)$q$,
  pg_temp.id('b2tag'),pg_temp.intake('INT-0005')),'22023','Unknown hold group','PK-M1 a null centre is refused');
select ok((select intake_id=pg_temp.intake('INT-0002') from public.vessel where id=pg_temp.id('b2tag')),'PK-M1 a refused move leaves the vessel where it was');
select is((select count(*)::int from public.intake_history),0,'PK-M1 refusals write no history');
select is((select count(*)::int from public.action_log where client_action_id like 'v88-m-%'),0,'PK-M1 refused moves leave no action_log row (they roll back)');

-- Every member reconciled: INT-0004 weighed within. The hold stays (INT-0002, INT-0003 over).
select pg_temp.bin('INT-0004','b4',50);
select is((select count(*)::int from public.variance_suspect_group(pg_temp.intake('INT-0002')) where waiting),0,'PK-G4 no member waiting once every one is reconciled');
select is((select state::text from public.variance_hold where id=pg_temp.id('hold')),'active','PK-M2 the hold is active before the move');

-- PK-M2: tag 0042 (20 lb) INT-0002 → INT-0003 ----------------------------------------------------
create temp table moved as select pg_temp.move('v88-move-1','b2tag','INT-0003','INT-0002') r;
select is((select r->>'reason' from moved),'Moved basket 0042 (20.00 lb) from INT-0002 to INT-0003: INT-0002 now +6.7%, INT-0003 now 0%. Hold cleared',
  'PK-M2 the move reports both new variances and the cleared hold');
select ok((select (r->>'ok')::boolean and (r->>'moved')::boolean and (r->>'holds_cleared')::int=1
  and (r#>>'{from,variance_pct}')::numeric=6.67 and (r#>>'{to,variance_pct}')::numeric=0 from moved),'PK-M2 the result carries both variances');
select ok((select intake_id=pg_temp.intake('INT-0003') and weight_lb=20 and lifecycle_state='occupied'
  and asset_tag_id=(select id from public.asset_tag where code='0042') from public.vessel where id=pg_temp.id('b2tag')),
  'PK-M2 the vessel moves with its tag and weight');
select ok((select state='in_use' and current_vessel_id=pg_temp.id('b2tag') from public.asset_tag where code='0042'),'PK-M2 the tag stays bound to the vessel');
select ok((select variance_pct=6.67 from public.intake_variance where number='INT-0002')
  and (select variance_pct=0 from public.intake_variance where number='INT-0003'),'PK-M2 both variances recompute immediately');
select is((select array_agg(i.number||' '||h.kind||' '||f.number||'→'||t.number||' '||h.weight_lb||' '||h.tag_code order by h.kind)
    from public.intake_history h join public.intake i on i.id=h.intake_id
    join public.intake f on f.id=h.from_intake_id join public.intake t on t.id=h.to_intake_id
    where h.vessel_id=pg_temp.id('b2tag')),
  '{"INT-0002 vessel_moved_out INT-0002→INT-0003 20.00 0042","INT-0003 vessel_moved_in INT-0002→INT-0003 20.00 0042"}'::text[],
  'PK-M2 an audit row on both intakes: from, to, vessel');
select ok((select bool_and(actor_id='a2800000-0000-4000-8000-0000000000b1' and manager_id='a2800000-0000-4000-8000-0000000000b1'
  and at is not null and client_action_id='v88-move-1') from public.intake_history),'PK-M2 audit rows record who and when');
select is((select action from public.action_log where client_action_id='v88-move-1'),'variance.move_vessel','PK-M2 the move is in action_log');
select ok(exists(select 1 from public.domain_event where kind='vessel_moved' and subject_id=pg_temp.id('b2tag')),'PK-M2 the move is a domain event');
select ok((select state='cleared' and clear_kind='auto' and cleared_by is null and reason is null and cleared_actual_lb=64
  from public.variance_hold where id=pg_temp.id('hold')),'PK-M2 the whole group within the limit clears the hold automatically, no sign-off');

-- PK-M3: idempotent ---------------------------------------------------------------------------------
select is(pg_temp.move('v88-move-1','b2tag','INT-0003','INT-0002'),(select r from moved),'PK-M3 replaying the move returns the stored result');
select is((select count(*)::int from public.intake_history),2,'PK-M3 a replay writes nothing');
select ok((select r->>'ok'='true' and r->>'moved'='false' and r->>'reason'='Basket 0042 is already in INT-0003'
  from (select pg_temp.move('v88-move-again','b2tag','INT-0003','INT-0002') r) x),'PK-M3 moving a bin already there is a no-op');
select is((select count(*)::int from public.intake_history),2,'PK-M3 the no-op writes nothing');

-- PK-M4: staff with a manager PIN elevation; the hold group no longer exists, the picker centres on
-- the tapped intake ------------------------------------------------------------------------------
select is((select count(*)::int from public.variance_suspect_group(pg_temp.intake('INT-0002')) where hold_id is not null),0,
  'PK-G5 with no active hold the picker group has no hold');
select is(pg_temp.group_of('INT-0001'),'{"INT-0001 0 in_blast","INT-0002 1 reconciled","INT-0003 2 reconciled"}'::text[],
  'PK-G5 a tapped "now in blast" line centres the group on its intake (1 before, 2 after, clipped)');
reset role;
insert into public.elevation_grant(org_id,requested_by,manager_member_id,token_hash,expires_at) values
 ('a2800000-0000-4000-8000-00000000000a','a2800000-0000-4000-8000-0000000000a2','a2800000-0000-4000-8000-0000000000b1',app.sha256_hex('v88-elevation'),now()+interval '5 minutes');
select pg_temp.as_staff();
set local role authenticated;
select is(pg_temp.move('v88-move-staff','b3','INT-0004','INT-0003','v88-elevation')->>'moved','true','PK-M4 staff with a manager PIN elevation moves a bin');
select ok((select actor_id='a2800000-0000-4000-8000-0000000000b2' and manager_id='a2800000-0000-4000-8000-0000000000b1'
  from public.intake_history where client_action_id='v88-move-staff' and kind='vessel_moved_in'),'PK-M4 the caller and the approving manager are both recorded');
select is((select count(*)::int from public.variance_hold where state='active'),0,'PK-M4 a move never flags a hold (Send to Blast does, DECISION-30)');
select is(pg_temp.move('v88-move-staff-back','b3','INT-0003','INT-0003','v88-elevation')->>'moved','true','PK-M4 and moves it back');

-- PK-M5: a moved bin removed at reconcile afterwards; its history stays.
reset role;
select pg_temp.as_manager();
set local role authenticated;
select pg_temp.bin('INT-0004','b4x',5);
select is(pg_temp.move('v88-move-x','b4x','INT-0003','INT-0004')->>'moved','true','PK-M5 a 5 lb bin moves INT-0004 → INT-0003');
select is(public.reconcile_action('v88-remove-x',pg_temp.intake('INT-0003'),'remove',p_vessel_id=>pg_temp.id('b4x'))->>'ok','true','PK-M5 the moved bin can still be removed at reconcile');
select is((select count(*)::int from public.intake_history where vessel_id=pg_temp.id('b4x')),2,'PK-M5 its move history stays');

-- PK-B: pull back from blast ------------------------------------------------------------------------
reset role;
-- Sent and blasted in that morning (one transaction here shares now(), so the times are set).
update public.intake set blast_at='2026-07-20 08:30Z' where id=pg_temp.intake('INT-0001');
update public.vessel set blast_in_at='2026-07-20 09:00Z',blast_out_at='2026-07-20 21:00Z' where id=pg_temp.id('b1');
create temp table before_pull as select rollstock_done_at,reconcile_at,blast_at from public.intake where id=pg_temp.intake('INT-0001');
grant select on before_pull to authenticated;
select pg_temp.as_staff();
set local role authenticated;
select throws_ok($q$select public.intake_pull_back('v88-pb-staff',pg_temp.intake('INT-0001'),'Wrong bin')$q$,'42501','manager approval required','PK-B1 a non-manager cannot pull back without a manager PIN');
reset role;
select pg_temp.as_manager();
set local role authenticated;
select throws_ok($q$select public.intake_pull_back('v88-pb-blank',pg_temp.intake('INT-0001'),'  ')$q$,'22023','Pull back needs a reason','PK-B1 a reason is required');
select throws_ok($q$select public.intake_pull_back('v88-pb-rec',pg_temp.intake('INT-0003'),'Wrong bin')$q$,'22023',
  'Only an order in the blast freezer can be pulled back','PK-B1 only an intake in blast can be pulled back');
select is(pg_temp.state('INT-0001'),'blast_freezer','PK-B1 refusals change nothing');

create temp table pulled as select public.intake_pull_back('v88-pb-1',pg_temp.intake('INT-0001'),' Fish from INT-0002 in its bin ') r;
select is((select r->>'reason' from pulled),'INT-0001 pulled back to reconcile; blast time restarts when it is sent again','PK-B2 a manager pulls an intake back from blast');
select is(pg_temp.state('INT-0001'),'reconcile','PK-B2 blast_freezer → reconcile');
select ok((select blast_in_at is null and blast_out_at is null from public.vessel where id=pg_temp.id('b1')),'PK-B2 its vessels'' blast time is cleared');
select ok((select i.rollstock_done_at=b.rollstock_done_at and i.reconcile_at=b.reconcile_at
  from public.intake i, before_pull b where i.id=pg_temp.intake('INT-0001')),'PK-B2 the reconcile queue keeps its rollstock place (first stamps kept)');
select ok((select kind='pulled_back' and from_state='blast_freezer' and to_state='reconcile' and reason='Fish from INT-0002 in its bin'
  and manager_id='a2800000-0000-4000-8000-0000000000b1' and at is not null
  from public.intake_history where intake_id=pg_temp.intake('INT-0001')),'PK-B2 logged in the intake''s history with the reason, who and when');
select is((select action from public.action_log where client_action_id='v88-pb-1'),'intake.pull_back','PK-B2 pull back is in action_log');
select ok(exists(select 1 from public.domain_event where kind='intake_pulled_back' and subject_id=pg_temp.intake('INT-0001')),'PK-B2 pull back is a domain event');
select ok(not exists(select 1 from public.now_in_blast where intake_number='INT-0001'),'PK-B2 it leaves the "now in blast" lines');
select ok((select status='reconciled' and not actual_frozen from public.variance_suspect_group(pg_temp.intake('INT-0001'))
  join public.intake_variance iv using (intake_id) where intake_number='INT-0001'),'PK-B2 it is reconciled again, its actual live');
select is(public.intake_pull_back('v88-pb-1',pg_temp.intake('INT-0001'),'Fish from INT-0002 in its bin'),(select r from pulled),'PK-B3 replaying the pull back returns the stored result');
select throws_ok($q$select public.intake_pull_back('v88-pb-2',pg_temp.intake('INT-0001'),'Again')$q$,'22023',
  'Only an order in the blast freezer can be pulled back','PK-B3 a second pull back is refused');
select is((select count(*)::int from public.intake_history where kind='pulled_back'),1,'PK-B3 one history row');

-- Pulled back, its bins move like any other at reconcile; then it is sent again.
select is(pg_temp.move('v88-move-pb','b1','INT-0002','INT-0001')->>'moved','true','PK-B4 a pulled-back intake''s bin can move');
select is(pg_temp.move('v88-move-pb-back','b1','INT-0001','INT-0001')->>'moved','true','PK-B4 and move back');
select is(pg_temp.send('INT-0001','v88-send-1-again')->>'ok','true','PK-B4 re-sent to blast');
select ok((select blast_at>(select blast_at from before_pull) from public.intake where id=pg_temp.intake('INT-0001')),'PK-B4 re-entering blast restarts blast time');
select ok((select blast_in_at is null from public.vessel where id=pg_temp.id('b1')),'PK-B4 the vessel waits to be blasted in again');

-- PK-B6: only intake_pull_back takes the edge (review #99): not force_transition, not an update.
select throws_ok(format($q$select public.force_transition('v88-force',%L,%L,%L,%L)$q$,'intake',
  pg_temp.intake('INT-0001'),'reconcile','Wrong bin'),'23514','Pull an intake back from blast with intake_pull_back',
  'PK-B6 force_transition cannot pull back from blast');
reset role;
select throws_ok($q$update public.intake set state='reconcile' where id=pg_temp.intake('INT-0001')$q$,'23514',
  'Pull an intake back from blast with intake_pull_back','PK-B6 nor can a direct update');
select pg_temp.as_manager();
set local role authenticated;
select is(pg_temp.state('INT-0001'),'blast_freezer','PK-B6 the intake stays in blast');

-- PK-B7: staff with a manager PIN elevation pulls back; caller and manager are recorded.
reset role;
update public.vessel set blast_in_at=now() where id=pg_temp.id('b1');
select pg_temp.as_staff();
set local role authenticated;
select is(public.intake_pull_back('v88-pb-staff-pin',pg_temp.intake('INT-0001'),'Bin from INT-0002',p_elevation_token=>'v88-elevation')->>'ok','true',
  'PK-B7 staff with a manager PIN elevation pulls back');
select ok((select actor_id='a2800000-0000-4000-8000-0000000000b2' and manager_id='a2800000-0000-4000-8000-0000000000b1'
  from public.intake_history where client_action_id='v88-pb-staff-pin'),'PK-B7 the caller and the approving manager are both recorded');
select ok((select blast_in_at is null from public.vessel where id=pg_temp.id('b1')),'PK-B7 blast time cleared');
select is(pg_temp.send('INT-0001','v88-send-1-third')->>'ok','true','PK-B7 sent again');
reset role;
select pg_temp.as_manager();
set local role authenticated;

-- PK-B8: fish already released (a vessel emptied) — I10 must still be able to close it.
select pg_temp.bin('INT-0003','b3x',5);
select is(pg_temp.send('INT-0003','v88-send-3')->>'ok','true','fixture: INT-0003 goes to blast');
reset role;
update public.vessel set lifecycle_state='emptied',release_snapshot=jsonb_build_object('weight_lb',weight_lb),weight_lb=0
where id=pg_temp.id('b3x');
set local role authenticated;
select throws_ok($q$select public.intake_pull_back('v88-pb-released',pg_temp.intake('INT-0003'),'Wrong bin')$q$,'22023',
  'Fish from this order has already been released; it cannot be pulled back','PK-B8 an intake with a released vessel cannot be pulled back');
select is(pg_temp.state('INT-0003'),'blast_freezer','PK-B8 it stays in blast, where close gate I10 can still close it');

-- PK-B9: pooled by an allocation session (its wizard projects the occupied vessels, I15/I17).
reset role;
insert into public.allocation_session(id,org_id,number,party_customer_id) values
 ('a2800000-0000-4000-8000-0000000000c1','a2800000-0000-4000-8000-00000000000a','ALC-0001','a2800000-0000-4000-8000-000000000002');
insert into public.allocation_intake(org_id,session_id,intake_id) values
 ('a2800000-0000-4000-8000-00000000000a','a2800000-0000-4000-8000-0000000000c1',pg_temp.intake('INT-0001'));
set local role authenticated;
select throws_ok($q$select public.intake_pull_back('v88-pb-pooled',pg_temp.intake('INT-0001'),'Wrong bin')$q$,'22023',
  'This order is in a counter allocation; it cannot be pulled back','PK-B9 a pooled intake cannot be pulled back');
-- A bin move into or out of a pooled intake at reconcile is refused for the same reason.
reset role;
insert into public.allocation_intake(org_id,session_id,intake_id) values
 ('a2800000-0000-4000-8000-00000000000a','a2800000-0000-4000-8000-0000000000c1',pg_temp.intake('INT-0004'));
set local role authenticated;
select throws_ok($q$select pg_temp.move('v88-m-pooled','b4','INT-0002','INT-0002')$q$,'22023',
  'INT-0004 is in a counter allocation; its baskets cannot move','PK-B9 a bin cannot move out of a pooled intake');
select ok((select intake_id=pg_temp.intake('INT-0004') from public.vessel where id=pg_temp.id('b4')),'PK-B9 the bin stays');
reset role;
update public.allocation_session set state='cancelled' where id='a2800000-0000-4000-8000-0000000000c1';
set local role authenticated;
select is(public.intake_pull_back('v88-pb-unpooled',pg_temp.intake('INT-0001'),'Wrong bin')->>'ok','true','PK-B9 once the session is cancelled the pull back goes through');

-- A stored intake (a vessel on a shelf) cannot be pulled back; nor can the guard be skipped.
select pg_temp.bin('INT-0005','b5',50);
select is(pg_temp.send('INT-0005','v88-send-5')->>'ok','true','fixture: INT-0005 goes to blast');
reset role;
update public.vessel set stored_at=now() where id=pg_temp.id('b5');
update public.intake set state='stored' where id=pg_temp.intake('INT-0005');
select throws_ok($q$update public.intake set state='reconcile' where id=pg_temp.intake('INT-0005')$q$,'23514',null,'PK-B5 stored → reconcile is not an edge');
select pg_temp.as_manager();
set local role authenticated;
select throws_ok($q$select public.intake_pull_back('v88-pb-stored',pg_temp.intake('INT-0005'),'Wrong bin')$q$,'22023',
  'Only an order in the blast freezer can be pulled back','PK-B5 a stored intake cannot be pulled back');

-- History is append-only.
reset role;
select throws_ok($q$update public.intake_history set reason='edited'$q$,null,null,'PK-H1 intake_history cannot be edited');
select throws_ok($q$delete from public.intake_history$q$,null,null,'PK-H1 intake_history cannot be deleted');

-- Tenancy ----------------------------------------------------------------------------------------------
select set_config('request.jwt.claims','{"sub":"a2800000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"b2800000-0000-4000-8000-00000000000b","app_role":"manager"}',true);
set local role authenticated;
select is((select count(*)::int from public.intake_history),0,'PK-T1 another org sees no history');
select is((select count(*)::int from public.variance_suspect_group('a2800000-0000-4000-8000-000000000002')),0,'PK-T1 another org gets no picker group');
select throws_ok(format($q$select public.variance_move_vessel('v88-cross',%L,%L,%L)$q$,pg_temp.id('b3'),
  'a2800000-0000-4000-8000-000000000004','a2800000-0000-4000-8000-000000000003'),'22023','Basket not found','PK-T1 another org''s vessel cannot be moved');
select throws_ok(format($q$select public.intake_pull_back('v88-cross-pb',%L,'Wrong bin')$q$,'a2800000-0000-4000-8000-000000000001'),
  '22023','Order not found','PK-T1 another org''s intake cannot be pulled back');

select * from finish();
rollback;
