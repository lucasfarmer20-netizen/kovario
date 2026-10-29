-- Issue #84 (review): a storage box code typed (or scanned) into the pickup wizard is checked
-- against the storage master and written to scan_log at station 'storage', so accepted and
-- rejected freezer-pickup codes are audited and a typed one records entry_method = manual
-- (scan_log trigger, 20261029000000). The text is parsed only by packages/rules qr.ts
-- (parseManual); the station passes the fields it read, and this function trusts them only
-- as a lookup key: a well-formed code is not evidence the box exists (PRD rule 6).
-- Selecting a box changes nothing here; the pickup batch is still created by
-- create_pickup_batch.
create or replace function public.storage_box_scan(
  p_client_action_id text,
  p_raw text,
  p_storage_intake_id uuid,
  p_storage_number text default null,
  p_box_no int default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_result jsonb;
  v_intake public.storage_intake;
  v_box public.storage_box;
  v_operator uuid;
  v_reason text;
  v_code text := p_storage_number || '-' || p_box_no;
  v_scan uuid;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'storage.box_scan',
    jsonb_build_object('storage_intake_id', p_storage_intake_id));
  if v_action->>'status' = 'done' then return v_action->'result'; end if;

  if app.role() <> 'station' then
    select id into v_operator from public.org_member
    where org_id = app.org_id() and user_id = app.user_id();
  end if;

  select * into v_intake from public.storage_intake
  where id = p_storage_intake_id and org_id = app.org_id();
  if v_intake.id is null then
    v_reason := 'Storage intake not found.';
  elsif p_storage_number is null or p_box_no is null then
    v_reason := 'Not a storage box code. Type it as printed, e.g. STG-0001-2.';
  elsif p_storage_number <> v_intake.number then
    v_reason := v_code || ' is not on ' || v_intake.number || '.';
  else
    select * into v_box from public.storage_box
    where storage_intake_id = v_intake.id and org_id = app.org_id() and box_no = p_box_no;
    if v_box.id is null then
      v_reason := 'No box ' || p_box_no || ' on ' || v_intake.number || '.';
    elsif v_box.state <> 'stored' then
      v_reason := 'Box ' || p_box_no || ' is already picked up.';
    end if;
  end if;

  insert into public.scan_log(org_id, station, device_id, operator_id, raw, parsed, result, reason)
  values (app.org_id(), 'storage', app.device_id(), v_operator, coalesce(p_raw, ''),
    case when p_storage_number is not null and p_box_no is not null then
      jsonb_build_object('kind', 'SBOX', 'storageNumber', p_storage_number, 'boxNo', p_box_no,
        'storageIntakeId', v_intake.id, 'storageBoxId', v_box.id)
    end,
    case when v_reason is null then 'ok'::public.scan_log_result
      else 'rejected'::public.scan_log_result end,
    v_reason)
  returning id into v_scan;

  v_result := jsonb_build_object('ok', v_reason is null,
    'reason', coalesce(v_reason, 'Box ' || p_box_no || ' selected for pickup.'),
    'scan_id', v_scan, 'box_id', v_box.id, 'box_no', v_box.box_no);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;
revoke all on function public.storage_box_scan(text, text, uuid, text, int) from public, anon;
grant execute on function public.storage_box_scan(text, text, uuid, text, int) to authenticated;
