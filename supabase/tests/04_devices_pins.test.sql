-- Device pairing, operator PIN, manager elevation, member admin (docs/01-ARCHITECTURE.md §5).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000a1', 'owner@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000a2', 'manager@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000a3', 'staff@test.kovario'),
  ('a0000000-0000-4000-8000-0000000000d1', 'device-1@devices.kovario.internal');

insert into public.org (id, slug, name, timezone) values
  ('a0000000-0000-4000-8000-00000000000a', 'org-a', 'Org A', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', 'org-b', 'Org B', 'UTC');

insert into public.site (id, org_id, name) values
  ('b0000000-0000-4000-8000-0000000005b1', 'b0000000-0000-4000-8000-00000000000b', 'B Main');

insert into public.org_member (id, org_id, user_id, role, display_name) values
  ('a0000000-0000-4000-8000-0000000003a1', 'a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a1', 'owner', 'Olive Owner'),
  ('a0000000-0000-4000-8000-0000000003a2', 'a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a2', 'manager', 'Max Manager'),
  ('a0000000-0000-4000-8000-0000000003a3', 'a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a3', 'staff', 'Sam Staff');

create function pg_temp.act_as(p_user text, p_role text, p_device text default null) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object(
    'sub', p_user, 'role', 'authenticated', 'org_id', 'a0000000-0000-4000-8000-00000000000a',
    'app_role', p_role, 'device_id', p_device))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.act_as(text, text, text) to authenticated, service_role;

-- Member admin ---------------------------------------------------------------------------
select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a2', 'manager');

select lives_ok($$ select public.admin_set_member_pin('a0000000-0000-4000-8000-0000000003a3', '4321') $$,
  'manager sets a staff PIN');
select lives_ok($$ select public.admin_set_member_pin('a0000000-0000-4000-8000-0000000003a2', '987654') $$,
  'manager sets own 6-digit PIN');
select throws_ok($$ select public.admin_set_member_pin('a0000000-0000-4000-8000-0000000003a1', '4321') $$,
  '23505', null, 'PINs are unique per org');
select throws_ok($$ select public.admin_set_member_pin('a0000000-0000-4000-8000-0000000003a1', '123') $$,
  '22023', null, 'PIN shorter than 4 digits is rejected');
select throws_ok($$ select public.admin_set_member_pin('a0000000-0000-4000-8000-0000000003a1', '12a4') $$,
  '22023', null, 'non-digit PIN is rejected');
select throws_ok($$ select public.admin_set_member_role('a0000000-0000-4000-8000-0000000003a3', 'owner') $$,
  '42501', null, 'a manager cannot promote to owner');
select lives_ok($$ select public.admin_set_member_role('a0000000-0000-4000-8000-0000000003a3', 'cashier') $$,
  'a manager changes a staff role');
select is((select count(*)::int from public.admin_list_members() where has_pin), 2,
  'admin_list_members reports PIN presence without the hash');

select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a1', 'owner');
select throws_ok($$ select public.admin_set_member_role('a0000000-0000-4000-8000-0000000003a1', 'manager') $$,
  '23514', null, 'the last owner cannot be demoted');

select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a3', 'cashier');
select throws_ok($$ select public.admin_set_member_pin('a0000000-0000-4000-8000-0000000003a3', '5555') $$,
  '42501', null, 'non-managers cannot set PINs');
select throws_ok($$ select * from public.admin_list_members() $$,
  '42501', null, 'non-managers cannot list members');

-- Device pairing -------------------------------------------------------------------------
select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a2', 'manager');

select throws_ok($$ select public.admin_create_device('Sneaky', 'intake', 'b0000000-0000-4000-8000-0000000005b1') $$,
  'P0002', null, 'a device cannot be bound to another org''s site');

create temp table t_device on commit drop as
  select public.admin_create_device('Wave 1', 'wave') as id;
grant select on t_device to authenticated, service_role;

create temp table t_code on commit drop as
  select * from public.admin_device_pairing_code((select id from t_device));
grant select on t_code to authenticated, service_role;

select matches((select code from t_code), '^[A-HJKMNP-TV-Z2-9]{8}$', 'pairing code is 8 unambiguous characters');
select ok((select expires_at from t_code) between now() + interval '9 minutes' and now() + interval '11 minutes',
  'pairing code expires in 10 minutes');

select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a3', 'cashier');
select throws_ok($$ select public.admin_device_pairing_code((select id from t_device)) $$,
  '42501', null, 'non-managers cannot issue pairing codes');
select throws_ok($$ select public.device_redeem_pairing((select code from t_code)) $$,
  '42501', null, 'clients cannot redeem pairing codes directly');

-- Redeem as the device-pair Edge Function (service_role).
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

select is((select device_id from public.device_redeem_pairing(lower((select code from t_code)))),
  (select id from t_device), 'redeeming the code (case-insensitive) returns the device');
select throws_ok($$ select public.device_redeem_pairing((select code from t_code)) $$,
  '22023', null, 'a pairing code is single-use');
select lives_ok($$ select public.device_bind_auth_user((select id from t_device), 'a0000000-0000-4000-8000-0000000000d1') $$,
  'the device-pair function binds the device auth user');

reset role;
select ok((select paired_at is not null and auth_user_id = 'a0000000-0000-4000-8000-0000000000d1'
           from public.device where id = (select id from t_device)), 'device is paired to its auth user');

-- Re-pairing revokes the old tablet: rebinding deletes the device user's sessions and, by
-- cascade, their refresh tokens (independent of GoTrue's own password-change behaviour).
insert into auth.sessions (id, user_id) values
  ('a0000000-0000-4000-8000-00000000e5e1', 'a0000000-0000-4000-8000-0000000000d1');
insert into auth.refresh_tokens (token, user_id, session_id, revoked) values
  ('old-tablet-refresh-token', 'a0000000-0000-4000-8000-0000000000d1', 'a0000000-0000-4000-8000-00000000e5e1', false);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.device_bind_auth_user((select id from t_device), 'a0000000-0000-4000-8000-0000000000d1');
reset role;
select is((select count(*)::int from auth.sessions where user_id = 'a0000000-0000-4000-8000-0000000000d1'), 0,
  're-pairing revokes the device user''s existing sessions');
select is((select count(*)::int from auth.refresh_tokens where token = 'old-tablet-refresh-token'), 0,
  're-pairing removes the old tablet''s refresh token');

-- Expired codes fail.
select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a2', 'manager');
create temp table t_code2 on commit drop as
  select * from public.admin_device_pairing_code((select id from t_device));
grant select on t_code2 to authenticated, service_role;
reset role;
update public.device set pairing_expires_at = now() - interval '1 second' where id = (select id from t_device);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select throws_ok($$ select public.device_redeem_pairing((select code from t_code2)) $$,
  '22023', null, 'an expired pairing code is rejected');

-- Heartbeat and operator PIN at the station ----------------------------------------------
select pg_temp.act_as('a0000000-0000-4000-8000-0000000000d1', 'station', (select id::text from t_device));
select lives_ok($$ select public.device_heartbeat() $$, 'station heartbeat');

select is(public.operator_identify('4321') -> 'member' ->> 'display_name', 'Sam Staff',
  'operator PIN identifies the member');
select is(public.operator_identify('0000') ->> 'reason', 'invalid_pin', 'wrong PIN is reported, not raised');

select public.operator_identify('0000') from generate_series(1, 3);
select is(public.operator_identify('0001') ->> 'reason', 'invalid_pin', 'fifth failure still reports invalid_pin');
select is(public.operator_identify('4321') ->> 'reason', 'locked', 'five consecutive failures lock PIN entry');

reset role;
update public.pin_throttle set locked_until = now() - interval '1 second';
select pg_temp.act_as('a0000000-0000-4000-8000-0000000000d1', 'station', (select id::text from t_device));
select is((public.operator_identify('4321') ->> 'ok')::boolean, true, 'PIN entry reopens after the lockout');

select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a3', 'cashier');
select throws_ok($$ select public.operator_identify('4321') $$, '42501', null,
  'operator_identify is station-only');

-- Manager elevation (as the elevate Edge Function) ---------------------------------------
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

select is(public.elevation_mint('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000d1',
  (select id from t_device), '4321') ->> 'reason', 'not_manager', 'a non-manager PIN does not elevate');

create temp table t_elev on commit drop as
  select public.elevation_mint('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000d1',
    (select id from t_device), '987654') as r;
grant select on t_elev to authenticated, service_role;

select is((select r -> 'manager' ->> 'display_name' from t_elev), 'Max Manager', 'manager PIN mints an elevation');
select throws_ok(
  $$ select public.elevation_mint('a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-0000000000a3',
     (select id from t_device), '987654') $$,
  '42501', null, 'elevation cannot be minted for a device the caller does not own');

select pg_temp.act_as('a0000000-0000-4000-8000-0000000000d1', 'station', (select id::text from t_device));
select is(app.require_elevation((select r ->> 'token' from t_elev)), 'a0000000-0000-4000-8000-0000000003a2'::uuid,
  'require_elevation returns the approving manager');
select is((public.elevation_status((select r ->> 'token' from t_elev)) ->> 'active')::boolean, true,
  'elevation_status reports the live elevation');
select throws_ok($$ select app.require_elevation('not-a-token') $$, '42501', null, 'an unknown token is rejected');

select pg_temp.act_as('a0000000-0000-4000-8000-0000000000a3', 'cashier');
select is(app.elevation_manager((select r ->> 'token' from t_elev)), null,
  'an elevation token only works for the caller it was minted for');

reset role;
update public.elevation_grant set expires_at = now() - interval '1 second';
select pg_temp.act_as('a0000000-0000-4000-8000-0000000000d1', 'station', (select id::text from t_device));
select is(app.elevation_manager((select r ->> 'token' from t_elev)), null, 'an expired elevation is rejected');

reset role;
select * from finish();
rollback;
