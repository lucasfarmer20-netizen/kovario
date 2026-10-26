-- Custom access token hook: org_id / app_role / device_id claims (docs/01-ARCHITECTURE.md §3, §5).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000a1', 'manager@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000a2', 'multi@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000a3', 'nobody@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000d1', 'device-x@devices.kovario.internal');

insert into public.org (id, slug, name, timezone) values
  ('a0000000-0000-4000-8000-00000000000a', 'org-a', 'Org A', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', 'org-b', 'Org B', 'UTC');

insert into public.org_member (org_id, user_id, role, display_name, is_default, created_at) values
  ('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a1', 'manager', 'Mgr', false, now()),
  ('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a2', 'staff', 'Multi', false, now() - interval '1 day'),
  ('b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-0000000000a2', 'cashier', 'Multi', true, now());

insert into public.device (id, org_id, name, station, auth_user_id) values
  ('a0000000-0000-4000-8000-0000000004a1', 'a0000000-0000-4000-8000-00000000000a', 'Wave 1', 'wave',
   'a0000000-0000-4000-8000-0000000000d1');

create function pg_temp.claims_for(p_user uuid) returns jsonb language sql as $$
  select app.custom_access_token_hook(jsonb_build_object(
    'user_id', p_user,
    'claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated'),
    'authentication_method', 'password'
  )) -> 'claims'
$$;

select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a1') ->> 'org_id',
  'a0000000-0000-4000-8000-00000000000a', 'member gets org_id claim');
select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a1') ->> 'app_role',
  'manager', 'member gets app_role claim from org_member.role');
select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a1') ->> 'role',
  'authenticated', 'Postgres role claim stays authenticated');

select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a2') ->> 'org_id',
  'b0000000-0000-4000-8000-00000000000b', 'multi-org user gets the is_default org');
select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a2') ->> 'app_role',
  'cashier', 'multi-org user gets the role in the is_default org');

select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000d1') ->> 'app_role',
  'station', 'device user gets app_role station');
select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000d1') ->> 'device_id',
  'a0000000-0000-4000-8000-0000000004a1', 'device user gets device_id claim');
select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000d1') ->> 'org_id',
  'a0000000-0000-4000-8000-00000000000a', 'device user gets the device org');

select ok(not (pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a3') ? 'org_id'),
  'user without membership gets no org_id claim');

update public.device set is_active = false where id = 'a0000000-0000-4000-8000-0000000004a1';
select ok(not (pg_temp.claims_for('a0000000-0000-4000-8000-0000000000d1') ? 'org_id'),
  'inactive device gets no org claims');

-- Org switcher flips the default; the next token carries the other org.
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000a2","role":"authenticated","org_id":"b0000000-0000-4000-8000-00000000000b","app_role":"cashier"}',
  true);
set local role authenticated;
select public.set_default_org('a0000000-0000-4000-8000-00000000000a');
reset role;
select is(pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a2') ->> 'org_id',
  'a0000000-0000-4000-8000-00000000000a', 'set_default_org switches the minted org');

update public.org set is_active = false where id = 'a0000000-0000-4000-8000-00000000000a';
select ok(not (pg_temp.claims_for('a0000000-0000-4000-8000-0000000000a1') ? 'org_id'),
  'inactive org is never stamped');

select * from finish();
rollback;
