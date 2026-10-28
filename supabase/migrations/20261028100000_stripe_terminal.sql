-- WP-18 Stripe Terminal (docs/05-PAYMENTS.md §5):
--   * admin_save_stripe_terminal — owners add or edit a stripe_terminal payment_terminal: reader
--     id (config.stripe_reader_id), location (config.stripe_location_id), the Vault secret NAME of
--     the tenant's restricted key (secret_ref, DECISION-05) and of the webhook signing secret
--     (config.webhook_secret_ref). Keys themselves never enter a table: a value that looks like a
--     Stripe key is refused. Owner only, like WP-17's admin_save_payment_terminal (the secret
--     name decides whose key is used);
--   * tenancy of secret names: Vault is global and owners now write secret names, so every
--     terminal secret name is scoped to its org — `terminal:<org id>:<name>`, WP-17's convention.
--     Checked on save AND on every resolution (payment_terminal_runtime for any provider,
--     payment_terminal_webhook_secret), so a mis-scoped name written directly is refused too;
--   * payment_terminal_webhook_secret — service role only: the signing secret the
--     /api/payments/stripe/webhook/<terminal id> route verifies an event with;
--   * payment_for_webhook — service role only: the payment a verified event names, so the route
--     reconciles it when (and only when) it is `indeterminate`.

-- Is `p_name` a terminal secret name of org `p_org` — `terminal:<org id>:<name>`, name non-empty?
create or replace function app.terminal_secret_scoped(p_org uuid, p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name is not null and p_org is not null
     and left(p_name, length('terminal:' || p_org::text || ':')) = 'terminal:' || p_org::text || ':'
     and length(p_name) > length('terminal:' || p_org::text || ':')
$$;

-- A terminal Vault secret name for org `p_org`, as WP-17 saves them: `terminal:<org id>:<name>`,
-- name = lowercase letters, digits, - or _ (never a key, never another org's secret).
create or replace function app.check_secret_name(p_label text, p_name text, p_org uuid)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name is null then
    return null;
  end if;
  if p_name ~* '(^|:)((sk|rk|pk)_(test|live)_|whsec_)' then
    raise exception '% must be the NAME of a Vault secret, not the key itself', p_label using errcode = '22023';
  end if;
  if p_name !~ ('^terminal:' || p_org::text || ':[a-z0-9][a-z0-9_-]{0,59}$') then
    raise exception '% must be terminal:<your org id>:<name> (lowercase letters, digits, - or _)', p_label
      using errcode = '22023';
  end if;
  return p_name;
end;
$$;

create or replace function public.admin_save_stripe_terminal(
  p_client_action_id text,
  p_terminal_id uuid,
  p_name text,
  p_reader_id text,
  p_secret_ref text,
  p_location_id text default null,
  p_webhook_secret_ref text default null,
  p_site_id uuid default null,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_name text := btrim(coalesce(p_name, ''));
  v_reader text := nullif(btrim(p_reader_id), '');
  v_location text := nullif(btrim(p_location_id), '');
  v_secret_ref text;
  v_webhook_ref text;
  v_id uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner}');
  v_action := app.action_begin(p_client_action_id, 'payment_terminal.save_stripe', jsonb_build_object(
    'terminal_id', p_terminal_id, 'name', p_name, 'reader_id', p_reader_id, 'location_id', p_location_id,
    'secret_ref', p_secret_ref, 'webhook_secret_ref', p_webhook_secret_ref, 'site_id', p_site_id,
    'is_active', p_is_active));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_secret_ref := app.check_secret_name('secret ref', nullif(btrim(p_secret_ref), ''), v_org);
  v_webhook_ref := app.check_secret_name('webhook secret ref', nullif(btrim(p_webhook_secret_ref), ''), v_org);
  if length(v_name) = 0 or length(v_name) > 80 then
    raise exception 'terminal needs a name (at most 80 characters)' using errcode = '22023';
  end if;
  if v_reader is null or v_reader !~ '^tmr_[A-Za-z0-9]+$' then
    raise exception 'reader id must be a Stripe reader id (tmr_…)' using errcode = '22023';
  end if;
  if v_location is not null and v_location !~ '^tml_[A-Za-z0-9]+$' then
    raise exception 'location must be a Stripe location id (tml_…)' using errcode = '22023';
  end if;
  if v_secret_ref is null then
    raise exception 'a Stripe terminal needs the Vault secret name of its restricted key' using errcode = '22023';
  end if;
  if p_site_id is not null and not exists (select 1 from public.site where id = p_site_id and org_id = v_org) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.payment_terminal
             where org_id = v_org and name = v_name and id is distinct from p_terminal_id) then
    raise exception 'a terminal named % already exists', v_name using errcode = '23505';
  end if;
  if exists (select 1 from public.payment_terminal
             where org_id = v_org and provider = 'stripe_terminal' and config ->> 'stripe_reader_id' = v_reader
               and id is distinct from p_terminal_id) then
    raise exception 'reader % already belongs to another terminal', v_reader using errcode = '23505';
  end if;

  if p_terminal_id is null then
    insert into public.payment_terminal (org_id, name, site_id, provider, config, secret_ref, is_active)
    values (v_org, v_name, p_site_id, 'stripe_terminal',
            jsonb_strip_nulls(jsonb_build_object('stripe_reader_id', v_reader, 'stripe_location_id', v_location,
                                                 'webhook_secret_ref', v_webhook_ref)),
            v_secret_ref, coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.payment_terminal
    set name = v_name, site_id = p_site_id, secret_ref = v_secret_ref, is_active = coalesce(p_is_active, true),
        config = (config - 'stripe_reader_id' - 'stripe_location_id' - 'webhook_secret_ref')
                 || jsonb_strip_nulls(jsonb_build_object('stripe_reader_id', v_reader,
                                                         'stripe_location_id', v_location,
                                                         'webhook_secret_ref', v_webhook_ref))
    where id = p_terminal_id and org_id = v_org and provider = 'stripe_terminal'
    returning id into v_id;
    if v_id is null then
      raise exception 'Stripe terminal not found' using errcode = 'P0002';
    end if;
  end if;

  v_result := jsonb_build_object('terminal_id', v_id);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- The webhook route's signing secret for a Stripe terminal (an inactive terminal still
-- reconciles its old payments: WP-17's payment_terminal_runtime resolves inactive terminals).
-- Not found = unknown terminal, not Stripe, or not configured; a name outside the terminal's org
-- is refused.
create or replace function public.payment_terminal_webhook_secret(p_terminal_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t public.payment_terminal;
  v_secret text;
begin
  select * into v_t from public.payment_terminal where id = p_terminal_id and provider = 'stripe_terminal';
  if not found or v_t.config ->> 'webhook_secret_ref' is null then
    raise exception 'no Stripe webhook is configured for this terminal' using errcode = 'P0002';
  end if;
  if not app.terminal_secret_scoped(v_t.org_id, v_t.config ->> 'webhook_secret_ref') then
    raise exception 'terminal %''s webhook secret ref is not scoped to its organisation', v_t.name
      using errcode = '42501';
  end if;
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s
  where s.name = v_t.config ->> 'webhook_secret_ref' limit 1;
  if v_secret is null then
    raise exception 'no Stripe webhook is configured for this terminal' using errcode = 'P0002';
  end if;
  return jsonb_build_object('terminal_id', v_t.id, 'org_id', v_t.org_id, 'secret', v_secret);
end;
$$;

-- WP-17's TerminalConfig resolver (20261028010100: inactive terminals still serve their
-- payments), now also refusing a terminal whose secret_ref is not scoped to its org — any
-- provider: a name written outside admin_save_* (ops, a direct insert) must never resolve
-- another org's key either. Otherwise unchanged; service role only (grants kept by create or
-- replace).
create or replace function public.payment_terminal_runtime(p_terminal_id uuid, p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t public.payment_terminal;
  v_secret text := '';
begin
  select * into v_t from public.payment_terminal
  where id = p_terminal_id and org_id = p_org_id;
  if not found then
    raise exception 'payment terminal not found' using errcode = 'P0002';
  end if;
  if v_t.secret_ref is not null and not app.terminal_secret_scoped(v_t.org_id, v_t.secret_ref) then
    raise exception 'terminal %''s secret ref is not scoped to its organisation (terminal:<org id>:<name>)',
      v_t.name using errcode = '42501';
  end if;
  if v_t.secret_ref is not null then
    select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = v_t.secret_ref limit 1;
    if v_secret is null then
      raise exception 'terminal % has no Vault secret named %', v_t.name, v_t.secret_ref using errcode = 'P0002';
    end if;
  end if;
  return jsonb_build_object('id', v_t.id, 'name', v_t.name, 'provider', v_t.provider,
                            'config', v_t.config, 'secret', v_secret, 'is_active', v_t.is_active);
end;
$$;

-- The payment a verified webhook event names, within the terminal's org.
create or replace function public.payment_for_webhook(p_payment_id uuid, p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pay public.payment;
begin
  select * into v_pay from public.payment where id = p_payment_id and org_id = p_org_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  return app.payment_json(v_pay) || jsonb_build_object('org_id', v_pay.org_id,
    'order_id', v_pay.register_order_id, 'provider_txn', v_pay.provider_txn, 'reason', v_pay.reason);
end;
$$;

revoke all on function
  app.terminal_secret_scoped(uuid, text),
  app.check_secret_name(text, text, uuid),
  public.admin_save_stripe_terminal(text, uuid, text, text, text, text, text, uuid, boolean),
  public.payment_terminal_webhook_secret(uuid),
  public.payment_for_webhook(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.admin_save_stripe_terminal(text, uuid, text, text, text, text, text, uuid, boolean)
to authenticated;

grant execute on function
  public.payment_terminal_webhook_secret(uuid),
  public.payment_for_webhook(uuid, uuid)
to service_role;
