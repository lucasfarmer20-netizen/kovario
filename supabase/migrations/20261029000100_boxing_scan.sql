-- Issue #84 (review): boxing scans, typed or scanned, are validated against the masters and
-- written to scan_log like every other station, so a typed boxing code records
-- entry_method = manual (scan_log trigger, 20261029000000) and counts in
-- report_manual_entries. Raw text is resolved against saved masters (settlement boxing QR via
-- app.qr_box, asset tag qr/code), never parsed here. The station keeps its local tick
-- projection (I15); this call is the server's word on whether the code is real and in scope.
--
-- p_session_id null = the boxing queue (a receipt's boxing QR opens its party);
-- otherwise the party screen (a tag must be on this party's pick list, a boxing QR must be
-- this party's, I11).
create or replace function public.boxing_scan(
  p_client_action_id text,
  p_raw text,
  p_session_id uuid default null,
  p_operator_session uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_result jsonb;
  v_raw text := btrim(coalesce(p_raw, ''), E' \t\r\n');
  v_op uuid;
  v_reason text;
  v_kind text;
  v_settlement public.settlement;
  v_tag public.asset_tag;
  v_session_number text;
  v_vessel_id uuid;
  v_intake_id uuid;
  v_scan uuid;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'boxing.scan',
    jsonb_build_object('session_id', p_session_id));
  if v_action->>'status' = 'done' then return v_action->'result'; end if;

  begin
    v_op := app.boxing_operator(p_operator_session);
  exception when insufficient_privilege then
    -- The queue screen identifies no operator; the party screen needs the live PIN proof.
    if p_session_id is not null or sqlerrm = 'station_mismatch' then v_reason := sqlerrm; end if;
  end;

  if v_reason is null then
    select * into v_settlement from public.settlement
    where org_id = app.org_id() and app.qr_box(boxing_token) = v_raw;
    if v_settlement.id is not null then
      v_kind := 'BOX';
    else
      select * into v_tag from public.asset_tag
      where org_id = app.org_id() and (qr = v_raw or code = app.normalize_tag_code(v_raw));
      if v_tag.id is not null then v_kind := 'TAG'; end if;
    end if;

    if p_session_id is null then
      if v_kind is distinct from 'BOX' then
        v_reason := case when v_raw like 'FL:BOX:%'
          then 'That boxing QR does not match a settlement'
          else 'Scan the boxing QR on a settlement receipt' end;
      end if;
    else
      select number into v_session_number from public.allocation_session
      where id = p_session_id and org_id = app.org_id();
      if v_session_number is null then
        v_reason := 'Party not found';
      elsif v_kind = 'BOX' then
        if v_settlement.session_id <> p_session_id then
          v_reason := 'That receipt belongs to another party; one party per Complete. Finish '
            || v_session_number || ' first.';
        end if;
      elsif v_kind = 'TAG' then
        -- Occupancy and scope exactly as the pick list (vessel_walk_order) projects them.
        select w.vessel_id, w.intake_id into v_vessel_id, v_intake_id
        from public.vessel_walk_order w
        where w.session_id = p_session_id and w.org_id = app.org_id()
          and w.vessel_id = v_tag.current_vessel_id;
        if v_vessel_id is null then
          v_reason := 'Tag ' || v_tag.code || ' is not on ' || v_session_number || '''s pick list';
        end if;
      elsif v_raw like 'FL:BOX:%' then
        v_reason := 'That boxing QR does not match a settlement';
      elsif app.normalize_tag_code(v_raw) is not null then
        v_reason := 'Tag ' || app.normalize_tag_code(v_raw) || ' is not on '
          || v_session_number || '''s pick list';
      else
        v_reason := 'Scan a basket tag or a boxing QR';
      end if;
    end if;
  end if;

  insert into public.scan_log(org_id, station, device_id, operator_id, raw, parsed, result,
    reason, intake_id, vessel_id)
  values (app.org_id(), 'boxing', app.device_id(), v_op, coalesce(p_raw, ''),
    case v_kind
      when 'BOX' then jsonb_build_object('kind', 'BOX', 'sessionId', v_settlement.session_id)
      when 'TAG' then jsonb_build_object('kind', 'TAG', 'code', v_tag.code)
    end,
    case when v_reason is null then 'ok'::public.scan_log_result
      else 'rejected'::public.scan_log_result end,
    v_reason, v_intake_id, v_vessel_id)
  returning id into v_scan;

  v_result := jsonb_build_object('ok', v_reason is null,
    'reason', coalesce(v_reason, 'Accepted'), 'scan_id', v_scan, 'kind', v_kind,
    'session_id', v_settlement.session_id, 'vessel_id', v_vessel_id,
    'tag_code', v_tag.code);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;
revoke all on function public.boxing_scan(text, text, uuid, uuid) from public, anon;
grant execute on function public.boxing_scan(text, text, uuid, uuid) to authenticated;
