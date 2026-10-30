-- v1.1 variance hold at reconcile (#87; docs/04-BUSINESS-RULES.md §6a, docs/06-STATIONS-UX.md).
-- Send to Blast over org.settings.reconcile.variance_hold_pct (default 15) is refused and flags
-- the intake (public.variance_hold). Its hold group, the flagged intake plus 1 before and 2 after
-- in rollstock order (the order intakes were actually opened at rollstock, from scan_log, across
-- waves), cannot be sent to blast until the hold clears: automatically once every intake in the
-- group is reconciled and within the limit, or by a manager PIN sign-off with a reason.
-- Every intake sent to blast shows as a "now in blast" line (public.now_in_blast).
--
-- Rule maths (variance %, band, group selection, limit, sign-off check) is generated from
-- packages/rules variance.ts into 20261030000000_variance_rules_sql.sql; nothing here
-- re-implements it.
--
-- Interfaces for #88 (suspect picker, move bin, pull back from blast):
--   public.intake_variance       expected / actual / variance / band of every intake: live up to
--                                reconcile, frozen at Send to Blast after it (intake_blast_send);
--   public.rollstock_open        when and by which scan each intake was opened at rollstock;
--   public.variance_hold_member  each hold's group, in rollstock order, with each member's
--                                variance, state and whether it is blocked;
--   public.now_in_blast          the "now in blast" lines;
--   app.variance_holds_reevaluate(intake_ids) auto-clears holds whose group is back within the
--                                limit; call it after moving vessels between intakes.
-- Lock order: the org's variance advisory lock (send, sign-off) → the intake's reconcile
-- advisory lock → vessels → intake → variance_hold rows (sorted ids). Rows are always last.

-- Setting -----------------------------------------------------------------------------------
-- New orgs carry the default; earlier orgs have no `reconcile` key and read the default (15)
-- through app.variance_hold_limit until a manager saves settings. No org row is rewritten.
alter table public.org alter column settings set default '{
  "hold_hours": 48,
  "estimated_pickup_days": 3,
  "wave_target_lb": 4000,
  "wave_tolerance_lb": 250,
  "receipt_footer": "",
  "status_page_enabled": true,
  "tax": { "mode": "exclusive", "rate": 0.06, "cap_amount": 30.00 },
  "shipping": { "carrier_allowlist": "*", "buy_window_days": 1 },
  "scanner": { "tag_digits": 4 },
  "reconcile": { "variance_hold_pct": 15 }
}'::jsonb;

-- Optional `reconcile` key, validated by the generated rule; everything else as before.
alter function app.org_settings_problem(jsonb) rename to org_settings_problem_pre_v11_variance;
create function app.org_settings_problem(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_problem text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return app.org_settings_problem_pre_v11_variance(p);
  end if;
  v_problem := app.variance_hold_setting_problem(p);
  if v_problem is not null then return v_problem; end if;
  return app.org_settings_problem_pre_v11_variance(p - 'reconcile');
end $$;
revoke all on function app.org_settings_problem(jsonb),
  app.org_settings_problem_pre_v11_variance(jsonb) from public;

-- Rollstock order ---------------------------------------------------------------------------
-- An intake opens at rollstock on its first accepted rollstock scan (rollstock_scan_advance
-- writes scan_log.intake_id on every accepted tote). Repeat tote scans keep the first open.
create index if not exists scan_log_rollstock_open on public.scan_log (intake_id, scanned_at, id)
  where station = 'rollstock' and result = 'ok';
create index if not exists scan_log_rollstock_time on public.scan_log (org_id, scanned_at, id)
  where station = 'rollstock' and result = 'ok';

create or replace view public.rollstock_open with (security_invoker = true) as
select i.org_id, i.site_id, i.id as intake_id, s.scanned_at as opened_at, s.id as scan_id
from public.intake i
cross join lateral (
  select sl.scanned_at, sl.id from public.scan_log sl
  where sl.intake_id = i.id and sl.org_id = i.org_id and sl.station = 'rollstock' and sl.result = 'ok'
  order by sl.scanned_at, sl.id
  limit 1
) s;

-- One site's rollstock line, in open order (rules: rollstockSequence), among intakes opened
-- within app.variance_rollstock_window() of p_around (ROLLSTOCK_NEIGHBOUR_WINDOW_DAYS). The
-- window bounds the work to the scans around the flagged intake, not the site's whole history;
-- each intake still counts only at its first accepted scan. Waves play no part. Not security
-- definer: under RLS a caller sees only its own org; definer callers pass app.org_id().
create or replace function app.rollstock_sequence(p_org_id uuid, p_site_id uuid, p_around timestamptz)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(sl.intake_id order by sl.scanned_at, sl.id), '{}')
  from public.scan_log sl
  join public.intake i on i.id = sl.intake_id and i.org_id = sl.org_id
  where sl.org_id = p_org_id and sl.station = 'rollstock' and sl.result = 'ok'
    and sl.scanned_at between p_around - app.variance_rollstock_window()
      and p_around + app.variance_rollstock_window()
    and i.site_id is not distinct from p_site_id
    and not exists (
      select 1 from public.scan_log e
      where e.intake_id = sl.intake_id and e.org_id = sl.org_id and e.station = 'rollstock'
        and e.result = 'ok' and (e.scanned_at, e.id) < (sl.scanned_at, sl.id))
$$;

-- Actual at Send to Blast ----------------------------------------------------------------------
-- The reconciled weight, written by every send (a #88 pull-back and re-send overwrites it).
-- After send the occupied weight only falls (splits, full pulls zero it, I10 closes the intake),
-- so past reconcile the variance reads this, never the live remainder.
create table if not exists public.intake_blast_send (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null unique references public.intake (id) on delete cascade,
  actual_lb numeric(10,2) not null check (actual_lb >= 0),
  expected_lb numeric(10,2) not null,
  sent_at timestamptz not null default now(),
  sent_by uuid references public.org_member (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select app.track_updated_at('public.intake_blast_send');
select app.enable_org_rls('public.intake_blast_send', write_roles => '{}');

-- Backfill intakes already past reconcile: occupied weight, plus the release snapshot's weight
-- of vessels emptied since (void excluded). A split's pre-split weight is not kept anywhere, so
-- for intakes split before this migration the backfill is the remainder, not the send weight.
insert into public.intake_blast_send (org_id, intake_id, actual_lb, expected_lb, sent_at)
select i.org_id, i.id,
  coalesce(sum(case when v.lifecycle_state = 'emptied'
    then coalesce((v.release_snapshot ->> 'weight_lb')::numeric, 0) else v.weight_lb end), 0),
  i.total_est_yield_lb, coalesce(i.blast_at, now())
from public.intake i
left join public.vessel v on v.intake_id = i.id and v.org_id = i.org_id and v.lifecycle_state <> 'void'
where i.state in ('blast_freezer', 'stored', 'done')
group by i.id
on conflict (intake_id) do nothing;

-- Variance ---------------------------------------------------------------------------------------
-- Actual = the intake's occupied vessels up to reconcile (as the reconcile screen), the weight
-- sent once past it (`actual_frozen`); expected = total_est_yield_lb; limit = the org's setting.
create or replace view public.intake_variance with (security_invoker = true) as
select i.org_id, i.site_id, i.id as intake_id, i.number, i.state,
  i.total_est_yield_lb as expected_lb, a.actual_lb, f.actual_frozen,
  app.variance_pct(a.actual_lb, i.total_est_yield_lb) as variance_pct,
  l.limit_pct,
  app.variance_band(a.actual_lb, i.total_est_yield_lb, l.limit_pct) as band
from public.intake i
join public.org o on o.id = i.org_id
left join public.intake_blast_send s on s.intake_id = i.id and s.org_id = i.org_id
cross join lateral (select app.variance_hold_limit(o.settings) as limit_pct) l
cross join lateral (
  select coalesce(sum(v.weight_lb), 0)::numeric(10,2) as live_lb from public.vessel v
  where v.intake_id = i.id and v.org_id = i.org_id and v.lifecycle_state = 'occupied'
) w
cross join lateral (
  select (i.state in ('blast_freezer', 'stored', 'done') and s.id is not null) as actual_frozen
) f
cross join lateral (
  select case when f.actual_frozen then s.actual_lb else w.live_lb end as actual_lb
) a;

-- Holds -------------------------------------------------------------------------------------
do $$ begin
  create type public.variance_hold_state as enum ('active', 'cleared');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.variance_hold_clear_kind as enum ('auto', 'signoff');
exception when duplicate_object then null; end $$;

-- One row per flag. Written only by reconcile_action (flag), app.variance_holds_reevaluate
-- (auto clear) and variance_hold_signoff (manager clear). The flag-time numbers are kept for
-- reports; the group itself is live (it grows as later intakes open at rollstock).
create table if not exists public.variance_hold (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  intake_id uuid not null references public.intake (id) on delete cascade,
  state public.variance_hold_state not null default 'active',
  limit_pct int not null check (limit_pct between 1 and 100),
  expected_lb numeric(10,2) not null,
  actual_lb numeric(10,2) not null,
  variance_pct numeric,
  flagged_at timestamptz not null default now(),
  flagged_by uuid references public.org_member (id) on delete set null,
  clear_kind public.variance_hold_clear_kind,
  cleared_at timestamptz,
  cleared_by uuid references public.org_member (id) on delete set null,
  reason public.variance_signoff_reason,
  note text,
  -- the flagged intake's actual at clearing; a sign-off covers a later send only at this weight
  cleared_actual_lb numeric(10,2),
  cleared_variance_pct numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variance_hold_clearing check (
    (state = 'active' and clear_kind is null and cleared_at is null and cleared_by is null
      and reason is null and note is null and cleared_actual_lb is null)
    or (state = 'cleared' and cleared_at is not null and cleared_actual_lb is not null and (
      (clear_kind = 'auto' and reason is null and note is null)
      or (clear_kind = 'signoff' and reason is not null
        and (reason <> 'other' or coalesce(note, '') ~ '\S')))))
);
create unique index if not exists variance_hold_one_active on public.variance_hold (intake_id)
  where state = 'active';
create index if not exists variance_hold_org_state on public.variance_hold (org_id, state);
select app.track_updated_at('public.variance_hold');
select app.enable_org_rls('public.variance_hold', write_roles => '{}');
do $$ begin alter publication supabase_realtime add table public.variance_hold;
exception when duplicate_object then null; end $$;

-- The hold's group over its site's rollstock line (rules: holdGroup).
create or replace function app.variance_hold_group_of(p_hold public.variance_hold)
returns uuid[] language sql stable set search_path = '' as $$
  select app.variance_hold_group(app.rollstock_sequence(i.org_id, i.site_id, ro.opened_at), i.id)
  from public.intake i
  left join public.rollstock_open ro on ro.intake_id = i.id and ro.org_id = i.org_id
  where i.id = p_hold.intake_id and i.org_id = p_hold.org_id
$$;

-- Not yet sent to blast: these are the members a hold blocks.
create or replace function app.variance_hold_blocks(p_state public.intake_state)
returns boolean language sql immutable set search_path = '' as $$
  select p_state in ('draft', 'holding', 'processing', 'rollstock', 'reconcile')
$$;

-- Each hold's group in rollstock order: position −1 (before), 0 (flagged), 1, 2 (after).
create or replace view public.variance_hold_member with (security_invoker = true) as
select h.id as hold_id, h.org_id, h.state as hold_state, h.intake_id as flagged_intake_id,
  g.intake_id, (g.ord - array_position(g.grp, h.intake_id))::int as position,
  iv.number as intake_number, iv.state, iv.expected_lb, iv.actual_lb, iv.variance_pct,
  iv.limit_pct, iv.band, app.variance_hold_blocks(iv.state) as blocked
from public.variance_hold h
cross join lateral (
  select x.intake_id, x.ord, grp.grp
  from (select app.variance_hold_group_of(h) as grp) grp
  cross join lateral unnest(grp.grp) with ordinality x(intake_id, ord)
) g
join public.intake_variance iv on iv.intake_id = g.intake_id and iv.org_id = h.org_id;

-- A manager signed off this intake's variance at this actual weight.
create or replace function app.variance_signed_off(p_org_id uuid, p_intake_id uuid, p_actual_lb numeric)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.variance_hold h
    where h.org_id = p_org_id and h.intake_id = p_intake_id and h.state = 'cleared'
      and h.clear_kind = 'signoff' and h.cleared_actual_lb = p_actual_lb)
$$;

-- The group is back within the limit, judged only on members whose weight can still change:
-- every member must have reached reconcile, and one at reconcile must be within the limit or
-- signed off at its current weight. Members past reconcile (sent within the limit or signed
-- off, actual frozen at send; #88 pulls one back to reconcile to move fish) and cancelled
-- members are not judged.
-- A member that keeps its hold open: not yet at reconcile, or at reconcile over the limit and
-- not signed off at its current weight.
create or replace function app.variance_member_open(p_iv public.intake_variance)
returns boolean language sql stable set search_path = '' as $$
  select p_iv.state in ('draft', 'holding', 'processing', 'rollstock')
    or (p_iv.state = 'reconcile' and p_iv.band = 'over'
      and not app.variance_signed_off(p_iv.org_id, p_iv.intake_id, p_iv.actual_lb))
$$;

create or replace function app.variance_group_within(p_org_id uuid, p_group uuid[])
returns boolean language sql stable set search_path = '' as $$
  select not exists (
    select 1 from public.intake_variance iv
    where iv.org_id = p_org_id and iv.intake_id = any (p_group) and app.variance_member_open(iv))
$$;

-- The members keeping a hold open, in rollstock order, for the refusal message:
-- "INT-0005 (not yet at reconcile), INT-0004 (−20%)".
create or replace function app.variance_hold_waiting_on(p_hold public.variance_hold)
returns text language sql stable set search_path = '' as $$
  select string_agg(iv.number || case when iv.state = 'reconcile'
      then ' (' || app.format_variance(iv.variance_pct) || ')' else ' (not yet at reconcile)' end,
    ', ' order by g.ord)
  from unnest(app.variance_hold_group_of(p_hold)) with ordinality g(intake_id, ord)
  join public.intake_variance iv on iv.intake_id = g.intake_id and iv.org_id = p_hold.org_id
  where app.variance_member_open(iv)
$$;

-- Auto-clear: every active hold whose group contains one of p_intake_ids (all of them when
-- null) and is now within the limit. Locks only those holds, in id order (rows last in the lock
-- order), so a weight edit elsewhere in the org never waits on a hold. Returns the number
-- cleared. #88's bin move calls this after moving vessels.
create or replace function app.variance_holds_reevaluate(p_intake_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare h public.variance_hold; v_group uuid[]; v public.intake_variance; n int := 0;
begin
  for h in select * from public.variance_hold vh where vh.org_id = app.org_id() and vh.state = 'active'
      and (p_intake_ids is null or app.variance_hold_group_of(vh) && p_intake_ids)
      order by vh.id for update loop
    v_group := app.variance_hold_group_of(h);
    continue when not app.variance_group_within(h.org_id, v_group);
    select * into v from public.intake_variance where intake_id = h.intake_id and org_id = h.org_id;
    update public.variance_hold set state = 'cleared', clear_kind = 'auto', cleared_at = now(),
      cleared_actual_lb = v.actual_lb, cleared_variance_pct = v.variance_pct
    where id = h.id;
    perform app.emit_event(h.org_id, 'variance_hold_cleared', h.intake_id,
      jsonb_build_object('hold_id', h.id, 'kind', 'auto', 'group', to_jsonb(v_group),
        'variance_pct', v.variance_pct));
    n := n + 1;
  end loop;
  return n;
end $$;

-- The active hold that blocks p_intake_id (its own, or a neighbour's), oldest first.
create or replace function app.variance_hold_blocking(p_intake_id uuid)
returns public.variance_hold language sql stable security definer set search_path = '' as $$
  select h.* from public.variance_hold h
  where h.org_id = app.org_id() and h.state = 'active'
    and p_intake_id = any (app.variance_hold_group_of(h))
  order by h.flagged_at, h.id
  limit 1
$$;

-- Reconcile: the send gate --------------------------------------------------------------------
-- As 20261027051000_reconcile.sql, plus: send takes the org's variance lock first, re-evaluates
-- holds covering the intake, then is refused while a hold blocks it, or flags a new hold when
-- the intake is over the limit without a sign-off at its current weight. Otherwise the intake
-- goes to blast and an `intake_sent_to_blast` event records its variance. Weight edits
-- re-evaluate holds covering the intake, so a group back within the limit clears itself.
create or replace function public.reconcile_action(p_client_action_id text,p_intake_id uuid default null,p_operation text default 'open',p_vessel_id uuid default null,p_code text default null,p_weight numeric default null,p_operator_session uuid default null,p_raw text default null,p_parsed jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb; i public.intake; t public.asset_tag; v public.vessel; sr public.scale_reading; op uuid; holder text; reason text; selected uuid:=p_intake_id;
  iv public.intake_variance; blocking public.variance_hold; flagged public.intake; hold_id uuid;
begin
 perform app.require_role('{owner,manager,staff,station}');
 a:=app.action_begin(p_client_action_id,'reconcile.'||p_operation,jsonb_build_object('intake_id',p_intake_id));
 if a->>'status'='done' then return a->'result'; end if;
 begin
  op:=app.reconcile_operator(p_operator_session);
  if p_operation='open' then
   select intake_id into selected from public.tote_tag where org_id=app.org_id() and qr=btrim(p_raw,E' \t\r\n');
   if selected is null then raise exception 'Unknown tote'; end if;
  end if;
  -- Sends serialise per org so a flag and a neighbour's send can never both pass.
  if p_operation='send' then perform pg_advisory_xact_lock(hashtextextended('variance_hold:'||app.org_id()::text,0)); end if;
  -- All reconcile mutations use this transaction lock before taking row locks.
  perform pg_advisory_xact_lock(hashtextextended('reconcile:'||selected::text,0));
  perform id from public.vessel where intake_id=selected and org_id=app.org_id() order by id for update;
  select * into i from public.intake where id=selected and org_id=app.org_id() for update;
  if i.id is null or i.state<>'reconcile' then raise exception 'Intake is not at reconcile'; end if;
  if p_operation='bind' then
   select * into t from public.asset_tag where org_id=app.org_id() and code=app.normalize_tag_code(p_code) for update;
   if t.id is null then raise exception 'Unknown tag'; end if;
   if t.state='retired' then raise exception 'Tag retired'; end if;
   if t.state='in_use' then
    select n.number into holder from public.vessel h join public.intake n on n.id=h.intake_id where h.id=t.current_vessel_id;
    raise exception 'Tag % in use by %',t.code,holder;
   end if;
   insert into public.vessel(org_id,intake_id,asset_tag_id) values(app.org_id(),i.id,t.id) returning * into v;
   update public.asset_tag set state='in_use',current_vessel_id=v.id where id=t.id;
  elsif p_operation='exchange' then
   insert into public.vessel(org_id,intake_id,is_exchange) values(app.org_id(),i.id,true) returning * into v;
  elsif p_operation in ('remove','manual','accept') then
   select * into v from public.vessel where id=p_vessel_id and intake_id=i.id and org_id=app.org_id() and lifecycle_state='occupied';
   if v.id is null then raise exception 'Unknown occupied vessel'; end if;
   if p_operation='remove' then
    update public.asset_tag set state='available',current_vessel_id=null where id=v.asset_tag_id and org_id=app.org_id();
    delete from public.vessel where id=v.id;
   elsif p_operation='manual' then
    if p_weight is null or p_weight<=0 or p_weight::text in ('NaN','Infinity','-Infinity') then raise exception 'Weight must be positive'; end if;
    update public.vessel set weight_lb=p_weight,manual=true,scale_reading_id=null where id=v.id;
   else
    select s.* into sr from public.scale_reading s join public.device d on d.scale_id=s.scale_id and d.org_id=s.org_id where d.id=app.device_id() and d.org_id=app.org_id() and s.stable order by s.read_at desc,s.id desc limit 1;
    if sr.id is null or sr.weight_lb<=0 then raise exception 'No positive stable reading for device scale'; end if;
    update public.vessel set weight_lb=sr.weight_lb,manual=false,scale_reading_id=sr.id where id=v.id;
   end if;
  elsif p_operation='send' then
   if not exists(select 1 from public.vessel where intake_id=i.id and lifecycle_state='occupied') or exists(select 1 from public.vessel where intake_id=i.id and lifecycle_state='occupied' and (weight_lb<=0 or (not is_exchange and asset_tag_id is null))) then raise exception 'Every vessel needs positive weight and a tag unless exchange'; end if;
   perform app.variance_holds_reevaluate(array[i.id]);
   select * into iv from public.intake_variance where intake_id=i.id and org_id=app.org_id();
   blocking:=app.variance_hold_blocking(i.id);
   if blocking.id is not null then
    hold_id:=blocking.id;
    if blocking.intake_id=i.id and iv.band='over' then
     reason:=format('Variance hold: %s is %s (limit ±%s%%). Fix the bins or get a manager sign-off',i.number,app.format_variance(iv.variance_pct),iv.limit_pct);
    elsif blocking.intake_id=i.id and iv.band in ('within','near') then
     -- Back within the limit, but the hold waits on neighbours (docs/08 DECISION-27).
     reason:=format('Variance hold: %s is back within the limit (%s); waiting on %s. The hold clears when they are within the limit, or a manager signs off',
       i.number,app.format_variance(iv.variance_pct),app.variance_hold_waiting_on(blocking));
    elsif blocking.intake_id=i.id then
     -- No expected yield any more (band unknown): nothing to be within, so name the neighbours only.
     reason:=format('Variance hold: %s has no expected yield to compare; waiting on %s. The hold clears when they are within the limit, or a manager signs off',
       i.number,app.variance_hold_waiting_on(blocking));
    else
     select * into flagged from public.intake where id=blocking.intake_id;
     reason:=format('Variance hold on %s: %s is its rollstock neighbour and waits for the hold to clear',flagged.number,i.number);
    end if;
   elsif iv.band='over' and not app.variance_signed_off(i.org_id,i.id,iv.actual_lb) then
    insert into public.variance_hold(org_id,intake_id,limit_pct,expected_lb,actual_lb,variance_pct,flagged_by)
    values(app.org_id(),i.id,iv.limit_pct,iv.expected_lb,iv.actual_lb,iv.variance_pct,op) returning id into hold_id;
    perform app.emit_event(app.org_id(),'variance_hold_flagged',i.id,jsonb_build_object('hold_id',hold_id,
      'variance_pct',iv.variance_pct,'limit_pct',iv.limit_pct,'actual_lb',iv.actual_lb,'expected_lb',iv.expected_lb));
    reason:=format('Variance hold: %s is %s (limit ±%s%%). Held with its rollstock neighbours until fixed or signed off',i.number,app.format_variance(iv.variance_pct),iv.limit_pct);
   else
    update public.intake set state='blast_freezer' where id=i.id;
    insert into public.intake_blast_send(org_id,intake_id,actual_lb,expected_lb,sent_by)
    values(app.org_id(),i.id,iv.actual_lb,iv.expected_lb,op)
    on conflict (intake_id) do update set actual_lb=excluded.actual_lb,expected_lb=excluded.expected_lb,
      sent_at=now(),sent_by=excluded.sent_by;
    perform app.emit_event(app.org_id(),'intake_sent_to_blast',i.id,jsonb_build_object('variance_pct',iv.variance_pct,
      'band',iv.band,'limit_pct',iv.limit_pct,'actual_lb',iv.actual_lb,'expected_lb',iv.expected_lb));
   end if;
  elsif p_operation<>'open' then raise exception 'Unknown reconcile operation'; end if;
  if p_operation in ('bind','exchange','remove','manual','accept') then
   perform app.variance_holds_reevaluate(array[i.id]);
  end if;
 exception when raise_exception or insufficient_privilege then reason:=sqlerrm;
 end;
 if p_raw is not null then
  insert into public.scan_log(org_id,station,device_id,operator_id,raw,parsed,result,reason,intake_id,vessel_id) values(app.org_id(),'reconcile',app.device_id(),op,p_raw,p_parsed,case when reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,reason,i.id,case when reason is null then v.id end);
 end if;
 r:=jsonb_build_object('ok',reason is null,'reason',coalesce(reason,'Accepted'),'intake_id',selected,'vessel_id',case when reason is null then v.id end,'variance_hold_id',hold_id);
 perform app.action_complete(p_client_action_id,r); return r;
end $$;

-- Manager sign-off ----------------------------------------------------------------------------
-- A manager account signs off directly; anyone else needs a live manager PIN elevation
-- (`elevate` Edge Function → app.require_elevation), as rollstock overrides. One SQL function,
-- logged in action_log (variance_hold.signoff) and domain_event, shown in report_variance_holds.
-- Replaying a client_action_id returns the stored result; signing off a cleared hold is a no-op.
create or replace function public.variance_hold_signoff(p_client_action_id text, p_hold_id uuid,
  p_reason text, p_note text default null, p_elevation_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; r jsonb; v_manager uuid; v_problem text; h public.variance_hold;
  v public.intake_variance;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a := app.action_begin(p_client_action_id, 'variance_hold.signoff',
    jsonb_build_object('hold_id', p_hold_id, 'reason', p_reason, 'note', p_note));
  if a ->> 'status' = 'done' then return a -> 'result'; end if;
  if app.role() in ('owner', 'manager') then
    select id into v_manager from public.org_member where org_id = app.org_id() and user_id = app.user_id();
  else
    v_manager := app.require_elevation(p_elevation_token);
  end if;
  v_problem := app.variance_signoff_problem(p_reason, p_note);
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('variance_hold:' || app.org_id()::text, 0));
  select * into h from public.variance_hold where id = p_hold_id and org_id = app.org_id() for update;
  if h.id is null then raise exception 'Unknown variance hold' using errcode = '22023'; end if;
  if h.state = 'cleared' then
    r := jsonb_build_object('ok', true, 'reason', 'Hold already cleared', 'hold_id', h.id,
      'cleared', false);
  else
    select * into v from public.intake_variance where intake_id = h.intake_id and org_id = h.org_id;
    update public.variance_hold set state = 'cleared', clear_kind = 'signoff', cleared_at = now(),
      cleared_by = v_manager, reason = p_reason::public.variance_signoff_reason,
      note = nullif(btrim(p_note), ''), cleared_actual_lb = v.actual_lb,
      cleared_variance_pct = v.variance_pct
    where id = h.id;
    perform app.emit_event(h.org_id, 'variance_hold_cleared', h.intake_id,
      jsonb_build_object('hold_id', h.id, 'kind', 'signoff', 'manager_id', v_manager,
        'reason', p_reason, 'note', p_note, 'variance_pct', v.variance_pct));
    r := jsonb_build_object('ok', true, 'reason', 'Hold signed off', 'hold_id', h.id,
      'cleared', true);
  end if;
  perform app.action_complete(p_client_action_id, r);
  return r;
end $$;

-- "Now in blast" lines --------------------------------------------------------------------------
-- Every intake sent to blast while any of its occupied vessels is not yet on a shelf
-- (blast_freezer, or stored by a sibling vessel), flagged or not. Clients list them in rollstock
-- order (rollstock_opened_at, rollstock_scan_id) and colour by band.
create or replace view public.now_in_blast with (security_invoker = true) as
select iv.org_id, iv.site_id, iv.intake_id, iv.number as intake_number, iv.state, i.blast_at,
  ro.opened_at as rollstock_opened_at, ro.scan_id as rollstock_scan_id,
  iv.expected_lb, iv.actual_lb, iv.variance_pct, iv.limit_pct, iv.band
from public.intake i
join public.intake_variance iv on iv.intake_id = i.id and iv.org_id = i.org_id
left join public.rollstock_open ro on ro.intake_id = i.id and ro.org_id = i.org_id
where i.state = 'blast_freezer'
  or (i.state = 'stored' and exists (select 1 from public.vessel v where v.intake_id = i.id
    and v.org_id = i.org_id and v.lifecycle_state = 'occupied' and v.stored_at is null));

-- Report: who, when, reason, variance -------------------------------------------------------------
create or replace view public.report_variance_holds with (security_invoker = true) as
select h.org_id, i.site_id, (h.flagged_at at time zone o.timezone)::date as day,
  i.number as intake_number, h.variance_pct, h.limit_pct,
  case when h.state = 'active' then 'active' else h.clear_kind::text end as outcome,
  m.display_name as signed_off_by, h.cleared_at, h.reason::text as reason, h.note,
  h.cleared_variance_pct
from public.variance_hold h
join public.intake i on i.id = h.intake_id and i.org_id = h.org_id
join public.org o on o.id = h.org_id
left join public.org_member m on m.id = h.cleared_by and m.org_id = h.org_id;

-- Grants ------------------------------------------------------------------------------------------
revoke all on public.rollstock_open, public.intake_variance, public.variance_hold_member,
  public.now_in_blast, public.report_variance_holds from public, anon, authenticated;
grant select on public.rollstock_open, public.intake_variance, public.variance_hold_member,
  public.now_in_blast, public.report_variance_holds to authenticated, service_role;

revoke all on function app.rollstock_sequence(uuid, uuid, timestamptz), app.variance_hold_group_of(public.variance_hold),
  app.variance_signed_off(uuid, uuid, numeric), app.variance_member_open(public.intake_variance),
  app.variance_hold_waiting_on(public.variance_hold),
  app.variance_hold_blocks(public.intake_state), app.variance_group_within(uuid, uuid[]),
  app.variance_holds_reevaluate(uuid[]), app.variance_hold_blocking(uuid) from public;
grant execute on function app.rollstock_sequence(uuid, uuid, timestamptz), app.variance_hold_group_of(public.variance_hold),
  app.variance_hold_blocks(public.intake_state), app.variance_signed_off(uuid, uuid, numeric)
  to authenticated, service_role;

revoke all on function public.variance_hold_signoff(text, uuid, text, text, text) from public, anon;
grant execute on function public.variance_hold_signoff(text, uuid, text, text, text) to authenticated;
