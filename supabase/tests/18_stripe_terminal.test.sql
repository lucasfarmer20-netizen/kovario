-- WP-18 Stripe Terminal: the terminal config RPC (owners / managers; reader id, location, Vault
-- secret NAMES only — a key is refused; edit keeps other config; one reader per terminal; tenancy;
-- idempotent replay), the webhook signing secret and the webhook's payment lookup (service role
-- only; the browser can never read either). Table-driven like 16_register.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a1800000-0000-4000-8000-00000000000a', 'stripe-a', 'Stripe A', 'UTC'),
  ('b1800000-0000-4000-8000-00000000000b', 'stripe-b', 'Stripe B', 'UTC');
insert into public.site (id, org_id, name, is_default) values
  ('a1800000-0000-4000-8000-0000000000a5', 'a1800000-0000-4000-8000-00000000000a', 'Dock', true),
  ('b1800000-0000-4000-8000-0000000000b5', 'b1800000-0000-4000-8000-00000000000b', 'Other dock', true);
insert into public.payment_terminal (id, org_id, name, provider, config, secret_ref) values
  ('a1800000-0000-4000-8000-000000000701', 'a1800000-0000-4000-8000-00000000000a', 'Counter cash', 'manual', '{}', null),
  ('b1800000-0000-4000-8000-000000000702', 'b1800000-0000-4000-8000-00000000000b', 'B reader', 'stripe_terminal',
   '{"stripe_reader_id": "tmr_B1", "webhook_secret_ref": "wp18-test-whsec-b"}', 'wp18-test-rk-b');
select vault.create_secret('not-a-real-signing-secret', 'wp18-test-whsec-b');

create temp table t_ids (k text primary key, v text) on commit drop;
create temp table t_check (seq serial, inv text, label text, got text, want text) on commit drop;
grant all on t_ids, t_check to authenticated;
grant usage on sequence t_check_seq_seq to authenticated;

create function pg_temp.as_role(p_role text, p_org text default 'a1800000-0000-4000-8000-00000000000a') returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a1800000-0000-4000-8000-0000000000f1', 'role', 'authenticated', 'org_id', p_org,
    'app_role', p_role)::text, true);
$$;
create function pg_temp.id(p_k text) returns uuid language sql as $$
  select v::uuid from t_ids where k = p_k;
$$;
create function pg_temp.chk(p_inv text, p_label text, p_got anycompatible, p_want anycompatible) returns void
language sql as $$
  insert into t_check (inv, label, got, want) values (p_inv, p_label, p_got::text, p_want::text);
$$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;
create function pg_temp.term(p_k text) returns public.payment_terminal language sql security definer as $$
  select * from public.payment_terminal where id = pg_temp.id(p_k);
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- Config RPC -----------------------------------------------------------------------------------------

select pg_temp.as_role('staff');
set local role authenticated;
select pg_temp.chk('CONFIG', 'staff cannot configure a terminal',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-s0', null, 'Front', 'tmr_A1', 'wp18-rk-a')$$), '42501');

select pg_temp.as_role('manager');
insert into t_ids select 'T1', public.admin_save_stripe_terminal('wp18-action-s1', null, ' Front reader ', 'tmr_A1',
  'wp18-rk-a', 'tml_L1', 'wp18-whsec-a', 'a1800000-0000-4000-8000-0000000000a5') ->> 'terminal_id';
select pg_temp.chk('CONFIG', 'a manager adds a Stripe terminal: reader, location and webhook ref in config, key by name',
  (select format('%s|%s|%s|%s|%s|%s', t.name, t.provider, t.config ->> 'stripe_reader_id', t.config ->> 'stripe_location_id',
                 t.config ->> 'webhook_secret_ref', t.secret_ref) from pg_temp.term('T1') t),
  'Front reader|stripe_terminal|tmr_A1|tml_L1|wp18-whsec-a|wp18-rk-a');
select pg_temp.chk('CONFIG', 'a replay (same client_action_id) returns the same terminal, adds nothing',
  format('%s|%s',
    public.admin_save_stripe_terminal('wp18-action-s1', null, ' Front reader ', 'tmr_A1', 'wp18-rk-a', 'tml_L1', 'wp18-whsec-a',
      'a1800000-0000-4000-8000-0000000000a5') ->> 'terminal_id' = pg_temp.id('T1')::text,
    (select count(*) from public.payment_terminal where provider = 'stripe_terminal' and org_id = 'a1800000-0000-4000-8000-00000000000a')),
  't|1');

-- the browser-visible config holds names only; extra (ops) keys survive an edit; clearing the location removes it
reset role;
update public.payment_terminal set config = config || '{"label_hint": "left counter"}' where id = pg_temp.id('T1');
set local role authenticated;
select public.admin_save_stripe_terminal('wp18-action-s2', pg_temp.id('T1'), 'Front reader', 'tmr_A2', 'wp18-rk-a2', null, null, null, false);
select pg_temp.chk('CONFIG', 'an edit replaces reader / location / webhook ref / key name / active and keeps other config',
  (select format('%s|%s|%s|%s|%s|%s', t.config ->> 'stripe_reader_id', coalesce(t.config ->> 'stripe_location_id', '-'),
                 coalesce(t.config ->> 'webhook_secret_ref', '-'), t.config ->> 'label_hint', t.secret_ref, t.is_active)
   from pg_temp.term('T1') t),
  'tmr_A2|-|-|left counter|wp18-rk-a2|f');

select pg_temp.chk('KEYS', 'a Stripe key pasted as the secret ref is refused (only Vault names are stored)',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k1', null, 'K1', 'tmr_K1', 'rk_live_abc123')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k2', null, 'K2', 'tmr_K2', 'sk_test_abc123')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k3', null, 'K3', 'tmr_K3', 'wp18-rk', null, 'whsec_abc123')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k4', null, 'K4', 'tmr_K4', 'has spaces')$$),
  '22023:22023:22023:22023');
select pg_temp.chk('CONFIG', 'reader id, location and key name are validated',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v1', null, 'V1', 'reader-1', 'wp18-rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v2', null, 'V2', 'tmr_V2', 'wp18-rk', 'loc-1')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v3', null, 'V3', 'tmr_V3', ' ')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v4', null, ' ', 'tmr_V4', 'wp18-rk')$$),
  '22023:22023:22023:22023');
select pg_temp.chk('CONFIG', 'one reader per terminal; names are unique in the org',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-d1', null, 'Second', 'tmr_A2', 'wp18-rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-d2', null, 'Counter cash', 'tmr_D2', 'wp18-rk')$$),
  '23505:23505');
select pg_temp.chk('TENANCY', 'another org''s terminal or site, or a non-Stripe terminal, cannot be edited / bound',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t1', 'b1800000-0000-4000-8000-000000000702', 'B', 'tmr_B9', 'wp18-rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t2', null, 'T2', 'tmr_T2', 'wp18-rk', null, null, 'b1800000-0000-4000-8000-0000000000b5')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t3', 'a1800000-0000-4000-8000-000000000701', 'Cash', 'tmr_T3', 'wp18-rk')$$),
  'P0002:P0002:P0002');
select pg_temp.chk('TENANCY', 'the same reader id may exist in another org (each tenant has its own Stripe account)',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t4', null, 'Mirror', 'tmr_B1', 'wp18-rk')$$), 'ok');

-- Webhook secret + payment lookup (service role only) -----------------------------------------------

select pg_temp.chk('WEBHOOK', 'the browser can read neither the signing secret nor a payment by id across orgs',
  pg_temp.err($$select public.payment_terminal_webhook_secret('b1800000-0000-4000-8000-000000000702')$$) || ':'
  || pg_temp.err($$select public.payment_for_webhook(gen_random_uuid(), 'a1800000-0000-4000-8000-00000000000a')$$),
  '42501:42501');

reset role;
select pg_temp.chk('WEBHOOK', 'the service role gets the signing secret and the terminal''s org',
  (select format('%s|%s', r ->> 'org_id', r ->> 'secret')
   from (select public.payment_terminal_webhook_secret('b1800000-0000-4000-8000-000000000702') as r) x),
  'b1800000-0000-4000-8000-00000000000b|not-a-real-signing-secret');
select pg_temp.chk('WEBHOOK', 'no webhook configured, a missing Vault secret, or a non-Stripe terminal is not found',
  pg_temp.err(format('select public.payment_terminal_webhook_secret(%L)', pg_temp.id('T1'))) || ':'
  || pg_temp.err($$select public.payment_terminal_webhook_secret('a1800000-0000-4000-8000-000000000701')$$) || ':'
  || pg_temp.err($$select public.payment_terminal_webhook_secret(gen_random_uuid())$$),
  'P0002:P0002:P0002');
update public.payment_terminal set config = config || '{"webhook_secret_ref": "wp18-test-missing"}' where id = pg_temp.id('T1');
select pg_temp.chk('WEBHOOK', 'a webhook ref naming no Vault secret is not found',
  pg_temp.err(format('select public.payment_terminal_webhook_secret(%L)', pg_temp.id('T1'))), 'P0002');
select pg_temp.chk('WEBHOOK', 'no table stores a secret',
  (select count(*) from public.payment_terminal where config::text like '%not-a-real%' or secret_ref like '%not-a-real%'), 0);

-- Assertions -----------------------------------------------------------------------------------------

select is(got, want, format('%s — %s', inv, label)) from t_check order by seq;

select * from finish();
rollback;
