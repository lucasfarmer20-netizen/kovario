-- Devices, operator PINs and manager elevation (docs/01-ARCHITECTURE.md §5).
--   * Pairing: a manager creates a device and a one-time pairing code (shown as a QR);
--     the `device-pair` Edge Function redeems it, creates/rotates the per-device
--     auth.users row and returns its session to the tablet.
--   * Operators identify at a station with a 4–6 digit PIN, unique per org.
--   * Manager PIN elevation: the `elevate` Edge Function verifies a manager PIN and
--     mints a short-lived opaque token (elevation_grant) that gated actions check.

-- Helpers ------------------------------------------------------------------------------

create or replace function app.sha256_hex(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(extensions.digest(p_value, 'sha256'), 'hex') $$;

create or replace function app.valid_pin(p_pin text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select coalesce(p_pin ~ '^[0-9]{4,6}$', false) $$;

-- The member of `p_org_id` whose PIN is `p_pin`, if any (PINs are unique per org).
create or replace function app.member_by_pin(p_org_id uuid, p_pin text)
returns public.org_member
language sql
stable
security definer
set search_path = ''
as $$
  select m.* from public.org_member m
  where m.org_id = p_org_id
    and m.pin_hash is not null
    and m.pin_hash = extensions.crypt(p_pin, m.pin_hash)
  limit 1
$$;

revoke all on function app.member_by_pin(uuid, text) from public;

-- PIN throttle -------------------------------------------------------------------------
-- Consecutive PIN failures per requesting auth user (a device user at a station, or a
-- staff user at a desk). 5 failures lock PIN entry for 5 minutes; a success resets.
create table if not exists public.pin_throttle (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  user_id uuid not null,
  failures int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

select app.track_updated_at('public.pin_throttle');
select app.enable_org_rls('public.pin_throttle', write_roles => '{}');

create or replace function app.pin_locked_until(p_org_id uuid, p_user_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select locked_until from public.pin_throttle
  where org_id = p_org_id and user_id = p_user_id and locked_until > now()
$$;

create or replace function app.pin_record(p_org_id uuid, p_user_id uuid, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update public.pin_throttle set failures = 0, locked_until = null
    where org_id = p_org_id and user_id = p_user_id;
    return;
  end if;
  insert into public.pin_throttle as t (org_id, user_id, failures)
  values (p_org_id, p_user_id, 1)
  on conflict (org_id, user_id) do update
    set failures = case when t.locked_until is not null and t.locked_until <= now() then 1
                        else t.failures + 1 end,
        locked_until = case when t.locked_until is not null and t.locked_until <= now() then null
                            else t.locked_until end;
  update public.pin_throttle
  set locked_until = now() + interval '5 minutes', failures = 0
  where org_id = p_org_id and user_id = p_user_id and failures >= 5;
end;
$$;

revoke all on function app.pin_locked_until(uuid, uuid), app.pin_record(uuid, uuid, boolean) from public;

-- Members admin ------------------------------------------------------------------------

create or replace function public.admin_list_members()
returns table (
  id uuid, user_id uuid, email text, display_name text, role public.org_member_role,
  has_pin boolean, is_default boolean, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager}');
  return query
    select m.id, m.user_id, u.email::text, m.display_name, m.role, m.pin_hash is not null,
           m.is_default, m.created_at
    from public.org_member m
    join auth.users u on u.id = m.user_id
    where m.org_id = app.org_id()
    order by m.display_name;
end;
$$;

-- Adds an existing auth user to the caller's org. Called by the `member-invite` Edge
-- Function with the inviting manager's JWT, after it has created/invited the auth user.
create or replace function public.admin_add_member(
  p_user_id uuid, p_role public.org_member_role, p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_role('{owner,manager}');
  if p_role = 'owner' and app.role() <> 'owner' then
    raise exception 'only an owner can add an owner' using errcode = '42501';
  end if;
  if exists (select 1 from public.device where auth_user_id = p_user_id) then
    raise exception 'device users cannot be members' using errcode = '22023';
  end if;
  insert into public.org_member (org_id, user_id, role, display_name, is_default)
  values (
    app.org_id(), p_user_id, p_role, trim(p_display_name),
    not exists (select 1 from public.org_member where user_id = p_user_id)
  )
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'already a member of this org' using errcode = '23505';
end;
$$;

create or replace function public.admin_set_member_role(p_member_id uuid, p_role public.org_member_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.org_member;
begin
  perform app.require_role('{owner,manager}');
  select * into v_member from public.org_member
  where id = p_member_id and org_id = app.org_id()
  for update;
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if (p_role = 'owner' or v_member.role = 'owner') and app.role() <> 'owner' then
    raise exception 'only an owner can change owner roles' using errcode = '42501';
  end if;
  if v_member.role = 'owner' and p_role <> 'owner' and not exists (
    select 1 from public.org_member
    where org_id = v_member.org_id and role = 'owner' and id <> v_member.id
  ) then
    raise exception 'an org needs at least one owner' using errcode = '23514';
  end if;
  update public.org_member set role = p_role where id = p_member_id;
end;
$$;

-- Sets (or with null clears) a member's operator PIN. PINs are 4–6 digits, unique per org.
create or replace function public.admin_set_member_pin(p_member_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_clash public.org_member;
begin
  perform app.require_role('{owner,manager}');
  if not exists (select 1 from public.org_member where id = p_member_id and org_id = v_org) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if p_pin is null then
    update public.org_member set pin_hash = null where id = p_member_id;
    return;
  end if;
  if not app.valid_pin(p_pin) then
    raise exception 'PIN must be 4–6 digits' using errcode = '22023';
  end if;
  -- Serialise PIN changes per org so the uniqueness check cannot race.
  perform pg_advisory_xact_lock(hashtext('org_member_pin:' || v_org::text));
  v_clash := app.member_by_pin(v_org, p_pin);
  if v_clash.id is not null and v_clash.id <> p_member_id then
    raise exception 'PIN already in use in this org' using errcode = '23505';
  end if;
  update public.org_member
  set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 6))
  where id = p_member_id;
end;
$$;

-- Sites admin --------------------------------------------------------------------------

create or replace function public.admin_set_default_site(p_site_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager}');
  if not exists (select 1 from public.site where id = p_site_id and org_id = app.org_id()) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  update public.site set is_default = false where org_id = app.org_id() and is_default and id <> p_site_id;
  update public.site set is_default = true where id = p_site_id;
end;
$$;

-- Devices ------------------------------------------------------------------------------

create or replace function public.admin_create_device(
  p_name text, p_station public.device_station, p_site_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_role('{owner,manager}');
  if p_site_id is not null
     and not exists (select 1 from public.site where id = p_site_id and org_id = app.org_id()) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  insert into public.device (org_id, name, station, site_id)
  values (app.org_id(), trim(p_name), p_station, p_site_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- Issues a fresh one-time pairing code (valid 10 minutes), replacing any outstanding one.
-- Re-pairing an already paired device revokes the old tablet's sessions on redeem
-- (device_bind_auth_user).
create or replace function public.admin_device_pairing_code(p_device_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Unambiguous alphabet: no 0/O, 1/I/L, U.
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := '';
  v_expires timestamptz := now() + interval '10 minutes';
begin
  perform app.require_role('{owner,manager}');
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;
  update public.device
  set token_hash = app.sha256_hex(v_code), pairing_expires_at = v_expires
  where id = p_device_id and org_id = app.org_id() and is_active;
  if not found then
    raise exception 'device not found' using errcode = 'P0002';
  end if;
  return query select v_code, v_expires;
end;
$$;

-- service_role only (device-pair Edge Function). Consumes the code.
create or replace function public.device_redeem_pairing(p_code text)
returns table (
  device_id uuid, org_id uuid, auth_user_id uuid, name text, station public.device_station
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.device;
begin
  update public.device d
  set token_hash = null, pairing_expires_at = null
  from public.org o
  where d.token_hash = app.sha256_hex(upper(trim(p_code)))
    and d.pairing_expires_at > now()
    and d.is_active
    and o.id = d.org_id and o.is_active
  returning d.* into v_device;
  if v_device.id is null then
    raise exception 'invalid or expired pairing code' using errcode = '22023';
  end if;
  return query select v_device.id, v_device.org_id, v_device.auth_user_id, v_device.name, v_device.station;
end;
$$;

-- service_role only (device-pair Edge Function). Binds the device's auth user and revokes
-- every existing session of it (and of a previously bound device user), so a re-paired —
-- e.g. lost or stolen — tablet can no longer refresh station tokens. Deleting the
-- auth.sessions rows cascades to their refresh tokens; the Edge Function signs the new
-- tablet in only after this. An already-issued access token stays valid until it expires
-- (jwt_expiry).
create or replace function public.device_bind_auth_user(p_device_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid;
begin
  select auth_user_id into v_previous from public.device where id = p_device_id for update;
  if not found then
    raise exception 'device not found' using errcode = 'P0002';
  end if;
  delete from auth.sessions where user_id in (p_user_id, v_previous);
  update public.device set auth_user_id = p_user_id, paired_at = now(), last_seen_at = now()
  where id = p_device_id;
end;
$$;

-- Called periodically by a paired station.
create or replace function public.device_heartbeat()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{station}');
  update public.device set last_seen_at = now()
  where id = app.device_id() and org_id = app.org_id();
end;
$$;

-- Operator PIN -------------------------------------------------------------------------

-- Station operator identification. Returns
--   {"ok":true,"member":{"id","display_name","role"}} or
--   {"ok":false,"reason":"invalid_pin"|"locked","locked_until":...}
-- Never raises on a wrong PIN so the failure count commits.
create or replace function public.operator_identify(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_user uuid := app.user_id();
  v_locked timestamptz;
  v_member public.org_member;
begin
  perform app.require_role('{station}');
  v_locked := app.pin_locked_until(v_org, v_user);
  if v_locked is not null then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', v_locked);
  end if;
  if app.valid_pin(p_pin) then
    v_member := app.member_by_pin(v_org, p_pin);
  end if;
  perform app.pin_record(v_org, v_user, v_member.id is not null);
  if v_member.id is null then
    return jsonb_build_object(
      'ok', false, 'reason', 'invalid_pin', 'locked_until', app.pin_locked_until(v_org, v_user)
    );
  end if;
  return jsonb_build_object('ok', true, 'member', jsonb_build_object(
    'id', v_member.id, 'display_name', v_member.display_name, 'role', v_member.role
  ));
end;
$$;

-- Manager elevation --------------------------------------------------------------------

create table if not exists public.elevation_grant (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  -- auth user (device or staff) the token was minted for; only they can use it.
  requested_by uuid not null,
  device_id uuid references public.device (id) on delete cascade,
  manager_member_id uuid not null references public.org_member (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select app.track_updated_at('public.elevation_grant');
select app.enable_org_rls('public.elevation_grant', write_roles => '{}');
revoke select on public.elevation_grant from authenticated;
grant select (id, org_id, requested_by, device_id, manager_member_id, expires_at, created_at, updated_at)
  on public.elevation_grant to authenticated;

-- service_role only (elevate Edge Function, which passes the verified caller's claims).
-- Returns {"ok":true,"token","expires_at","manager":{...}} or {"ok":false,"reason",...}.
create or replace function public.elevation_mint(
  p_org_id uuid, p_user_id uuid, p_device_id uuid, p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked timestamptz;
  v_member public.org_member;
  v_token text;
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if p_device_id is not null and not exists (
    select 1 from public.device
    where id = p_device_id and org_id = p_org_id and auth_user_id = p_user_id and is_active
  ) then
    raise exception 'device does not belong to caller' using errcode = '42501';
  end if;
  v_locked := app.pin_locked_until(p_org_id, p_user_id);
  if v_locked is not null then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', v_locked);
  end if;
  if app.valid_pin(p_pin) then
    v_member := app.member_by_pin(p_org_id, p_pin);
  end if;
  if v_member.id is null or v_member.role not in ('owner', 'manager') then
    perform app.pin_record(p_org_id, p_user_id, false);
    return jsonb_build_object(
      'ok', false,
      'reason', case when v_member.id is null then 'invalid_pin' else 'not_manager' end,
      'locked_until', app.pin_locked_until(p_org_id, p_user_id)
    );
  end if;
  perform app.pin_record(p_org_id, p_user_id, true);
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.elevation_grant (org_id, requested_by, device_id, manager_member_id, token_hash, expires_at)
  values (p_org_id, p_user_id, p_device_id, v_member.id, app.sha256_hex(v_token), v_expires);
  return jsonb_build_object(
    'ok', true, 'token', v_token, 'expires_at', v_expires,
    'manager', jsonb_build_object('id', v_member.id, 'display_name', v_member.display_name)
  );
end;
$$;

-- For gated SQL functions: the manager member who approved `p_token` for the current
-- caller, or null when the token is unknown, expired, or minted for someone else.
create or replace function app.elevation_manager(p_token text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select g.manager_member_id
  from public.elevation_grant g
  join public.org_member m on m.id = g.manager_member_id and m.role in ('owner', 'manager')
  where g.token_hash = app.sha256_hex(p_token)
    and g.org_id = app.org_id()
    and g.requested_by = app.user_id()
    and g.expires_at > now()
$$;

-- Raises unless `p_token` is a live elevation for the caller; returns the manager id.
create or replace function app.require_elevation(p_token text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_manager uuid := app.elevation_manager(p_token);
begin
  if v_manager is null then
    raise exception 'manager approval required' using errcode = '42501';
  end if;
  return v_manager;
end;
$$;

create or replace function public.elevation_status(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
       'active', true, 'expires_at', g.expires_at,
       'manager', jsonb_build_object('id', m.id, 'display_name', m.display_name))
     from public.elevation_grant g
     join public.org_member m on m.id = g.manager_member_id
     where g.token_hash = app.sha256_hex(p_token)
       and g.org_id = app.org_id()
       and g.requested_by = app.user_id()
       and g.expires_at > now()),
    jsonb_build_object('active', false)
  )
$$;

-- Grants -------------------------------------------------------------------------------

revoke all on function
  app.sha256_hex(text), app.elevation_manager(text), app.require_elevation(text)
from public;
grant execute on function
  app.sha256_hex(text), app.valid_pin(text), app.elevation_manager(text), app.require_elevation(text)
to authenticated, service_role;

revoke all on function
  public.admin_list_members(), public.admin_add_member(uuid, public.org_member_role, text),
  public.admin_set_member_role(uuid, public.org_member_role), public.admin_set_member_pin(uuid, text),
  public.admin_set_default_site(uuid), public.admin_create_device(text, public.device_station, uuid),
  public.admin_device_pairing_code(uuid), public.device_heartbeat(), public.operator_identify(text),
  public.elevation_status(text),
  public.device_redeem_pairing(text), public.device_bind_auth_user(uuid, uuid),
  public.elevation_mint(uuid, uuid, uuid, text)
from public, anon, authenticated;

grant execute on function
  public.admin_list_members(), public.admin_add_member(uuid, public.org_member_role, text),
  public.admin_set_member_role(uuid, public.org_member_role), public.admin_set_member_pin(uuid, text),
  public.admin_set_default_site(uuid), public.admin_create_device(text, public.device_station, uuid),
  public.admin_device_pairing_code(uuid), public.device_heartbeat(), public.operator_identify(text),
  public.elevation_status(text)
to authenticated;

grant execute on function
  public.device_redeem_pairing(text), public.device_bind_auth_user(uuid, uuid),
  public.elevation_mint(uuid, uuid, uuid, text)
to service_role;

-- service_role only (member-invite Edge Function): resolves an existing auth user by email
-- when an invite targets someone who already has an account.
create or replace function public.member_lookup_user(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select id from auth.users where lower(email) = lower(trim(p_email)) limit 1 $$;

revoke all on function public.member_lookup_user(text) from public, anon, authenticated;
grant execute on function public.member_lookup_user(text) to service_role;
