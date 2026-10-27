-- WP-08: scoped print-agent identity, pairing, atomic queue operations.
alter table public.print_agent
  add column auth_user_id uuid unique references auth.users(id) on delete set null,
  add column pairing_key bytea not null default extensions.gen_random_bytes(32),
  add column pairing_expires_at timestamptz;
comment on column public.print_agent.token_hash is 'SHA-256 of the one-time pairing code; refreshable agent sessions are held by Supabase Auth';
alter table public.print_job add column claimed_by uuid references public.print_agent(id),
  add column attempts int not null default 0;

alter function app.custom_access_token_hook(jsonb) rename to staff_access_token_hook;
create function app.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_agent public.print_agent; v_claims jsonb;
begin
  select a.* into v_agent from public.print_agent a join public.org o on o.id=a.org_id and o.is_active
  where a.auth_user_id=(event->>'user_id')::uuid;
  if found then
    v_claims := (event->'claims') - 'org_id' - 'app_role' - 'device_id' - 'agent_id';
    return jsonb_build_object('claims', v_claims || jsonb_build_object('org_id',v_agent.org_id,'app_role','agent','agent_id',v_agent.id));
  end if;
  return app.staff_access_token_hook(event);
end $$;
revoke all on function app.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin;

create function app.agent_id() returns uuid language sql stable set search_path = '' as $$
  select case when app.role()='agent' then nullif(app.claims()->>'agent_id','')::uuid end
$$;
-- Agent scope is deny-by-default, including for tables added by later work packages.
-- Keep this separate so the existing-table backfill does not reset column grants.
create or replace function app.apply_agent_scope(tbl regclass)
returns void language plpgsql set search_path = '' as $$
declare predicate text := 'false';
begin
  predicate := case tbl
    when 'public.print_agent'::regclass then 'id = (select app.agent_id())'
    when 'public.printer'::regclass then 'agent_id = (select app.agent_id())'
    when 'public.print_job'::regclass then 'printer_id in (select id from public.printer where agent_id = (select app.agent_id()))'
    else 'false' end;
  execute format('drop policy if exists agent_scope on %s', tbl);
  execute format('create policy agent_scope on %s as restrictive to authenticated using ((select app.role()) is distinct from ''agent'' or (%s)) with check ((select app.role()) is distinct from ''agent'')', tbl, predicate);
end $$;
revoke all on function app.apply_agent_scope(regclass) from public;

-- Install the restriction before the read-only early return as well as for writable
-- tables. The original grant/tenant/write-role behavior is otherwise unchanged.
create or replace function app.enable_org_rls(tbl regclass, write_roles text[] default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  write_check text;
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = tbl and attname = 'org_id' and not attisdropped
  ) then
    raise exception 'enable_org_rls: % has no org_id column', tbl;
  end if;

  execute format('alter table %s enable row level security', tbl);
  execute format('revoke all on %s from anon, authenticated', tbl);
  execute format('grant select on %s to authenticated', tbl);
  execute format('grant all on %s to service_role', tbl);

  execute format('drop policy if exists org_select on %s', tbl);
  execute format('drop policy if exists org_insert on %s', tbl);
  execute format('drop policy if exists org_update on %s', tbl);
  execute format('drop policy if exists org_delete on %s', tbl);

  execute format(
    'create policy org_select on %s for select to authenticated using (org_id = (select app.org_id()))',
    tbl
  );

  perform app.apply_agent_scope(tbl);

  if write_roles is not null and cardinality(write_roles) = 0 then
    return; -- read-only for clients
  end if;

  execute format('grant insert, update, delete on %s to authenticated', tbl);

  write_check := 'org_id = (select app.org_id())';
  if write_roles is not null then
    write_check := write_check || format(' and (select app.role()) = any (%L::text[])', write_roles);
  end if;
  write_check := '(' || write_check || ')';

  execute format('create policy org_insert on %s for insert to authenticated with check %s', tbl, write_check);
  execute format(
    'create policy org_update on %s for update to authenticated using %s with check %s',
    tbl, write_check, write_check
  );
  execute format('create policy org_delete on %s for delete to authenticated using %s', tbl, write_check);
end;
$$;

revoke all on function app.enable_org_rls(regclass, text[]) from public;

-- Backfill all existing RLS tables; future tables inherit it via enable_org_rls.
-- scale_reading deliberately stays denied until the optional scale module ships.
do $$ declare t record; begin
  for t in select c.oid::regclass tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop
    perform app.apply_agent_scope(t.tbl);
  end loop;
end $$;

create function public.admin_create_print_agent(p_client_action_id text,p_name text,p_site_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; r jsonb; v_id uuid; begin
  perform app.require_role('{owner,manager}');
  a:=app.action_begin(p_client_action_id,'print_agent.create','{}');
  if a->>'status'='done' then return a->'result'; end if;
  if p_site_id is not null and not exists(select 1 from public.site where id=p_site_id and org_id=app.org_id()) then raise exception 'Invalid site'; end if;
  insert into public.print_agent(org_id,name,site_id) values(app.org_id(),trim(p_name),p_site_id) returning id into v_id;
  r:=jsonb_build_object('agent_id',v_id); perform app.action_complete(p_client_action_id,r); return r;
end $$;
create function public.admin_print_agent_pairing_code(p_client_action_id text,p_agent_id uuid)
returns table(code text,expires_at timestamptz,active boolean)
language plpgsql security definer set search_path = '' as $$
declare a jsonb; v public.print_agent; b bytea; c text:=''; e timestamptz;
  alphabet text:='ABCDEFGHJKMNPQRSTVWXYZ23456789';
begin
  perform app.require_role('{owner,manager}');
  select * into strict v from public.print_agent where id=p_agent_id and org_id=app.org_id() for update;
  a:=app.action_begin(p_client_action_id,'print_agent.pair','{}');
  b:=extensions.hmac(convert_to(p_client_action_id,'UTF8'),v.pairing_key,'sha256');
  for i in 0..7 loop c:=c||substr(alphabet,(get_byte(b,i)%length(alphabet))+1,1); end loop;
  if a->>'status'='done' then
    e:=(a->'result'->>'expires_at')::timestamptz;
    return query select c,e,coalesce(v.token_hash=app.sha256_hex(c) and v.pairing_expires_at>now(),false); return;
  end if;
  e:=now()+interval '10 minutes';
  update public.print_agent set token_hash=app.sha256_hex(c),pairing_expires_at=e where id=v.id;
  perform app.action_complete(p_client_action_id,jsonb_build_object('expires_at',e));
  return query select c,e,true;
end $$;
create function public.print_agent_redeem_pairing(p_code text)
returns table(agent_id uuid,org_id uuid,auth_user_id uuid)
language plpgsql security definer set search_path = '' as $$ begin
  return query update public.print_agent a set token_hash=null,pairing_expires_at=null
    from public.org o where a.org_id=o.id and o.is_active and a.token_hash=app.sha256_hex(upper(trim(p_code)))
    and a.pairing_expires_at>now() returning a.id,a.org_id,a.auth_user_id;
end $$;
create function public.print_agent_bind_auth_user(p_agent_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare previous uuid; begin
  select auth_user_id into previous from public.print_agent where id=p_agent_id for update;
  if not found then raise exception 'Agent missing'; end if;
  delete from auth.sessions where user_id in (previous,p_user_id);
  update public.print_agent set auth_user_id=p_user_id where id=p_agent_id;
end $$;

create function public.admin_save_printer(p_client_action_id text,p_name text,p_agent_id uuid,p_kind public.printer_kind,p_address text,p_site_id uuid default null,p_printer_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; r jsonb; v_id uuid; begin
  perform app.require_role('{owner,manager}'); a:=app.action_begin(p_client_action_id,'printer.save','{}');
  if a->>'status'='done' then return a->'result'; end if;
  if not exists(select 1 from public.print_agent where id=p_agent_id and org_id=app.org_id() and site_id is not distinct from p_site_id) then raise exception 'Agent must belong to the selected site'; end if;
  if p_kind='label_zpl' and p_address !~ '^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$' then raise exception 'Expected host or host:port'; end if;
  if length(trim(p_address))=0 then raise exception 'Address required'; end if;
  if p_printer_id is null then
    insert into public.printer(org_id,name,agent_id,kind,address,site_id) values(app.org_id(),trim(p_name),p_agent_id,p_kind,p_address,p_site_id) returning id into v_id;
  else
    update public.printer set name=trim(p_name),agent_id=p_agent_id,kind=p_kind,address=p_address,site_id=p_site_id where id=p_printer_id and org_id=app.org_id() returning id into v_id;
    if not found then raise exception 'Printer missing'; end if;
  end if;
  r:=jsonb_build_object('printer_id',v_id); perform app.action_complete(p_client_action_id,r); return r;
end $$;
create function public.enqueue_print_job(p_client_action_id text,p_printer_id uuid,p_kind public.print_job_kind,p_payload_type public.print_job_payload_type,p_payload text,p_copies int default 1,p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; r jsonb; v_id uuid; v_kind public.printer_kind; begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  a:=app.action_begin(p_client_action_id,'print.enqueue',jsonb_build_object('printer_id',p_printer_id,'kind',p_kind));
  if a->>'status'='done' then return a->'result'; end if;
  select kind into v_kind from public.printer where id=p_printer_id and org_id=app.org_id() and agent_id is not null;
  if not found then raise exception 'Printer not configured'; end if;
  if (v_kind='label_zpl')<>(p_payload_type='zpl') then raise exception 'Printer payload mismatch'; end if;
  if length(p_payload)=0 or octet_length(p_payload)>2000000 then raise exception 'Invalid payload size'; end if;
  if p_payload_type='pdf_url' and p_payload !~ '^https://' then raise exception 'PDF URL requires HTTPS'; end if;
  insert into public.print_job(org_id,printer_id,kind,payload_type,payload,copies,source) values(app.org_id(),p_printer_id,p_kind,p_payload_type,p_payload,p_copies,p_source) returning id into v_id;
  r:=jsonb_build_object('job_id',v_id); perform app.action_complete(p_client_action_id,r); return r;
end $$;
create function public.print_agent_heartbeat(p_client_action_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare a jsonb; begin
  perform app.require_role('{agent}'); a:=app.action_begin(p_client_action_id,'print.heartbeat','{}');
  if a->>'status'='done' then return a->'result'; end if;
  update public.print_agent set last_seen_at=now() where id=app.agent_id() and org_id=app.org_id() and auth_user_id=app.user_id();
  if not found then raise exception 'Unknown agent'; end if;
  -- A process crash leaves an ambiguous physical outcome: fail visibly, never auto-reprint.
  update public.print_job set state='failed',error='Agent interrupted; inspect output before reprinting' where claimed_by=app.agent_id() and state='printing' and updated_at<now()-interval '10 minutes';
  perform app.action_complete(p_client_action_id,'{}'); return '{}'::jsonb;
end $$;
create function public.claim_print_job(p_client_action_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a jsonb; j public.print_job; p public.printer; r jsonb; begin
  perform app.require_role('{agent}'); a:=app.action_begin(p_client_action_id,'print.claim','{}');
  if a->>'status'='done' then
    select q.* into j from public.print_job q where q.id=(a->'result'->>'job_id')::uuid and q.claimed_by=app.agent_id() and q.org_id=app.org_id() and q.state='printing';
    if not found then return 'null'::jsonb; end if;
    select * into p from public.printer where id=j.printer_id;
    return jsonb_build_object('id',j.id,'payload_type',j.payload_type,'payload',j.payload,'copies',j.copies,'address',p.address);
  end if;
  if not exists(select 1 from public.print_agent where id=app.agent_id() and org_id=app.org_id() and auth_user_id=app.user_id()) then raise exception 'Unknown agent'; end if;
  select q.* into j from public.print_job q join public.printer pr on pr.id=q.printer_id and pr.org_id=q.org_id
    where q.org_id=app.org_id() and pr.agent_id=app.agent_id() and q.state='queued'
    order by q.created_at,q.id for update of q skip locked limit 1;
  if found then
    update public.print_job set state='printing',claimed_by=app.agent_id(),attempts=attempts+1 where id=j.id;
    select * into p from public.printer where id=j.printer_id;
    r:=jsonb_build_object('id',j.id,'payload_type',j.payload_type,'payload',j.payload,'copies',j.copies,'address',p.address);
  else r:='null'::jsonb; end if;
  -- Do not persist payloads (signed URLs) in the audit log. Only the claimed id.
  perform app.action_complete(p_client_action_id,jsonb_build_object('job_id',j.id));
  return r;
end $$;
create function public.finish_print_job(p_client_action_id text,p_job_id uuid,p_error text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare a jsonb; begin
  perform app.require_role('{agent}'); a:=app.action_begin(p_client_action_id,'print.finish',jsonb_build_object('job_id',p_job_id));
  if a->>'status'='done' then return a->'result'; end if;
  update public.print_job set state=case when p_error is null then 'done'::public.print_job_state else 'failed'::public.print_job_state end,
    error=case when p_error is null then null else 'Delivery failed; inspect printer and agent log before reprinting' end
    where id=p_job_id and org_id=app.org_id() and claimed_by=app.agent_id() and state='printing';
  if not found then raise exception 'Job not claimed by agent'; end if;
  perform app.action_complete(p_client_action_id,'{}'); return '{}'::jsonb;
end $$;

revoke all on function public.print_agent_redeem_pairing(text),public.print_agent_bind_auth_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.print_agent_redeem_pairing(text),public.print_agent_bind_auth_user(uuid,uuid) to service_role;
revoke all on function public.admin_create_print_agent(text,text,uuid),public.admin_print_agent_pairing_code(text,uuid),public.admin_save_printer(text,text,uuid,public.printer_kind,text,uuid,uuid),public.enqueue_print_job(text,uuid,public.print_job_kind,public.print_job_payload_type,text,int,jsonb),public.print_agent_heartbeat(text),public.claim_print_job(text),public.finish_print_job(text,uuid,text) from public,anon;
grant execute on function public.admin_create_print_agent(text,text,uuid),public.admin_print_agent_pairing_code(text,uuid),public.admin_save_printer(text,text,uuid,public.printer_kind,text,uuid,uuid),public.enqueue_print_job(text,uuid,public.print_job_kind,public.print_job_payload_type,text,int,jsonb),public.print_agent_heartbeat(text),public.claim_print_job(text),public.finish_print_job(text,uuid,text) to authenticated;
-- Realtime is a wakeup hint; polling handles disconnects and missed notifications.
do $$ begin alter publication supabase_realtime add table public.print_job; exception when duplicate_object then null; end $$;
