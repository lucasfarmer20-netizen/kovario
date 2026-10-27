-- WP-10: a wave lock serializes scan/complete; intake locks are always sorted.
create function app.wave_operator(p_session uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_operator uuid; v_device public.device;
begin
  perform app.require_role('{owner,manager,staff,station}');
  if app.device_id() is not null then
    select * into v_device from public.device where id=app.device_id() and org_id=app.org_id() and auth_user_id=app.user_id();
    if v_device.id is null or not v_device.is_active or v_device.station <> 'wave' then
      raise exception 'station_mismatch' using errcode='42501';
    end if;
  end if;
  if app.role()='station' then
    update public.station_operator_session set expires_at=now()+interval '15 minutes'
    where id=p_session and org_id=app.org_id() and user_id=app.user_id() and expires_at>now()
    returning operator_id into v_operator;
    if v_operator is null then raise exception 'operator_pin_required' using errcode='42501'; end if;
  else
    select id into v_operator from public.org_member where org_id=app.org_id() and user_id=app.user_id();
  end if;
  return v_operator;
end $$;
revoke all on function app.wave_operator(uuid) from public, anon, authenticated;

create function public.create_wave(p_intake_ids uuid[], p_client_action_id text, p_operator_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_action jsonb; v_result jsonb; v_wave uuid; v_count int; v_settings jsonb;
begin
  perform app.wave_operator(p_operator_session);
  v_action:=app.action_begin(p_client_action_id,'wave.create',null);
  if v_action->>'status'='done' then return v_action->'result'; end if;
  if coalesce(cardinality(p_intake_ids),0)=0 then raise exception 'Select holding intakes'; end if;
  perform id from public.intake where org_id=app.org_id() and id=any(p_intake_ids) order by id for update;
  select count(*) into v_count from public.intake where org_id=app.org_id() and id=any(p_intake_ids)
    and state='holding' and wave_id is null and tote_count>0;
  if v_count<>cardinality(p_intake_ids) then raise exception 'Selection changed: choose unassigned holding intakes'; end if;
  select settings into v_settings from public.org where id=app.org_id();
  insert into public.wave(org_id,number,target_lb,tolerance_lb)
  values(app.org_id(),app.next_seq(app.org_id(),'wave'),coalesce((v_settings->>'wave_target_lb')::numeric,4000),coalesce((v_settings->>'wave_tolerance_lb')::numeric,250)) returning id into v_wave;
  insert into public.wave_intake(org_id,wave_id,intake_id) select app.org_id(),v_wave,unnest(p_intake_ids);
  update public.intake set wave_id=v_wave where org_id=app.org_id() and id=any(p_intake_ids);
  v_result:=jsonb_build_object('ok',true,'wave_id',v_wave);
  perform app.action_complete(p_client_action_id,v_result);
  return v_result;
end $$;

create function public.advance_wave(p_wave_id uuid, p_client_action_id text, p_operator_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_action jsonb; v_result jsonb; v_wave public.wave; v_reason text; v_expected int; v_scanned int;
begin
  perform app.wave_operator(p_operator_session);
  v_action:=app.action_begin(p_client_action_id,'wave.advance',jsonb_build_object('wave_id',p_wave_id));
  if v_action->>'status'='done' then return v_action->'result'; end if;
  select * into v_wave from public.wave where id=p_wave_id and org_id=app.org_id() for update;
  if v_wave.id is null then v_reason:='Wave not found';
  elsif v_wave.state='done' then v_reason:=null;
  elsif v_wave.state not in ('draft','verifying') then v_reason:='Wave is not active';
  else
    perform i.id from public.intake i join public.wave_intake wi on wi.intake_id=i.id
      where wi.wave_id=p_wave_id and wi.org_id=app.org_id() and i.org_id=app.org_id() order by i.id for update of i;
    if not exists(select 1 from public.wave_intake where wave_id=p_wave_id and org_id=app.org_id())
      or exists(select 1 from public.wave_intake wi join public.intake i on i.id=wi.intake_id where wi.wave_id=p_wave_id
        and (i.org_id<>app.org_id() or i.state<>'holding' or i.wave_id is distinct from p_wave_id or i.tote_count<1)) then
      v_reason:='Wave intakes are no longer holding';
    elsif v_wave.state='draft' then
      update public.wave set state='verifying' where id=p_wave_id;
    else
      select coalesce(sum(i.tote_count),0) into v_expected from public.wave_intake wi join public.intake i on i.id=wi.intake_id where wi.wave_id=p_wave_id;
      select count(*) into v_scanned from public.wave_scan ws join public.intake i on i.id=ws.intake_id
        join public.wave_intake wi on wi.intake_id=i.id and wi.wave_id=ws.wave_id
        where ws.wave_id=p_wave_id and ws.org_id=app.org_id() and ws.tote_no between 1 and i.tote_count;
      if v_scanned<>v_expected then v_reason:='Scan every tote before completing';
      else
        update public.intake set state='processing',pulled_at=now() where org_id=app.org_id() and wave_id=p_wave_id;
        update public.wave set state='done' where id=p_wave_id;
      end if;
    end if;
  end if;
  v_result:=jsonb_build_object('ok',v_reason is null,'reason',coalesce(v_reason,'Wave updated'));
  perform app.action_complete(p_client_action_id,v_result);
  return v_result;
end $$;

-- Raw QR text is resolved against the saved tote master, never parsed in SQL.
create function public.scan_wave_tote(p_wave_id uuid, p_raw text, p_client_action_id text, p_operator_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_action jsonb; v_result jsonb; v_wave public.wave; v_tag public.tote_tag; v_intake public.intake;
  v_reason text; v_operator uuid; v_scan uuid;
begin
  perform app.require_role('{owner,manager,staff,station}');
  v_action:=app.action_begin(p_client_action_id,'wave.scan',jsonb_build_object('wave_id',p_wave_id));
  if v_action->>'status'='done' then return v_action->'result'; end if;
  begin
    v_operator:=app.wave_operator(p_operator_session);
  exception when insufficient_privilege then v_reason:=sqlerrm;
  end;
  select * into v_wave from public.wave where id=p_wave_id and org_id=app.org_id() for update;
  if v_reason is null then
    if v_wave.id is null then v_reason:='Wave not found';
    elsif v_wave.state='done' then v_reason:='Wave already complete';
    elsif v_wave.state<>'verifying' then v_reason:='Start verification first';
    else
      select * into v_tag from public.tote_tag where org_id=app.org_id() and qr=btrim(p_raw,E' \t\r\n');
      select * into v_intake from public.intake where id=v_tag.intake_id and org_id=app.org_id();
      if v_tag.id is null then v_reason:='Unknown tote: scan a numbered tote label';
      elsif v_intake.wave_id is distinct from p_wave_id or not exists(select 1 from public.wave_intake where wave_id=p_wave_id and intake_id=v_intake.id and org_id=app.org_id()) then v_reason:='Tote not in this wave';
      elsif v_intake.state<>'holding' or v_tag.tote_no>v_intake.tote_count then v_reason:='Tote is no longer eligible';
      elsif exists(select 1 from public.wave_scan where wave_id=p_wave_id and intake_id=v_intake.id and tote_no=v_tag.tote_no) then v_reason:='Tote already scanned';
      else
        insert into public.wave_scan(org_id,wave_id,intake_id,tote_no,operator_id) values(app.org_id(),p_wave_id,v_intake.id,v_tag.tote_no,v_operator);
      end if;
    end if;
  end if;
  insert into public.scan_log(org_id,station,device_id,operator_id,raw,parsed,result,reason,intake_id)
  values(app.org_id(),'wave',app.device_id(),v_operator,coalesce(p_raw,''),
    case when v_tag.id is not null then jsonb_build_object('kind','TOTE','intakeNumber',v_intake.number,'toteNo',v_tag.tote_no) end,
    case when v_reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,v_reason,v_intake.id) returning id into v_scan;
  v_result:=jsonb_build_object('ok',v_reason is null,'reason',coalesce(v_reason,'Tote accepted'),'scan_id',v_scan);
  perform app.action_complete(p_client_action_id,v_result);
  return v_result;
end $$;
revoke all on function public.create_wave(uuid[],text,uuid), public.advance_wave(uuid,text,uuid), public.scan_wave_tote(uuid,text,text,uuid) from public,anon;
grant execute on function public.create_wave(uuid[],text,uuid), public.advance_wave(uuid,text,uuid), public.scan_wave_tote(uuid,text,text,uuid) to authenticated;
do $$ begin
 alter publication supabase_realtime add table public.wave;
 alter publication supabase_realtime add table public.wave_scan;
exception when duplicate_object then null; end $$;
