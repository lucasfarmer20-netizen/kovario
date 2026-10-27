-- WP-13: location master admin, blast and locate stations, walk-path pick order
-- (docs/04-BUSINESS-RULES.md §7, docs/02-DOMAIN-MODEL.md §7, docs/10-LESSONS-FROM-CSP.md §1).
-- SQL matches scanned text against master QR text / canonical codes only; QR encoding and
-- parsing, and location code generation, live in packages/rules. Capacity never gates.

-- sort_key ----------------------------------------------------------------------------
-- Walk path: zone → racks before pallets → row → bay → level → F before R. Fixed-width
-- fields under the "C" collation so `A` walks before `AA` and `10` after `9`, whatever the
-- database's default collation does with punctuation.
drop index if exists public.location_org_sort;
alter table public.location drop column if exists sort_key;
alter table public.location add column sort_key text collate "C" generated always as (
  lpad(zone, 8, ' ')
  || '|' || case kind when 'rack' then '0' else '1' end
  || '|' || lpad(coalesce("row", ''), 4, ' ')
  || '|' || lpad(coalesce(bay, 0)::text, 2, '0')
  || '|' || coalesce(level, 0)::text
  || '|' || case depth when 'F' then '0' when 'R' then '1' else '-' end
  || '|' || lpad(code, 32, ' ')
) stored;
create index location_org_sort on public.location (org_id, sort_key) where is_active;

-- Archive, never delete: a deleted shelf would orphan its placement history. Deletes are
-- allowed only as a cascade from a parent (removing an org).
create function app.location_archive_not_delete() returns trigger
language plpgsql set search_path='' as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;
  raise exception 'locations are archived, not deleted' using errcode = '55000';
end $$;
revoke all on function app.location_archive_not_delete() from public;
create trigger archive_not_delete before delete on public.location
  for each row execute function app.location_archive_not_delete();

-- Operator for a freezer station (blast / locate): live PIN proof on station devices.
create function app.freezer_operator(p_session uuid, p_station public.device_station) returns uuid
language plpgsql security definer set search_path='' as $$
declare op uuid;
begin
  perform app.require_role('{owner,manager,staff,station}');
  if app.device_id() is not null and not exists(select 1 from public.device
    where id=app.device_id() and org_id=app.org_id() and auth_user_id=app.user_id()
      and is_active and station=p_station) then
    raise exception 'station_mismatch' using errcode='42501';
  end if;
  if app.role()='station' then
    update public.station_operator_session set expires_at=now()+interval '15 minutes'
    where id=p_session and org_id=app.org_id() and user_id=app.user_id() and expires_at>now()
    returning operator_id into op;
    if op is null then raise exception 'operator_pin_required' using errcode='42501'; end if;
  else
    select id into op from public.org_member where org_id=app.org_id() and user_id=app.user_id();
  end if;
  return op;
end $$;
revoke all on function app.freezer_operator(uuid, public.device_station) from public, anon, authenticated;

-- Admin: generator upsert, pallet/quarantine creation, archive/unarchive. Rows (codes and
-- QR text) come from rules/locations.ts + rules/qr.ts; location_code_shape enforces the
-- shapes structurally, so a pallet row can never carry a grid code and vice versa.
create function public.admin_locations(p_client_action_id text, p_operation text,
  p_locations jsonb default null, p_location_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb; n int; l public.location; occupied int;
begin
  perform app.require_role('{owner,manager}');
  a:=app.action_begin(p_client_action_id,'locations.'||p_operation,
    jsonb_build_object('location_id',p_location_id));
  if a->>'status'='done' then return a->'result'; end if;
  if p_operation in ('generate','pallet') then
    if p_locations is null or jsonb_typeof(p_locations)<>'array'
       or jsonb_array_length(p_locations) not between 1 and 2000 then
      raise exception 'Invalid location list';
    end if;
    if exists(select 1 from jsonb_array_elements(p_locations) x
              where x->>'kind' is distinct from case p_operation when 'generate' then 'rack' else 'pallet' end)
       or (p_operation='pallet' and jsonb_array_length(p_locations)<>1) then
      raise exception 'Generator creates rack positions; pallet creates one pallet location';
    end if;
    with ins as (
      insert into public.location(org_id,zone,kind,"row",bay,level,depth,code,qr)
      select app.org_id(), x->>'zone', (x->>'kind')::public.location_kind, x->>'row',
        (x->>'bay')::int, (x->>'level')::int, (x->>'depth')::public.location_depth,
        x->>'code', x->>'qr'
      from jsonb_array_elements(p_locations) x
      on conflict (org_id, code) do nothing
      returning 1)
    select count(*)::int into n from ins;
    if p_operation='pallet' and n=0 then
      raise exception 'Location % already exists', p_locations->0->>'code';
    end if;
    r:=jsonb_build_object('inserted',n,'existing',jsonb_array_length(p_locations)-n);
  elsif p_operation in ('archive','unarchive') then
    update public.location set is_active=(p_operation='unarchive')
    where id=p_location_id and org_id=app.org_id() returning * into l;
    if l.id is null then raise exception 'Unknown location'; end if;
    -- Vessels already on an archived location stay put (the live check fires only on a
    -- new binding); the count tells the manager to relocate them.
    select count(*)::int into occupied from public.vessel
    where location_id=l.id and org_id=l.org_id and lifecycle_state='occupied';
    r:=jsonb_build_object('code',l.code,'is_active',l.is_active,'occupied_vessels',occupied);
  else
    raise exception 'Unknown location operation';
  end if;
  perform app.action_complete(p_client_action_id,r);
  return r;
end $$;

-- Scanned asset tag → its occupied vessel, locked. Matches master QR text or the
-- canonical code (bare `42` / `042`). A scanned code is not evidence the tag exists.
create function app.freezer_vessel(p_raw text) returns public.vessel
language plpgsql security definer set search_path='' as $$
declare raw text:=btrim(p_raw,E' \t\r\n'); t public.asset_tag; v public.vessel;
begin
  if raw is null or raw='' then raise exception 'Scan a vessel tag first'; end if;
  select * into t from public.asset_tag
  where org_id=app.org_id() and (qr=raw or code=app.normalize_tag_code(raw));
  if t.id is null then raise exception 'Unknown tag'; end if;
  if t.state<>'in_use' or t.current_vessel_id is null then
    raise exception 'Tag % is not on a vessel', t.code;
  end if;
  -- Occupancy comes from lifecycle_state only.
  select * into v from public.vessel
  where id=t.current_vessel_id and org_id=app.org_id() and lifecycle_state='occupied' for update;
  if v.id is null then raise exception 'Tag % is not on an occupied vessel', t.code; end if;
  return v;
end $$;

-- Scanned location text → location row (archived included, so archived scans are named).
create function app.freezer_location(p_raw text) returns public.location
language sql stable security definer set search_path='' as $$
  select * from public.location
  where org_id=app.org_id()
    and (qr=btrim(p_raw,E' \t\r\n') or code=upper(btrim(p_raw,E' \t\r\n')))
$$;

-- Blast scan (station 'blast') or locate step 1 (station 'locate'): resolve the vessel,
-- stamp blast_in_at for blast, audit the scan. Blast is informational: no duration gate.
create function app.freezer_vessel_scan(p_station public.device_station, p_raw text,
  p_session uuid, p_parsed jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op uuid; v public.vessel; i public.intake; tag text; species text; reason text; msg text;
begin
  begin
    op:=app.freezer_operator(p_session,p_station);
    v:=app.freezer_vessel(p_raw);
    select * into i from public.intake where id=v.intake_id and org_id=app.org_id() for update;
    select code into tag from public.asset_tag where id=v.asset_tag_id;
    if i.state not in ('blast_freezer','stored') then
      raise exception 'Intake % has not been sent to blast', i.number;
    end if;
    if p_station='blast' then
      if v.stored_at is not null then
        raise exception 'Vessel % already left blast', tag;
      end if;
      if v.blast_in_at is null then
        update public.vessel set blast_in_at=now() where id=v.id returning * into v;
        msg:='In blast: '||tag||' · '||i.number;
      else
        msg:='Already in blast: '||tag||' · '||i.number;
      end if;
    else
      msg:=tag||' · '||i.number||' — scan a location';
    end if;
    select string_agg(distinct species_code,', ' order by species_code) into species
    from public.intake_line where intake_id=i.id;
  exception when raise_exception or insufficient_privilege then reason:=sqlerrm;
  end;
  insert into public.scan_log(org_id,station,device_id,operator_id,raw,parsed,result,reason,intake_id,vessel_id)
  values(app.org_id(),p_station,app.device_id(),op,coalesce(p_raw,''),p_parsed,
    case when reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,
    reason,i.id,v.id);
  return jsonb_build_object('ok',reason is null,'reason',coalesce(reason,msg),
    'vessel_id',case when reason is null then v.id end,
    'tag_code',case when reason is null then tag end,
    'intake_number',case when reason is null then i.number end,
    'species',case when reason is null then coalesce(v.species_summary,species) end);
end $$;

-- Locate: place the vessel on a live location. Rejects unknown and archived locations;
-- never gates on capacity and gives no fill guidance. Appends location_placement (whose
-- trigger mirrors vessel.location_id); the first placement moves the intake to stored.
-- Lock order: vessel → intake.
create function app.freezer_place(p_vessel_raw text, p_location_raw text, p_session uuid, p_parsed jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op uuid; v public.vessel; i public.intake; l public.location; tag text; reason text; msg text;
begin
  begin
    op:=app.freezer_operator(p_session,'locate');
    v:=app.freezer_vessel(p_vessel_raw);
    select * into i from public.intake where id=v.intake_id and org_id=app.org_id() for update;
    select code into tag from public.asset_tag where id=v.asset_tag_id;
    if i.state not in ('blast_freezer','stored') then
      raise exception 'Intake % has not been sent to blast', i.number;
    end if;
    l:=app.freezer_location(p_location_raw);
    if l.id is null then raise exception 'Unknown location'; end if;
    perform app.check_location_is_live(l.id);
    if v.location_id is distinct from l.id then
      -- clock_timestamp: the mirror picks the latest placed_at, and now() ties within a transaction
      insert into public.location_placement(org_id,vessel_id,location_id,placed_at,operator_id,station)
      values(app.org_id(),v.id,l.id,clock_timestamp(),op,'locate');
      update public.vessel set stored_at=coalesce(stored_at,now()),
        blast_out_at=case when blast_in_at is null then blast_out_at else coalesce(blast_out_at,now()) end
      where id=v.id;
      msg:='Placed '||tag||' → '||l.code;
    else
      msg:=tag||' already at '||l.code;
    end if;
    if i.state='blast_freezer' then
      update public.intake set state='stored' where id=i.id;
      perform app.emit_event(app.org_id(),'intake_stored',i.id,
        jsonb_build_object('vessel_id',v.id,'location_id',l.id));
    end if;
  exception when raise_exception or insufficient_privilege or foreign_key_violation or check_violation then
    reason:=sqlerrm;
  end;
  insert into public.scan_log(org_id,station,device_id,operator_id,raw,parsed,result,reason,intake_id,vessel_id,location_id)
  values(app.org_id(),'locate',app.device_id(),op,coalesce(p_location_raw,''),p_parsed,
    case when reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,
    reason,i.id,v.id,l.id);
  return jsonb_build_object('ok',reason is null,'reason',coalesce(reason,msg),
    'vessel_id',v.id,'location_code',l.code,'placed',reason is null,
    -- the two-step loop resets after a placement; on rejection the vessel stays pending
    'pending_vessel_raw',case when reason is null then null else p_vessel_raw end);
end $$;

revoke all on function app.freezer_vessel(text), app.freezer_location(text),
  app.freezer_vessel_scan(public.device_station,text,uuid,jsonb),
  app.freezer_place(text,text,uuid,jsonb) from public, anon, authenticated;

create function public.place_vessel(p_vessel_raw text, p_location_raw text, p_client_action_id text,
  p_operator_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a:=app.action_begin(p_client_action_id,'locate.place',
    jsonb_build_object('vessel_raw',p_vessel_raw,'location_raw',p_location_raw));
  if a->>'status'='done' then return a->'result'; end if;
  r:=app.freezer_place(p_vessel_raw,p_location_raw,p_operator_session,null);
  perform app.action_complete(p_client_action_id,r);
  return r;
end $$;

-- The Locate station's two-step loop in one idempotent scan action: a location scan
-- places the pending vessel; anything else is read as a vessel tag and becomes pending.
create function public.locate_scan(p_client_action_id text, p_raw text,
  p_pending_vessel_raw text default null, p_operator_session uuid default null, p_parsed jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a:=app.action_begin(p_client_action_id,'locate.scan',jsonb_build_object('raw',p_raw));
  if a->>'status'='done' then return a->'result'; end if;
  if (app.freezer_location(p_raw)).id is not null then
    r:=app.freezer_place(p_pending_vessel_raw,p_raw,p_operator_session,p_parsed);
  else
    r:=app.freezer_vessel_scan('locate',p_raw,p_operator_session,p_parsed);
    r:=r||jsonb_build_object('placed',false,
      'pending_vessel_raw',case when (r->>'ok')::boolean then btrim(p_raw,E' \t\r\n') else p_pending_vessel_raw end);
  end if;
  perform app.action_complete(p_client_action_id,r);
  return r;
end $$;

create function public.blast_vessel(p_client_action_id text, p_raw text,
  p_operator_session uuid default null, p_parsed jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a:=app.action_begin(p_client_action_id,'blast.scan',jsonb_build_object('raw',p_raw));
  if a->>'status'='done' then return a->'result'; end if;
  r:=app.freezer_vessel_scan('blast',p_raw,p_operator_session,p_parsed);
  perform app.action_complete(p_client_action_id,r);
  return r;
end $$;

revoke all on function public.admin_locations(text,text,jsonb,uuid),
  public.place_vessel(text,text,text,uuid), public.locate_scan(text,text,text,uuid,jsonb),
  public.blast_vessel(text,text,uuid,jsonb) from public, anon;
grant execute on function public.admin_locations(text,text,jsonb,uuid),
  public.place_vessel(text,text,text,uuid), public.locate_scan(text,text,text,uuid,jsonb),
  public.blast_vessel(text,text,uuid,jsonb) to authenticated;

-- Boxing pick list: a session's occupied vessels in walk-path order. Unlocated vessels
-- walk last. Filter by session_id; order by walk_seq.
create view public.vessel_walk_order with (security_invoker=true) as
select ai.session_id, v.org_id, v.id as vessel_id, v.intake_id, i.number as intake_number,
  t.code as tag_code, v.is_exchange, v.weight_lb, v.species_summary,
  l.id as location_id, l.code as location_code, l.sort_key,
  row_number() over (partition by ai.session_id
    order by l.sort_key nulls last, i.number, t.code nulls last, v.id)::int as walk_seq
from public.allocation_intake ai
join public.vessel v on v.intake_id=ai.intake_id and v.org_id=ai.org_id and v.lifecycle_state='occupied'
join public.intake i on i.id=v.intake_id
left join public.location l on l.id=v.location_id
left join public.asset_tag t on t.id=v.asset_tag_id;
revoke all on public.vessel_walk_order from public,anon;
grant select on public.vessel_walk_order to authenticated,service_role;

do $$ begin alter publication supabase_realtime add table public.location_placement; exception when duplicate_object then null; end $$;
