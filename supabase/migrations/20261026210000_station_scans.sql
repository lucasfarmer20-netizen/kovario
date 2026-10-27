-- WP-05: PIN attribution and atomic scan audit/replay. No floor state transitions.
create table public.station_operator_session (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  user_id uuid not null,
  operator_id uuid not null references public.org_member(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select app.track_updated_at('public.station_operator_session');
select app.enable_org_rls('public.station_operator_session', write_roles => '{}');
revoke select on public.station_operator_session from authenticated;
grant select (org_id) on public.station_operator_session to authenticated;

create function public.station_identify(p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_id uuid;
begin
  v_result := public.operator_identify(p_pin);
  if not (v_result->>'ok')::boolean then return v_result; end if;
  insert into public.station_operator_session(org_id, user_id, operator_id)
  values (app.org_id(), app.user_id(), (v_result->'member'->>'id')::uuid)
  returning id into v_id;
  return v_result || jsonb_build_object('session_id', v_id);
end;
$$;

-- p_parsed comes from the server's rules/qr parser. This endpoint only audits;
-- Authenticated callers can supply inconsistent p_raw/p_parsed/p_reason: this is audit-only.
-- Domain-writing RPCs must validate master rows and transitions, never use parsed as proof.
-- Station-specific domain writes belong in their own transactional scan RPCs.
create function public.station_scan(
  p_client_action_id text, p_raw text, p_station public.device_station,
  p_parsed jsonb, p_reason text default null, p_operator_session uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_action jsonb; v_result jsonb; v_operator uuid; v_intake uuid;
  v_reason text := p_reason; v_id uuid; v_device public.device;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if app.device_id() is not null then
    select * into v_device from public.device where id = app.device_id()
      and org_id = app.org_id() and auth_user_id = app.user_id();
    if v_device.id is null or not v_device.is_active or v_device.station <> p_station then
      v_reason := 'station_mismatch';
    end if;
  end if;
  v_action := app.action_begin(p_client_action_id, 'station.scan', jsonb_build_object('station', p_station));
  if v_action->>'status' = 'done' then return v_action->'result'; end if;
  if app.role() = 'station' and v_reason is distinct from 'station_mismatch' then
    select operator_id into v_operator from public.station_operator_session
      where id = p_operator_session and org_id = app.org_id() and user_id = app.user_id()
        and expires_at > now();
    if v_operator is null then
      v_reason := 'operator_pin_required';
    else
      update public.station_operator_session set expires_at = now() + interval '15 minutes'
        where id = p_operator_session;
    end if;
  elsif app.role() <> 'station' then
    select id into v_operator from public.org_member
      where org_id = app.org_id() and user_id = app.user_id();
  end if;
  if v_reason is null then
    if p_parsed->>'kind' = 'TOTE' then
      select id into v_intake from public.intake where org_id = app.org_id()
        and number = p_parsed->>'intakeNumber'
        -- bigint covers every positive safe integer emitted by rules/qr.parse.
        and (p_parsed->>'toteNo' is null or tote_count >= (p_parsed->>'toteNo')::bigint);
      if v_intake is null then v_reason := 'unknown_tote'; end if;
    else
      v_reason := 'demo_requires_tote';
    end if;
  end if;
  insert into public.scan_log(org_id, station, device_id, operator_id, raw, parsed, result, reason, intake_id)
  values (app.org_id(), p_station, v_device.id, v_operator, p_raw, p_parsed,
    case when v_reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,
    v_reason, v_intake) returning id into v_id;
  v_result := jsonb_build_object('ok', v_reason is null, 'reason', coalesce(v_reason, 'Tote accepted'), 'scan_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;
revoke all on function public.station_identify(text), public.station_scan(text,text,public.device_station,jsonb,text,uuid) from public, anon;
grant execute on function public.station_identify(text), public.station_scan(text,text,public.device_station,jsonb,text,uuid) to authenticated;
-- Queues subscribe to intake changes; RLS still limits rows to the caller's org.
do $$ begin
  alter publication supabase_realtime add table public.intake;
exception when duplicate_object then null; end $$;
