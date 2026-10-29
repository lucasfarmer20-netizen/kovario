-- Issue #86: exchange (untagged) vessels through blast and locate. The tag path
-- (20261027061000_freezers.sql, typed codes via #84) is unchanged; this adds the tagless path,
-- keyed by vessel id, with the same operator proof, lock order (vessel → intake), action_log
-- and scan_log as a tag scan. A tagged vessel is never accepted by id: its tag is scanned.
-- Occupancy is read only from vessel.lifecycle_state (AGENTS rule 2).

-- Tapped tagless vessel → the locked vessel row. Rejects another org's vessel, a tagged
-- vessel and a vessel no longer occupied.
create or replace function app.freezer_vessel_by_id(p_vessel_id uuid) returns public.vessel
language plpgsql security definer set search_path='' as $$
declare v public.vessel; tag text;
begin
  select * into v from public.vessel where id=p_vessel_id and org_id=app.org_id() for update;
  if v.id is null then raise exception 'Unknown vessel'; end if;
  if v.asset_tag_id is not null then
    select code into tag from public.asset_tag where id=v.asset_tag_id;
    raise exception 'Vessel % has a tag; scan the tag', tag;
  end if;
  if v.lifecycle_state<>'occupied' then
    raise exception '% basket is not in the freezer', case when v.is_exchange then 'Exchange' else 'Untagged' end;
  end if;
  return v;
end $$;

-- Blast scan / locate step 1, by tag (p_raw) or, for a tagless vessel, by id (p_vessel_id).
drop function if exists app.freezer_vessel_scan(public.device_station,text,uuid,jsonb);
create function app.freezer_vessel_scan(p_station public.device_station, p_raw text,
  p_session uuid, p_parsed jsonb, p_vessel_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op uuid; v public.vessel; i public.intake; tag text; label text; species text; reason text; msg text;
begin
  begin
    op:=app.freezer_operator(p_session,p_station);
    if p_vessel_id is null then
      v:=app.freezer_vessel(p_raw);
    else
      v:=app.freezer_vessel_by_id(p_vessel_id);
    end if;
    select * into i from public.intake where id=v.intake_id and org_id=app.org_id() for update;
    select code into tag from public.asset_tag where id=v.asset_tag_id;
    label:=coalesce(tag, case when v.is_exchange then 'Exchange basket' else 'Untagged basket' end);
    if i.state not in ('blast_freezer','stored') then
      raise exception 'Intake % has not been sent to blast', i.number;
    end if;
    if p_station='blast' then
      if v.stored_at is not null then
        raise exception '% already left blast', coalesce('Vessel '||tag, label);
      end if;
      if v.blast_in_at is null then
        update public.vessel set blast_in_at=now() where id=v.id returning * into v;
        msg:='In blast: '||label||' · '||i.number;
      else
        msg:='Already in blast: '||label||' · '||i.number;
      end if;
    else
      msg:=label||' · '||i.number||' — scan a location';
    end if;
    select string_agg(distinct species_code,', ' order by species_code) into species
    from public.intake_line where intake_id=i.id;
  exception when raise_exception or insufficient_privilege then reason:=sqlerrm;
  end;
  insert into public.scan_log(org_id,station,device_id,operator_id,raw,parsed,result,reason,intake_id,vessel_id)
  values(app.org_id(),p_station,app.device_id(),op,coalesce(p_raw,''),
    coalesce(p_parsed,case when p_vessel_id is not null then
      jsonb_build_object('kind','TAP','vessel_id',p_vessel_id) end),
    case when reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,
    reason,i.id,v.id);
  return jsonb_build_object('ok',reason is null,'reason',coalesce(reason,msg),
    'vessel_id',case when reason is null then v.id end,
    'tag_code',case when reason is null then tag end,
    'is_exchange',case when reason is null then v.is_exchange end,
    'intake_number',case when reason is null then i.number end,
    'species',case when reason is null then coalesce(v.species_summary,species) end);
end $$;

-- Locate step 2. As 20261027061000, plus: a tagless vessel selected by id (no tag text) is
-- placed by that id alone; a tagged vessel still needs its tag text to match.
create or replace function app.freezer_place(p_vessel_raw text, p_location_raw text, p_session uuid, p_parsed jsonb,
  p_expected_vessel uuid default null, p_two_step boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op uuid; v public.vessel; i public.intake; l public.location; tag text; label text; reason text; msg text;
  stale boolean:=false; raw text:=btrim(p_vessel_raw,E' \t\r\n');
begin
  begin
    op:=app.freezer_operator(p_session,'locate');
    if p_expected_vessel is null and p_two_step and coalesce(raw,'')<>'' then
      stale:=true;
      raise exception 'Vessel selection expired; scan the tag again';
    end if;
    if p_expected_vessel is null then
      v:=app.freezer_vessel(p_vessel_raw);
    else
      select * into v from public.vessel
      where id=p_expected_vessel and org_id=app.org_id() and lifecycle_state='occupied' for update;
      if coalesce(raw,'')='' then
        if v.id is null or v.asset_tag_id is not null then
          stale:=true;
          raise exception 'Selected basket changed since it was chosen; choose it again';
        end if;
      elsif v.id is null or not exists(select 1 from public.asset_tag t
          where t.id=v.asset_tag_id and t.org_id=v.org_id and t.state='in_use'
            and t.current_vessel_id=v.id and (t.qr=raw or t.code=app.normalize_tag_code(raw))) then
        stale:=true;
        raise exception 'Selected vessel changed since its tag was scanned; scan the tag again';
      end if;
    end if;
    select * into i from public.intake where id=v.intake_id and org_id=app.org_id() for update;
    select code into tag from public.asset_tag where id=v.asset_tag_id;
    label:=coalesce(tag, case when v.is_exchange then 'Exchange basket' else 'Untagged basket' end);
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
      msg:='Placed '||label||' → '||l.code;
    else
      msg:=label||' already at '||l.code;
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
    'reset',reason is null or stale,
    'pending_vessel_raw',case when reason is null or stale then null else p_vessel_raw end,
    'pending_vessel_id',case when reason is null or stale then null else p_expected_vessel end);
end $$;

revoke all on function app.freezer_vessel_by_id(uuid),
  app.freezer_vessel_scan(public.device_station,text,uuid,jsonb,uuid) from public, anon, authenticated;

-- Blast in a tagless vessel from the "Released, waiting for blast-in" list.
create or replace function public.blast_vessel_by_id(p_client_action_id text, p_vessel_id uuid,
  p_operator_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a:=app.action_begin(p_client_action_id,'blast.tap',jsonb_build_object('vessel_id',p_vessel_id));
  if a->>'status'='done' then return a->'result'; end if;
  r:=app.freezer_vessel_scan('blast',null,p_operator_session,null,p_vessel_id);
  perform app.action_complete(p_client_action_id,r);
  return r;
end $$;

-- Locate step 1 for a tagless vessel, chosen by tap. Step 2 is the location scan through
-- locate_scan with p_pending_vessel_id set and no p_pending_vessel_raw.
create or replace function public.locate_vessel_by_id(p_client_action_id text, p_vessel_id uuid,
  p_operator_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb;
begin
  perform app.require_role('{owner,manager,staff,station}');
  a:=app.action_begin(p_client_action_id,'locate.tap',jsonb_build_object('vessel_id',p_vessel_id));
  if a->>'status'='done' then return a->'result'; end if;
  r:=app.freezer_vessel_scan('locate',null,p_operator_session,null,p_vessel_id);
  r:=r||jsonb_build_object('placed',false,'reset',false,'pending_vessel_raw',null,
    'pending_vessel_id',case when (r->>'ok')::boolean then r->'vessel_id' end);
  perform app.action_complete(p_client_action_id,r);
  return r;
end $$;

revoke all on function public.blast_vessel_by_id(text,uuid,uuid),
  public.locate_vessel_by_id(text,uuid,uuid) from public, anon;
grant execute on function public.blast_vessel_by_id(text,uuid,uuid),
  public.locate_vessel_by_id(text,uuid,uuid) to authenticated;
