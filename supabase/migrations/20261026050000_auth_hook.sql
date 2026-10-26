-- Supabase Auth custom access token hook (docs/01-ARCHITECTURE.md §3, §5).
-- Wired in supabase/config.toml: [auth.hook.custom_access_token]
--   uri = "pg-functions://postgres/app/custom_access_token_hook"
-- Stamps `org_id` and `app_role` (plus `device_id` for station devices). The JWT `role`
-- claim is left alone, so Postgres roles stay anon/authenticated.
--   * device user  → the active device it backs; app_role = station
--   * staff user   → the org_member row marked is_default, else the oldest membership
--   * neither      → no org claims; RLS then shows nothing
-- The org switcher (public.set_default_org) flips is_default and refreshes the session.

create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb) - 'org_id' - 'app_role' - 'device_id';
  v_device public.device;
  v_member public.org_member;
begin
  select d.* into v_device
  from public.device d
  join public.org o on o.id = d.org_id and o.is_active
  where d.auth_user_id = v_user and d.is_active;

  if found then
    v_claims := v_claims || jsonb_build_object(
      'org_id', v_device.org_id, 'app_role', 'station', 'device_id', v_device.id
    );
  else
    select m.* into v_member
    from public.org_member m
    join public.org o on o.id = m.org_id and o.is_active
    where m.user_id = v_user
    order by m.is_default desc, m.created_at, m.id
    limit 1;

    if found then
      v_claims := v_claims || jsonb_build_object(
        'org_id', v_member.org_id, 'app_role', v_member.role::text
      );
    end if;
  end if;

  return jsonb_build_object('claims', v_claims);
end;
$$;

grant usage on schema app to supabase_auth_admin;
revoke all on function app.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- Org switcher: make `p_org_id` the user's default org. The caller then refreshes the
-- session so the hook re-mints the token for that org.
create or replace function public.set_default_org(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := app.user_id();
begin
  if not exists (select 1 from public.org_member where user_id = v_user and org_id = p_org_id) then
    raise exception 'set_default_org: not a member' using errcode = '42501';
  end if;
  update public.org_member set is_default = false where user_id = v_user and is_default and org_id <> p_org_id;
  update public.org_member set is_default = true where user_id = v_user and org_id = p_org_id;
end;
$$;

-- Lists the caller's orgs for the switcher (org_member RLS only shows the current org).
create or replace function public.my_orgs()
returns table (org_id uuid, slug text, name text, role public.org_member_role, is_default boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.slug, o.name, m.role, m.is_default
  from public.org_member m
  join public.org o on o.id = m.org_id and o.is_active
  where m.user_id = app.user_id()
  order by o.name
$$;

revoke all on function public.set_default_org(uuid), public.my_orgs() from public, anon;
grant execute on function public.set_default_org(uuid), public.my_orgs() to authenticated;
