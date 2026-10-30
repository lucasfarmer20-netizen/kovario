-- Issue #98 (docs/11-FLOOR-WORDING.md): operator-facing reason text says order / tote / basket,
-- never vessel, bin, asset tag or intake as a noun ("Intake station" keeps its name). Lint-style:
-- every quoted text (with a space, so not a key, enum value or identifier) in a floor RPC, or in
-- any app/public function it calls, transitively, is checked. Comments are stripped first.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create temp table floor_rpc(name text primary key);
insert into floor_rpc values
  -- wave, rollstock
  ('create_wave'), ('advance_wave'), ('cancel_wave'), ('scan_wave_tote'), ('rollstock_scan_advance'),
  -- reconcile, variance hold, suspect picker, pull back
  ('station_scan'), ('reconcile_action'), ('variance_hold_signoff'), ('variance_move_vessel'),
  ('intake_pull_back'), ('variance_suspect_group'),
  -- blast, locate
  ('blast_vessel'), ('blast_vessel_by_id'), ('locate_scan'), ('locate_vessel_by_id'),
  -- boxing / release
  ('boxing_scan'), ('boxing_wizard'), ('release_party'), ('release_by_tag'), ('restore_vessel'),
  -- storage pickup
  ('storage_box_scan'), ('create_pickup_batch'), ('cancel_pickup_batch'),
  ('force_release_pickup_batch'), ('storage_pickup_quote'), ('storage_pickup_receipt'),
  -- status page, operator PIN, pairing
  ('customer_status'), ('station_identify'), ('operator_identify'), ('device_heartbeat');

create temp view floor_function as
with recursive reach(oid) as (
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select name from floor_rpc)
  union
  select callee.oid
  from reach r
  join pg_proc caller on caller.oid = r.oid
  cross join lateral regexp_matches(caller.prosrc, '\m(app|public)\.([a-z_][a-z0-9_]*)\s*\(', 'g') m
  join pg_namespace cn on cn.nspname = m[1]
  join pg_proc callee on callee.pronamespace = cn.oid and callee.proname = m[2]
)
select p.oid::regprocedure as fn, regexp_replace(p.prosrc, '--[^\n]*', '', 'g') as src
from reach r join pg_proc p on p.oid = r.oid;

select ok((select count(*) from floor_rpc f
  where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name)) = 0,
  'FW0 every listed floor RPC exists');
select ok((select count(*) from floor_function) > (select count(*) from floor_rpc),
  'FW0 the floor RPCs'' helpers are reached');

select is(
  array(
    select f.fn::text || ': ' || t[1]
    from floor_function f
    cross join lateral regexp_matches(f.src, '''((?:[^'']|'''')*)''', 'g') t
    where t[1] ~ '\s'
      and t[1] ~* '\m(vessels?|bins?)\M|asset tag|\mintakes?\M(?! station)|type code|ready to scan'
    order by 1
  ),
  '{}'::text[],
  'FW1 no floor RPC reason text says vessel, bin, asset tag or intake (docs/11-FLOOR-WORDING.md)');

-- Accept feedback says what happened, noun first (prompt grammar 4).
select ok(
  pg_get_functiondef('public.reconcile_action(text,uuid,text,uuid,text,numeric,uuid,text,jsonb)'::regprocedure)
    ~ 'Basket %s added to %s',
  'FW2 reconcile accept names the basket and the order');

select * from finish();
rollback;
