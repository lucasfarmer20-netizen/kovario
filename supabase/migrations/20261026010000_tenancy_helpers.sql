-- Tenancy helpers (docs/01-ARCHITECTURE.md §3, §5).
-- Claims come from the custom access token hook (20261026050000_auth_hook.sql):
--   org_id    — the tenant the session acts in
--   app_role  — owner|manager|staff|cashier|station|agent (Postgres role stays authenticated)
--   device_id — set for station device sessions only

create or replace function app.claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function app.org_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(app.claims() ->> 'org_id', '')::uuid
$$;

create or replace function app.role()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(app.claims() ->> 'app_role', '')
$$;

create or replace function app.device_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(app.claims() ->> 'device_id', '')::uuid
$$;

create or replace function app.user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(app.claims() ->> 'sub', '')::uuid
$$;

-- True when the current request is an end-user session (anon/authenticated JWT).
-- Service-role requests and direct SQL (migrations, tests as postgres) return false.
create or replace function app.is_end_user()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.claims() ->> 'role', '') in ('anon', 'authenticated')
$$;

-- Raises unless the caller's app_role is one of `roles`.
create or replace function app.require_role(roles text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if app.org_id() is null or app.role() is null or not (app.role() = any (roles)) then
    raise exception 'forbidden: requires role %', array_to_string(roles, '|')
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function
  app.claims(), app.org_id(), app.role(), app.device_id(), app.user_id(), app.is_end_user(),
  app.require_role(text[])
to anon, authenticated, service_role;

-- updated_at maintenance --------------------------------------------------------------

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- app.track_updated_at('public.site') attaches the updated_at trigger. Idempotent.
create or replace function app.track_updated_at(tbl regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists set_updated_at on %s', tbl);
  execute format(
    'create trigger set_updated_at before update on %s for each row execute function app.set_updated_at()',
    tbl
  );
end;
$$;

-- Org RLS ------------------------------------------------------------------------------

-- app.enable_org_rls('public.site') — every tenant table calls this (AGENTS.md hard rule 1).
--   * enables RLS and grants table privileges to `authenticated` only (never `anon`);
--   * SELECT is visible iff org_id = app.org_id();
--   * INSERT/UPDATE/DELETE require org_id = app.org_id() and, when `write_roles` is given,
--     app.role() in write_roles. Pass write_roles => '{}' to make the table read-only for
--     clients (writes then go through security definer functions only).
-- Idempotent: re-running replaces the policies.
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
revoke all on function app.track_updated_at(regclass) from public;
