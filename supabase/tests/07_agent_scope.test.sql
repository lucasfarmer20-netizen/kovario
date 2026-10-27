-- WP-08 tenancy: an agent session on a plant PC must not inherit new org tables.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid
       and p.polname = 'agent_scope' and not p.polpermissive
       and p.polcmd = '*' and 'authenticated'::regrole = any(p.polroles))),
  0::bigint,
  'every public RLS table has a restrictive agent_scope policy for all operations'
);

-- Simulate later WPs calling the common helper (including an idempotent re-run).
create table public.agent_scope_probe (
  id int primary key,
  org_id uuid not null references public.org(id),
  label text not null
);
select app.enable_org_rls('public.agent_scope_probe');
select app.enable_org_rls('public.agent_scope_probe');
create table public.agent_scope_readonly_probe (
  id int primary key,
  org_id uuid not null references public.org(id)
);
select app.enable_org_rls('public.agent_scope_readonly_probe', write_roles => '{}');
insert into public.agent_scope_probe values (1, '00000000-0000-4000-8000-000000000001', 'tenant row');
insert into public.agent_scope_readonly_probe values (1, '00000000-0000-4000-8000-000000000001');

select is(
  (select count(*) from pg_policy where polrelid in
    ('public.agent_scope_probe'::regclass, 'public.agent_scope_readonly_probe'::regclass)
    and polname = 'agent_scope' and not polpermissive),
  2::bigint,
  'new writable and read-only tables inherit restrictive scope, even after helper re-run'
);
select set_config('request.jwt.claims',
  '{"role":"authenticated","org_id":"00000000-0000-4000-8000-000000000001","app_role":"agent"}', true);
set local role authenticated;
select is((select count(*) from public.agent_scope_probe), 0::bigint,
  'agent cannot read a future writable table in its own org');
select is((select count(*) from public.agent_scope_readonly_probe), 0::bigint,
  'agent cannot read a future read-only table in its own org');
select throws_ok(
  $$ insert into public.agent_scope_probe values (2, '00000000-0000-4000-8000-000000000001', 'forbidden') $$,
  '42501', null, 'agent cannot insert through a future unrestricted org write policy'
);
with changed as (update public.agent_scope_probe set label = 'forbidden' returning id)
select is((select count(*) from changed), 0::bigint, 'agent cannot update future table rows');
with changed as (delete from public.agent_scope_probe returning id)
select is((select count(*) from changed), 0::bigint, 'agent cannot delete future table rows');

-- Staff access remains governed by the normal tenant and write-role policies.
reset role;
select set_config('request.jwt.claims',
  '{"role":"authenticated","org_id":"00000000-0000-4000-8000-000000000001","app_role":"staff"}', true);
set local role authenticated;
select is((select count(*) from public.agent_scope_probe), 1::bigint,
  'staff can still read its org rows on future writable tables');
select is((select count(*) from public.agent_scope_readonly_probe), 1::bigint,
  'staff can still read its org rows on future read-only tables');
select lives_ok(
  $$ insert into public.agent_scope_probe values (2, '00000000-0000-4000-8000-000000000001', 'allowed') $$,
  'staff write privileges are unchanged by agent scope'
);
reset role;
select * from finish();
rollback;
