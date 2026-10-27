-- WP-12: atomic reconcile edits, immediate tag reservation, and scale acceptance.
alter table public.vessel add column manual boolean not null default false;
alter table public.vessel add column scale_reading_id uuid references public.scale_reading(id);

create function app.reconcile_operator(p_session uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare op uuid;
begin
 perform app.require_role('{owner,manager,staff,station}');
 if app.device_id() is not null and not exists(select 1 from public.device where id=app.device_id() and org_id=app.org_id() and auth_user_id=app.user_id() and is_active and station='reconcile') then raise exception 'station_mismatch' using errcode='42501'; end if;
 if app.role()='station' then
  update public.station_operator_session set expires_at=now()+interval '15 minutes' where id=p_session and org_id=app.org_id() and user_id=app.user_id() and expires_at>now() returning operator_id into op;
  if op is null then raise exception 'operator_pin_required' using errcode='42501'; end if;
 else select id into op from public.org_member where org_id=app.org_id() and user_id=app.user_id(); end if;
 return op;
end $$;
revoke all on function app.reconcile_operator(uuid) from public;

-- Receives canonical codes and QR text from rules/qr.ts; SQL never parses QR text.
create function public.admin_asset_tags(p_client_action_id text,p_tags jsonb default null,p_tag_id uuid default null,p_retire_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; t public.asset_tag;
begin
 perform app.require_role('{owner,manager}');
 a:=app.action_begin(p_client_action_id,'asset_tags.manage','{}');
 if a->>'status'='done' then return a->'result'; end if;
 if p_tags is not null then
  if jsonb_typeof(p_tags)<>'array' or jsonb_array_length(p_tags)>1000 then raise exception 'Invalid range'; end if;
  insert into public.asset_tag(org_id,code,qr) select app.org_id(),x->>'code',x->>'qr' from jsonb_array_elements(p_tags) x on conflict(org_id,code) do nothing;
 else
  select * into t from public.asset_tag where id=p_tag_id and org_id=app.org_id() for update;
  if t.id is null then raise exception 'Unknown tag'; end if;
  if t.state='in_use' then raise exception 'Tag in use'; end if;
  update public.asset_tag set state=case when p_retire_reason is null then 'available'::public.asset_tag_state else 'retired'::public.asset_tag_state end,retired_reason=p_retire_reason where id=t.id;
 end if;
 perform app.action_complete(p_client_action_id,'{}'); return '{}'::jsonb;
end $$;

create function public.reconcile_action(p_client_action_id text,p_intake_id uuid default null,p_operation text default 'open',p_vessel_id uuid default null,p_code text default null,p_weight numeric default null,p_operator_session uuid default null,p_raw text default null,p_parsed jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r jsonb; i public.intake; t public.asset_tag; v public.vessel; sr public.scale_reading; op uuid; holder text; reason text; selected uuid:=p_intake_id;
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
   update public.intake set state='blast_freezer' where id=i.id;
  elsif p_operation<>'open' then raise exception 'Unknown reconcile operation'; end if;
 exception when raise_exception or insufficient_privilege then reason:=sqlerrm;
 end;
 if p_raw is not null then
  insert into public.scan_log(org_id,station,device_id,operator_id,raw,parsed,result,reason,intake_id,vessel_id) values(app.org_id(),'reconcile',app.device_id(),op,p_raw,p_parsed,case when reason is null then 'ok'::public.scan_log_result else 'rejected'::public.scan_log_result end,reason,i.id,case when reason is null then v.id end);
 end if;
 r:=jsonb_build_object('ok',reason is null,'reason',coalesce(reason,'Accepted'),'intake_id',selected,'vessel_id',case when reason is null then v.id end);
 perform app.action_complete(p_client_action_id,r); return r;
end $$;
create function public.bind_tag(p_client_action_id text,p_code text,p_intake_id uuid,p_operator_session uuid default null) returns jsonb language sql set search_path='' as $$
 select public.reconcile_action(p_client_action_id,p_intake_id,'bind',p_code=>p_code,p_operator_session=>p_operator_session)
$$;
create function public.send_to_blast(p_client_action_id text,p_intake_id uuid,p_operator_session uuid default null) returns jsonb language sql set search_path='' as $$
 select public.reconcile_action(p_client_action_id,p_intake_id,'send',p_operator_session=>p_operator_session)
$$;
revoke all on function public.admin_asset_tags(text,jsonb,uuid,text),public.reconcile_action(text,uuid,text,uuid,text,numeric,uuid,text,jsonb),public.bind_tag(text,text,uuid,uuid),public.send_to_blast(text,uuid,uuid) from public,anon;
grant execute on function public.admin_asset_tags(text,jsonb,uuid,text),public.reconcile_action(text,uuid,text,uuid,text,numeric,uuid,text,jsonb),public.bind_tag(text,text,uuid,uuid),public.send_to_blast(text,uuid,uuid) to authenticated;
do $$ begin alter publication supabase_realtime add table public.vessel; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.scale_reading; exception when duplicate_object then null; end $$;
-- Agent read scope extends only to its own scale configuration/readings.
drop policy agent_scope on public.scale;
create policy agent_scope on public.scale as restrictive to authenticated using(app.role() is distinct from 'agent' or agent_id=app.agent_id()) with check(app.role() is distinct from 'agent');
drop policy agent_scope on public.scale_reading;
create policy agent_scope on public.scale_reading as restrictive to authenticated using(app.role() is distinct from 'agent' or scale_id in(select id from public.scale where agent_id=app.agent_id())) with check(false);
create function public.record_scale_reading(p_client_action_id text,p_scale_id uuid,p_weight numeric,p_stable boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb;
begin
 perform app.require_role('{agent}');
 a:=app.action_begin(p_client_action_id,'scale.read','{}');
 if a->>'status'='done' then return a->'result'; end if;
 if not exists(select 1 from public.scale s join public.print_agent ag on ag.id=s.agent_id and ag.org_id=s.org_id where s.id=p_scale_id and s.org_id=app.org_id() and ag.id=app.agent_id() and ag.auth_user_id=app.user_id()) then raise exception 'Scale not assigned to agent' using errcode='42501'; end if;
 if p_weight is null or p_weight::text in ('NaN','Infinity','-Infinity') or p_stable is null then raise exception 'Invalid reading'; end if;
 insert into public.scale_reading(org_id,scale_id,weight_lb,stable) values(app.org_id(),p_scale_id,p_weight,p_stable);
 perform app.action_complete(p_client_action_id,'{}'); return '{}'::jsonb;
end $$;
revoke all on function public.record_scale_reading(text,uuid,numeric,boolean) from public,anon;
grant execute on function public.record_scale_reading(text,uuid,numeric,boolean) to authenticated;

-- Canonical identity is structural; QR generation remains in rules/qr.ts.
alter table public.asset_tag add constraint asset_tag_canonical_code check(code=app.normalize_tag_code(code));

grant execute on function app.normalize_tag_code(text) to service_role;
