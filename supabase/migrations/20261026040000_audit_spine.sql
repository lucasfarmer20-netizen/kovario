-- Audit spine (docs/02-DOMAIN-MODEL.md §11, docs/01-ARCHITECTURE.md §7): action_log for
-- idempotent mutations, domain_event as the transactional outbox.

create table if not exists public.action_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  client_action_id text not null unique check (length(client_action_id) between 8 and 200),
  user_id uuid,
  device_id uuid references public.device (id) on delete set null,
  action text not null,
  input jsonb,
  result jsonb,
  -- null while the action is in flight; replays return `result` once set.
  completed_at timestamptz,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists action_log_org_at on public.action_log (org_id, at desc);

select app.track_updated_at('public.action_log');
select app.enable_org_rls('public.action_log', write_roles => '{}');

create table if not exists public.domain_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  kind text not null,
  subject_id uuid,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists domain_event_unprocessed on public.domain_event (org_id, created_at)
  where processed_at is null;

select app.track_updated_at('public.domain_event');
select app.enable_org_rls('public.domain_event', write_roles => '{}');

-- An in-flight claim older than this is treated as abandoned and may be taken over.
create or replace function app.action_stale_after()
returns interval
language sql
immutable
as $$ select interval '2 minutes' $$;

-- Claims `client_action_id` for the current org. Returns
--   {"status":"new"}                      — caller runs the action, then action_complete
--   {"status":"done","result":<stored>}   — replay: return the stored result
--   {"status":"pending"}                  — another request is running it now
-- SQL functions that do their whole write in one transaction call this first and
-- app.action_complete last, so the claim and the writes commit (or roll back) together.
create or replace function app.action_begin(p_client_action_id text, p_action text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_row public.action_log;
begin
  if v_org is null then
    raise exception 'action_begin: no org in session' using errcode = '42501';
  end if;

  insert into public.action_log (org_id, client_action_id, user_id, device_id, action, input)
  values (v_org, p_client_action_id, app.user_id(), app.device_id(), p_action, p_input)
  on conflict (client_action_id) do nothing
  returning * into v_row;

  if found then
    return jsonb_build_object('status', 'new');
  end if;

  select * into v_row from public.action_log
  where client_action_id = p_client_action_id
  for update;

  if v_row.org_id <> v_org or v_row.action <> p_action then
    raise exception 'action_begin: client_action_id already used for another action'
      using errcode = '23505';
  end if;

  if v_row.completed_at is not null then
    return jsonb_build_object('status', 'done', 'result', v_row.result);
  end if;

  if v_row.at < now() - app.action_stale_after() then
    update public.action_log
    set at = now(), user_id = app.user_id(), device_id = app.device_id(), input = p_input
    where id = v_row.id;
    return jsonb_build_object('status', 'new');
  end if;

  return jsonb_build_object('status', 'pending');
end;
$$;

create or replace function app.action_complete(p_client_action_id text, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.action_log
  set result = p_result, completed_at = now()
  where client_action_id = p_client_action_id
    and org_id = app.org_id()
    and completed_at is null;
  if not found then
    raise exception 'action_complete: no pending action %', p_client_action_id
      using errcode = 'P0002';
  end if;
end;
$$;

-- Releases a failed in-flight claim so the client can retry with the same id.
create or replace function app.action_abort(p_client_action_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.action_log
  where client_action_id = p_client_action_id
    and org_id = app.org_id()
    and completed_at is null;
end;
$$;

-- Outbox write, called inside the transaction that made the change. Like app.next_seq, an
-- end-user session may only write events for its own org.
create or replace function app.emit_event(p_org_id uuid, p_kind text, p_subject_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if app.is_end_user() and p_org_id is distinct from app.org_id() then
    raise exception 'emit_event: org mismatch' using errcode = '42501';
  end if;
  insert into public.domain_event (org_id, kind, subject_id, payload)
  values (p_org_id, p_kind, p_subject_id, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function app.action_begin(text, text, jsonb), app.action_complete(text, jsonb),
  app.action_abort(text), app.emit_event(uuid, text, uuid, jsonb) from public;
grant execute on function app.action_begin(text, text, jsonb), app.action_complete(text, jsonb),
  app.action_abort(text), app.emit_event(uuid, text, uuid, jsonb) to authenticated, service_role;

-- Data API entry points for packages/db `withAction` (the app schema is not exposed).
create or replace function public.action_begin(p_client_action_id text, p_action text, p_input jsonb default null)
returns jsonb
language sql
set search_path = ''
as $$ select app.action_begin(p_client_action_id, p_action, p_input) $$;

create or replace function public.action_complete(p_client_action_id text, p_result jsonb)
returns void
language sql
set search_path = ''
as $$ select app.action_complete(p_client_action_id, p_result) $$;

create or replace function public.action_abort(p_client_action_id text)
returns void
language sql
set search_path = ''
as $$ select app.action_abort(p_client_action_id) $$;

revoke all on function public.action_begin(text, text, jsonb), public.action_complete(text, jsonb),
  public.action_abort(text) from public, anon;
grant execute on function public.action_begin(text, text, jsonb), public.action_complete(text, jsonb),
  public.action_abort(text) to authenticated;
