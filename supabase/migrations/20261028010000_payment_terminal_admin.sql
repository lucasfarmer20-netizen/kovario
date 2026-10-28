-- WP-17: Dejavoo SPIn terminal config (docs/05-PAYMENTS.md §4). An owner adds or edits a
-- dejavoo_spin payment_terminal: endpoint host, TPN, optional register id, SPInProxyTimeout and
-- the NAME of the Vault secret that holds the terminal's Authkey (never the key — ops stores it,
-- docs/ops/dejavoo-terminal-provisioning.md). payment_terminal has no client write path
-- (write_roles '{}'); this function is the only one.
--   * Owner only: the endpoint decides where the Authkey is sent.
--   * The endpoint is `https://<host>[:port]` (plain http only on loopback, for the fake SPIn
--     server / local dev); the UI normalises a bare host with packages/payments
--     normalizeSpinEndpoint.
--   * secret_ref must be `terminal:<this org id>:<name>`: payment_terminal_runtime reads Vault by
--     name, so an org may only reference its own secrets — never another tenant's Authkey.
--   * register_id is stored only when set (an empty RegisterId trips SPIn 2003).
--   * Other config keys already on the row are kept.

create or replace function public.admin_save_payment_terminal(
  p_client_action_id text, p_terminal_id uuid, p_name text, p_endpoint_url text, p_tpn text,
  p_secret_ref text, p_register_id text default null, p_timeout_secs integer default null,
  p_site_id uuid default null, p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_t public.payment_terminal;
  v_id uuid;
  v_endpoint text := lower(btrim(coalesce(p_endpoint_url, '')));
  v_tpn text := btrim(coalesce(p_tpn, ''));
  v_register text := nullif(btrim(coalesce(p_register_id, '')), '');
  v_secret text := btrim(coalesce(p_secret_ref, ''));
  v_config jsonb;
  v_result jsonb;
begin
  perform app.require_role('{owner}');
  v_action := app.action_begin(p_client_action_id, 'payment_terminal.save', jsonb_build_object(
    'terminal_id', p_terminal_id, 'name', p_name, 'endpoint_url', p_endpoint_url, 'tpn', p_tpn,
    'register_id', p_register_id, 'timeout_secs', p_timeout_secs, 'secret_ref', p_secret_ref,
    'site_id', p_site_id, 'is_active', p_is_active));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  if length(btrim(coalesce(p_name, ''))) = 0 or length(btrim(p_name)) > 80 then
    raise exception 'terminal needs a name (at most 80 characters)' using errcode = '22023';
  end if;
  if v_endpoint !~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$'
     and v_endpoint !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$' then
    raise exception 'endpoint must be https://<host> (e.g. https://spinpos.net), got %', p_endpoint_url
      using errcode = '22023';
  end if;
  if v_tpn !~ '^[A-Za-z0-9]{4,32}$' then
    raise exception 'TPN must be 4–32 letters or digits' using errcode = '22023';
  end if;
  if v_register is not null and v_register !~ '^[A-Za-z0-9_-]{1,40}$' then
    raise exception 'register id must be letters, digits, - or _ (at most 40), or empty' using errcode = '22023';
  end if;
  if p_timeout_secs is not null and p_timeout_secs not between 30 and 180 then
    raise exception 'timeout must be 30–180 seconds' using errcode = '22023';
  end if;
  if v_secret !~ ('^terminal:' || v_org::text || ':[a-z0-9][a-z0-9_-]{0,59}$') then
    raise exception 'secret ref must be terminal:<your org id>:<name> (lowercase letters, digits, - or _)'
      using errcode = '22023';
  end if;
  if p_site_id is not null and not exists (select 1 from public.site where id = p_site_id and org_id = v_org) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.payment_terminal
             where org_id = v_org and name = btrim(p_name) and id is distinct from p_terminal_id) then
    raise exception 'a terminal named % already exists', btrim(p_name) using errcode = '23505';
  end if;

  v_config := jsonb_strip_nulls(jsonb_build_object(
    'endpoint_url', v_endpoint, 'tpn', v_tpn, 'register_id', v_register, 'timeout_secs', p_timeout_secs));

  if p_terminal_id is null then
    insert into public.payment_terminal (org_id, name, site_id, provider, config, secret_ref, is_active)
    values (v_org, btrim(p_name), p_site_id, 'dejavoo_spin', v_config, v_secret, coalesce(p_is_active, true))
    returning id into v_id;
  else
    select * into v_t from public.payment_terminal where id = p_terminal_id and org_id = v_org for update;
    if not found then
      raise exception 'payment terminal not found' using errcode = 'P0002';
    end if;
    if v_t.provider <> 'dejavoo_spin' then
      raise exception 'terminal % is a % terminal, not Dejavoo SPIn', v_t.name, v_t.provider using errcode = '22023';
    end if;
    update public.payment_terminal
    set name = btrim(p_name), site_id = p_site_id,
        config = (v_t.config - array['endpoint_url', 'tpn', 'register_id', 'timeout_secs']) || v_config,
        secret_ref = v_secret, is_active = coalesce(p_is_active, true)
    where id = v_t.id
    returning id into v_id;
  end if;

  v_result := jsonb_build_object('terminal_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

revoke all on function
  public.admin_save_payment_terminal(text, uuid, text, text, text, text, text, integer, uuid, boolean)
from public, anon, authenticated;
grant execute on function
  public.admin_save_payment_terminal(text, uuid, text, text, text, text, text, integer, uuid, boolean)
to authenticated;
