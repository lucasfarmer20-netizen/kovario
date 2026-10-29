-- v1.1 asset tag capacity (#85; docs/02-DOMAIN-MODEL.md asset_tag, §12, §13).
-- * New orgs start at scanner.tag_digits = 4 (9999 tags). Existing orgs keep their settings:
--   nothing here rewrites an org row or a tag.
-- * admin_update_org lets a manager raise tag_digits (never lower it) and re-pads every
--   asset_tag code and qr to the new width in the same transaction.
-- * Every scan lookup (`qr = raw or code = app.normalize_tag_code(raw)` in reconcile, freezer
--   and release) resolves at the org's width and reads the org's FL:TAG text at any padding,
--   so a label printed as FL:TAG:<slug>:042 before a raise to 4 digits still finds tag 0042.
-- Normalisation itself is generated from packages/rules qr.ts (…_tag_normalization_width.sql).

-- New orgs -------------------------------------------------------------------------------
alter table public.org alter column settings set default '{
  "hold_hours": 48,
  "estimated_pickup_days": 3,
  "wave_target_lb": 4000,
  "wave_tolerance_lb": 250,
  "receipt_footer": "",
  "status_page_enabled": true,
  "tax": { "mode": "exclusive", "rate": 0.06, "cap_amount": 30.00 },
  "shipping": { "carrier_allowlist": "*", "buy_window_days": 1 },
  "scanner": { "tag_digits": 4 }
}'::jsonb;

-- The org's tag width (validated 3–6 by app.org_settings_problem).
create or replace function app.org_tag_digits(p_org_id uuid) returns integer
language sql stable set search_path='' as $$
  select coalesce((settings #>> '{scanner,tag_digits}')::int, 3) from public.org where id = p_org_id
$$;

-- Lookups --------------------------------------------------------------------------------
-- The canonical code now depends on the org, so the old 3-digit check gives way to the
-- trigger below, and the one-argument form every scan path calls becomes org-aware.
alter table public.asset_tag drop constraint if exists asset_tag_canonical_code;

create or replace function app.normalize_tag_code(raw text) returns text
language sql stable set search_path='' as $$
  select app.scan_tag_code(raw, o.slug, app.org_tag_digits(o.id))
  from public.org o where o.id = app.org_id()
$$;

-- Writes ---------------------------------------------------------------------------------
-- A tag's code is canonical at its org's width: 0042 in a 4-digit org, never 042.
-- Security definer: it only reads the org's width, and must hold for every writer
-- (admin functions, the service role) without granting them the app.* helpers.
-- The width is read under FOR KEY SHARE on the org row, which conflicts only with the raise's
-- FOR UPDATE (admin_update_org): a write racing a raise either waits for it and validates
-- against the new width, or commits first and is re-padded by it. Lock order: org, then tags.
create or replace function app.asset_tag_canonical() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  v_digits integer;
begin
  select coalesce((settings #>> '{scanner,tag_digits}')::int, 3) into v_digits
  from public.org where id = new.org_id for key share;
  if new.code is distinct from app.normalize_tag_code(new.code, v_digits) then
    raise exception 'Tag code % does not fit this org''s % digit tags', new.code, v_digits
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists asset_tag_canonical on public.asset_tag;
create trigger asset_tag_canonical before insert or update of code, org_id on public.asset_tag
  for each row execute function app.asset_tag_canonical();

-- Tag pool admin: one range may now be a whole 4-digit pool (app.max_tag_range(), from
-- qr.ts MAX_TAG_RANGE), not 1000 tags. Otherwise unchanged from the reconcile migration.
create or replace function public.admin_asset_tags(p_client_action_id text,p_tags jsonb default null,p_tag_id uuid default null,p_retire_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; t public.asset_tag;
begin
 perform app.require_role('{owner,manager}');
 a:=app.action_begin(p_client_action_id,'asset_tags.manage','{}');
 if a->>'status'='done' then return a->'result'; end if;
 if p_tags is not null then
  if jsonb_typeof(p_tags)<>'array' or jsonb_array_length(p_tags)>app.max_tag_range() then raise exception 'Invalid range'; end if;
  insert into public.asset_tag(org_id,code,qr) select app.org_id(),x->>'code',x->>'qr' from jsonb_array_elements(p_tags) x on conflict(org_id,code) do nothing;
 else
  select * into t from public.asset_tag where id=p_tag_id and org_id=app.org_id() for update;
  if t.id is null then raise exception 'Unknown tag'; end if;
  if t.state='in_use' then raise exception 'Tag in use'; end if;
  update public.asset_tag set state=case when p_retire_reason is null then 'available'::public.asset_tag_state else 'retired'::public.asset_tag_state end,retired_reason=p_retire_reason where id=t.id;
 end if;
 perform app.action_complete(p_client_action_id,'{}'); return '{}'::jsonb;
end $$;

revoke all on function app.org_tag_digits(uuid), app.asset_tag_canonical() from public;
grant execute on function app.org_tag_digits(uuid) to service_role;

-- Org settings: tag_digits is raise-only --------------------------------------------------
-- Lock order: the org row (FOR UPDATE), then its tags. Tag writes key-share the org row first
-- (app.asset_tag_canonical), so they serialise with a raise; scan paths never lock the org row.
create or replace function public.admin_update_org(
  p_client_action_id text, p_name text, p_timezone text, p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_problem text;
  v_result jsonb;
  v_org public.org;
  v_from integer;
  v_to integer;
  v_repadded integer := 0;
begin
  perform app.require_role('{owner,manager}');
  v_action := app.action_begin(p_client_action_id, 'org.update',
    jsonb_build_object('name', p_name, 'timezone', p_timezone, 'settings', p_settings));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Enter the business name (up to 120 characters).' using errcode = '22023';
  end if;
  if not app.valid_timezone(p_timezone) then
    raise exception 'Unknown time zone %.', p_timezone using errcode = '22023';
  end if;
  v_problem := app.org_settings_problem(p_settings);
  if v_problem is not null then
    raise exception 'Invalid settings: %', v_problem using errcode = '22023';
  end if;

  select * into v_org from public.org where id = app.org_id() for update;
  v_from := app.org_tag_digits(v_org.id);
  v_to := (p_settings #>> '{scanner,tag_digits}')::int;
  if v_to < v_from then
    raise exception 'Asset tag digits can only be raised (now %, asked for %).', v_from, v_to
      using errcode = '22023';
  end if;

  update public.org
  set name = trim(p_name), timezone = p_timezone, settings = p_settings
  where id = v_org.id;

  if v_to > v_from then
    update public.asset_tag
    set code = app.normalize_tag_code(code, v_to),
        qr = app.qr_tag(v_org.slug, app.normalize_tag_code(code, v_to))
    where org_id = v_org.id and code <> app.normalize_tag_code(code, v_to);
    get diagnostics v_repadded = row_count;
  end if;

  v_result := jsonb_build_object('org_id', v_org.id, 'tag_digits', v_to,
    'repadded_tags', v_repadded);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;
