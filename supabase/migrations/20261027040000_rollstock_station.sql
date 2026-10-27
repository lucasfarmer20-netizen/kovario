-- WP-11. Master QR lookup only; QR encoding/parsing belongs to rules/qr.ts.
create function app.rollstock_operator(p_session uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_operator uuid;
begin
  perform app.require_role('{owner,manager,staff,station}');
  if app.device_id() is not null and not exists(select 1 from public.device
    where id=app.device_id() and org_id=app.org_id() and auth_user_id=app.user_id()
      and is_active and station='rollstock') then
    raise exception 'station_mismatch' using errcode='42501';
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
revoke all on function app.rollstock_operator(uuid) from public,anon,authenticated;

-- Read-only parity shared by the transaction and the station. UNION deduplicates
-- tote numbers seen at both stations, including repeated rollstock scans.
create view public.rollstock_tote_progress with (security_invoker=true) as
select i.id as intake_id,i.org_id,i.tote_count,
  (select count(*)::int from (
    select ws.tote_no from public.wave_scan ws where ws.intake_id=i.id and ws.org_id=i.org_id
    union
    select tt.tote_no from public.scan_log sl join public.tote_tag tt
      on tt.intake_id=i.id and tt.org_id=i.org_id and tt.qr=btrim(sl.raw,E' \t\r\n')
    where sl.intake_id=i.id and sl.org_id=i.org_id and sl.station='rollstock' and sl.result='ok'
  ) seen where tote_no between 1 and i.tote_count) as scanned
from public.intake i;
revoke all on public.rollstock_tote_progress from public,anon;
grant select on public.rollstock_tote_progress to authenticated,service_role;

-- NULL raw means Finish queue. Overrides require a reason and a live manager
-- elevation for staff/station callers; manager accounts may approve directly.
create function public.rollstock_scan_advance(
  p_raw text,p_open_intake_id uuid,p_client_action_id text,
  p_operator_session uuid default null,p_override_reason text default null,p_elevation_token text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_action jsonb; v_result jsonb; v_tag public.tote_tag; v_next public.intake;
  v_open public.intake; v_reason text; v_operator uuid; v_manager uuid; v_scan uuid; v_scanned int;
  v_open_id uuid:=p_open_intake_id;
begin
  perform app.require_role('{owner,manager,staff,station}');
  v_action:=app.action_begin(p_client_action_id,'rollstock.scan_advance',
    jsonb_build_object('open_intake_id',p_open_intake_id,'override_reason',p_override_reason));
  if v_action->>'status'='done' then return v_action->'result'; end if;
  begin
    v_operator:=app.rollstock_operator(p_operator_session);
    if p_override_reason is not null then
      if length(btrim(p_override_reason))<3 then raise exception 'Override reason required'; end if;
      if app.role() in ('owner','manager') then v_manager:=v_operator;
      else v_manager:=app.require_elevation(p_elevation_token); end if;
    end if;
  exception when insufficient_privilege then v_reason:=sqlerrm;
  end;
  if p_raw is not null then
    select * into v_tag from public.tote_tag where org_id=app.org_id() and qr=btrim(p_raw,E' \t\r\n');
    select * into v_next from public.intake where id=v_tag.intake_id and org_id=app.org_id();
  end if;
  -- Wave first, then sorted intakes, matching wave advance/cancel lock order.
  perform id from public.wave where org_id=app.org_id() and id=v_next.wave_id order by id for update;
  perform id from public.intake where org_id=app.org_id() and id in (v_next.id,p_open_intake_id) order by id for update;
  select * into v_next from public.intake where id=v_tag.intake_id and org_id=app.org_id();
  select * into v_open from public.intake where id=p_open_intake_id and org_id=app.org_id();
  if v_reason is null then
    if p_open_intake_id is not null and (v_open.id is null or v_open.state<>'rollstock') then
      v_reason:='Open intake changed; refresh station';
    elsif p_raw is not null and (v_tag.id is null or v_tag.tote_no>v_next.tote_count) then
      v_reason:='Unknown tote: scan a numbered tote label';
    elsif p_raw is not null and v_next.state not in ('holding','processing','rollstock') then
      v_reason:='Intake is not eligible for rollstock';
    elsif p_raw is not null and v_next.state='rollstock' and v_next.id is distinct from v_open.id then
      v_reason:='Intake already open at rollstock';
    elsif v_next.state='holding' and exists(select 1 from public.wave where id=v_next.wave_id and org_id=app.org_id() and state='verifying') then
      v_reason:='Remove intake from verifying wave before bypass';
    elsif v_open.id is not null and v_next.id is distinct from v_open.id then
      select scanned into v_scanned from public.rollstock_tote_progress where intake_id=v_open.id;
      if (v_open.tote_count<1 or v_scanned<v_open.tote_count) and v_manager is null then
        v_reason:=format('Missing totes: %s of %s scanned',v_scanned,v_open.tote_count);
      else
        if v_manager is not null then
          insert into public.domain_event(org_id,kind,subject_id,payload) values(app.org_id(),'rollstock.completeness_override',v_open.id,
            jsonb_build_object('manager_id',v_manager,'reason',p_override_reason,'scanned',v_scanned,'expected',v_open.tote_count));
        end if;
        update public.intake set state='reconcile',rollstock_done_at=now() where id=v_open.id;
        v_open_id:=null;
      end if;
    end if;
  end if;
  if v_reason is null and p_raw is not null then
    if v_next.state='holding' then
      update public.intake set state='processing',pulled_at=now() where id=v_next.id;
      insert into public.domain_event(org_id,kind,subject_id,payload) values(app.org_id(),'rollstock.holding_bypass',v_next.id,
        jsonb_build_object('operator_id',v_operator,'from','holding','to','processing'));
    end if;
    if v_next.state in ('holding','processing') then
      update public.intake set state='rollstock' where id=v_next.id;
    end if;
    v_open_id:=v_next.id;
  end if;
  if p_raw is not null then
    insert into public.scan_log(org_id,station,device_id,operator_id,raw,result,reason,intake_id)
    values(app.org_id(),'rollstock',app.device_id(),v_operator,p_raw,
      case when v_reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,v_reason,v_next.id)
    returning id into v_scan;
  end if;
  v_result:=jsonb_build_object('ok',v_reason is null,'reason',coalesce(v_reason,case when p_raw is null then 'Queue finished' else 'Tote accepted' end),
    'open_intake_id',v_open_id,'scan_id',v_scan);
  perform app.action_complete(p_client_action_id,v_result);
  return v_result;
end $$;
revoke all on function public.rollstock_scan_advance(text,uuid,text,uuid,text,text) from public,anon;
grant execute on function public.rollstock_scan_advance(text,uuid,text,uuid,text,text) to authenticated;
