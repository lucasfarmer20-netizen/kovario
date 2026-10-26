-- Tenancy isolation: a member of org A cannot read or write org B rows on any table.
-- The table list is discovered from the catalog, so tables added by later migrations are
-- covered automatically (they must call app.enable_org_rls).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Fixtures: two orgs with one row of every tenancy table each ---------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000a1', 'owner-a@test.kovario'),
  ('b0000000-0000-4000-8000-0000000000b1', 'owner-b@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000a2', 'staff-a@test.kovario');

insert into public.org (id, slug, name, timezone) values
  ('a0000000-0000-4000-8000-00000000000a', 'org-a', 'Org A', 'America/Anchorage'),
  ('b0000000-0000-4000-8000-00000000000b', 'org-b', 'Org B', 'America/Anchorage');

insert into public.site (id, org_id, name, is_default) values
  ('a0000000-0000-4000-8000-0000000005a1', 'a0000000-0000-4000-8000-00000000000a', 'Main', true),
  ('b0000000-0000-4000-8000-0000000005b1', 'b0000000-0000-4000-8000-00000000000b', 'Main', true);

insert into public.org_member (id, org_id, user_id, role, display_name, pin_hash) values
  ('a0000000-0000-4000-8000-0000000003a1', 'a0000000-0000-4000-8000-00000000000a',
   'a0000000-0000-4000-8000-0000000000a1', 'owner', 'Owner A', extensions.crypt('1111', extensions.gen_salt('bf', 4))),
  ('a0000000-0000-4000-8000-0000000003a2', 'a0000000-0000-4000-8000-00000000000a',
   'a0000000-0000-4000-8000-0000000000a2', 'staff', 'Staff A', null),
  ('b0000000-0000-4000-8000-0000000003b1', 'b0000000-0000-4000-8000-00000000000b',
   'b0000000-0000-4000-8000-0000000000b1', 'owner', 'Owner B', extensions.crypt('2222', extensions.gen_salt('bf', 4)));

insert into public.device (id, org_id, name, station, site_id) values
  ('a0000000-0000-4000-8000-0000000004a1', 'a0000000-0000-4000-8000-00000000000a', 'Intake 1', 'intake',
   'a0000000-0000-4000-8000-0000000005a1'),
  ('b0000000-0000-4000-8000-0000000004b1', 'b0000000-0000-4000-8000-00000000000b', 'Intake 1', 'intake',
   'b0000000-0000-4000-8000-0000000005b1');

select app.next_seq('a0000000-0000-4000-8000-00000000000a', 'intake');
select app.next_seq('b0000000-0000-4000-8000-00000000000b', 'intake');

insert into public.action_log (org_id, client_action_id, action, result, completed_at) values
  ('a0000000-0000-4000-8000-00000000000a', 'action-a-0001', 'test', '{"n":1}', now()),
  ('b0000000-0000-4000-8000-00000000000b', 'action-b-0001', 'test', '{"n":2}', now());

select app.emit_event('a0000000-0000-4000-8000-00000000000a', 'test_event', null, '{}');
select app.emit_event('b0000000-0000-4000-8000-00000000000b', 'test_event', null, '{}');

insert into public.pin_throttle (org_id, user_id, failures) values
  ('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a1', 1),
  ('b0000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-0000000000b1', 1);

insert into public.elevation_grant (org_id, requested_by, manager_member_id, token_hash, expires_at) values
  ('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a1',
   'a0000000-0000-4000-8000-0000000003a1', app.sha256_hex('token-a'), now() + interval '5 minutes'),
  ('b0000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-0000000000b1',
   'b0000000-0000-4000-8000-0000000003b1', app.sha256_hex('token-b'), now() + interval '5 minutes');

-- Catalog-wide guarantees ---------------------------------------------------------------

select is(
  (select array_agg(tablename::text order by tablename) from pg_tables
   where schemaname = 'public' and not rowsecurity),
  null,
  'every public table has RLS enabled'
);

select is(
  (select array_agg(t.tablename::text order by t.tablename) from pg_tables t
   where t.schemaname = 'public' and t.tablename <> 'org'
     and not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = t.tablename
                       and c.column_name = 'org_id')),
  null,
  'every public table except org has org_id'
);

select is(
  (select array_agg(t.tablename::text order by t.tablename) from pg_tables t
   where t.schemaname = 'public'
     and not exists (select 1 from pg_policies p
                     where p.schemaname = 'public' and p.tablename = t.tablename and p.cmd = 'SELECT'
                       and p.qual like '%app.org_id()%')),
  null,
  'every public table has an org-scoped SELECT policy'
);

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'select')
       or has_table_privilege('anon', c.oid, 'insert'))),
  null,
  'anon has no table privileges on any public table'
);

-- Fixture is not vacuous: org B has rows in every table so far.
create temp table tenancy_tables on commit drop as
select t.tablename::text as tbl,
       case when t.tablename = 'org' then 'id' else 'org_id' end as org_col
from pg_tables t where t.schemaname = 'public';

do $$
declare
  r record;
  n bigint;
begin
  for r in select * from tenancy_tables loop
    execute format('select count(*) from public.%I where %I = %L', r.tbl, r.org_col,
                   'b0000000-0000-4000-8000-00000000000b') into n;
    if n = 0 and r.tbl in ('org', 'site', 'org_member', 'device', 'sequence_counter',
                           'action_log', 'domain_event', 'pin_throttle', 'elevation_grant') then
      raise exception 'fixture has no org B row in %', r.tbl;
    end if;
  end loop;
end $$;

-- Reads as org A: count of foreign-org rows visible per table (column-level grants mean
-- we count via the org column only, which every role may select).
create or replace function pg_temp.foreign_rows_visible(p_claims jsonb, p_org uuid)
returns table (tbl text, visible bigint)
language plpgsql
as $$
declare
  r record;
begin
  for r in select * from tenancy_tables order by 1 loop
    perform set_config('request.jwt.claims', p_claims::text, true);
    perform set_config('role', 'authenticated', true);
    execute format('select count(%I) from public.%I where %I <> %L', r.org_col, r.tbl, r.org_col, p_org)
      into visible;
    perform set_config('role', 'postgres', true);
    tbl := r.tbl;
    return next;
  end loop;
end;
$$;

select is(visible, 0::bigint, format('owner of org A sees no org B rows in %s', tbl))
from pg_temp.foreign_rows_visible(
  '{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"owner"}',
  'a0000000-0000-4000-8000-00000000000a'
);

select is(visible, 0::bigint, format('station of org A sees no org B rows in %s', tbl))
from pg_temp.foreign_rows_visible(
  '{"sub":"a0000000-0000-4000-8000-0000000000ff","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"station","device_id":"a0000000-0000-4000-8000-0000000004a1"}',
  'a0000000-0000-4000-8000-00000000000a'
);

-- A session with no org claim (signed-up user without membership) sees nothing at all.
select is(visible, 0::bigint, format('user without org sees no rows in %s', tbl))
from pg_temp.foreign_rows_visible(
  '{"sub":"c0000000-0000-4000-8000-0000000000c1","role":"authenticated"}',
  '00000000-0000-0000-0000-000000000000'
);

-- Writes as org A -----------------------------------------------------------------------
-- A probe table exercises enable_org_rls' generic write path (write_roles owner|manager),
-- which later work packages use; it is created after the catalog checks above.
create table public.rls_probe (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  label text
);
select app.enable_org_rls('public.rls_probe', write_roles => '{owner,manager}');
insert into public.rls_probe (id, org_id, label) values
  ('b0000000-0000-4000-8000-0000000009b1', 'b0000000-0000-4000-8000-00000000000b', 'B');

select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"owner"}',
  true);
set local role authenticated;

select isnt_empty(
  $$ select 1 from public.site where org_id = 'a0000000-0000-4000-8000-00000000000a' $$,
  'owner of org A sees own sites'
);

select lives_ok(
  $$ insert into public.rls_probe (org_id, label) values ('a0000000-0000-4000-8000-00000000000a', 'A') $$,
  'enable_org_rls: a write role writes rows of its own org'
);

select throws_ok(
  $$ insert into public.rls_probe (org_id, label) values ('b0000000-0000-4000-8000-00000000000b', 'Sneaky') $$,
  '42501', null,
  'enable_org_rls: owner of org A cannot insert into org B'
);

select is_empty(
  $$ update public.rls_probe set label = 'Hijacked' where id = 'b0000000-0000-4000-8000-0000000009b1' returning id $$,
  'enable_org_rls: owner of org A cannot update org B rows'
);

select is_empty(
  $$ delete from public.rls_probe where id = 'b0000000-0000-4000-8000-0000000009b1' returning id $$,
  'enable_org_rls: owner of org A cannot delete org B rows'
);

-- Sites are read-only for clients; managers write them through the atomic admin_* functions.
select throws_ok(
  $$ insert into public.site (org_id, name) values ('a0000000-0000-4000-8000-00000000000a', 'Direct') $$,
  '42501', null,
  'sites are not directly writable by clients'
);

select throws_ok(
  $$ select public.admin_rename_site('act-cross-org-1', 'b0000000-0000-4000-8000-0000000005b1', 'Hijacked') $$,
  'P0002', null,
  'owner of org A cannot rename an org B site through the admin functions'
);

select throws_ok(
  $$ select public.admin_set_default_site('act-cross-org-2', 'b0000000-0000-4000-8000-0000000005b1') $$,
  'P0002', null,
  'owner of org A cannot change org B''s default site'
);

select is_empty(
  $$ update public.org set name = 'Hijacked' where id = 'b0000000-0000-4000-8000-00000000000b' returning id $$,
  'owner of org A cannot update org B'
);

select throws_ok(
  $$ insert into public.action_log (org_id, client_action_id, action) values ('a0000000-0000-4000-8000-00000000000a', 'direct-insert', 'x') $$,
  '42501', null,
  'action_log is not directly writable by clients'
);

select throws_ok(
  $$ select pin_hash from public.org_member $$,
  '42501', null,
  'pin_hash is not readable by clients'
);

select throws_ok(
  $$ select token_hash from public.device $$,
  '42501', null,
  'device.token_hash is not readable by clients'
);

select throws_ok(
  $$ select * from app.sequence_prefix $$,
  '42501', null,
  'app.sequence_prefix is not readable by clients'
);

-- Staff cannot write (write_roles owner|manager) or manage sites.
reset role;
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000a2","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"staff"}',
  true);
set local role authenticated;

select throws_ok(
  $$ insert into public.rls_probe (org_id, label) values ('a0000000-0000-4000-8000-00000000000a', 'Staff') $$,
  '42501', null,
  'enable_org_rls: roles outside write_roles cannot write'
);

select throws_ok(
  $$ select public.admin_create_site('act-staff-site', 'Staff site') $$,
  '42501', null,
  'staff cannot create sites'
);

-- anon sees nothing.
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select throws_ok($$ select id from public.org $$, '42501', null, 'anon cannot read org');

reset role;
select * from finish();
rollback;
