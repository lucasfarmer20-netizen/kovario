-- WP-18 Stripe Terminal: the terminal config RPC (owners only; reader id, location, Vault secret
-- NAMES only — a key is refused; edit keeps other config; one reader per terminal; idempotent
-- replay), tenancy of secret names (`terminal:<org id>:<name>`, WP-17's convention: no org can
-- name another org's Vault secret — refused on save AND on every resolution, whoever wrote the
-- row), the webhook signing secret and the webhook's payment lookup (service role only; the
-- browser can never read either). Table-driven like 16_register.
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
   '{"stripe_reader_id": "tmr_B1", "webhook_secret_ref": "terminal:b1800000-0000-4000-8000-00000000000b:whsec"}',
   'terminal:b1800000-0000-4000-8000-00000000000b:rk');
select vault.create_secret('not-a-real-signing-secret', 'terminal:b1800000-0000-4000-8000-00000000000b:whsec');
select vault.create_secret('not-a-real-key-b', 'terminal:b1800000-0000-4000-8000-00000000000b:rk');
select vault.create_secret('not-a-real-key-a', 'terminal:a1800000-0000-4000-8000-00000000000a:rk');

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

set local role authenticated;
select pg_temp.as_role('staff');
select pg_temp.chk('CONFIG', 'staff cannot configure a terminal',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-s0', null, 'Front', 'tmr_A1', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$),
  '42501');
select pg_temp.as_role('manager');
select pg_temp.chk('CONFIG', 'a manager cannot either (owner only, like WP-17''s Dejavoo config)',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-s0m', null, 'Front', 'tmr_A1', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$),
  '42501');

select pg_temp.as_role('owner');
insert into t_ids select 'T1', public.admin_save_stripe_terminal('wp18-action-s1', null, ' Front reader ', 'tmr_A1',
  'terminal:a1800000-0000-4000-8000-00000000000a:rk-front', 'tml_L1', 'terminal:a1800000-0000-4000-8000-00000000000a:whsec',
  'a1800000-0000-4000-8000-0000000000a5') ->> 'terminal_id';
select pg_temp.chk('CONFIG', 'an owner adds a Stripe terminal: reader, location and webhook ref in config, key by name',
  (select format('%s|%s|%s|%s|%s|%s', t.name, t.provider, t.config ->> 'stripe_reader_id', t.config ->> 'stripe_location_id',
                 t.config ->> 'webhook_secret_ref', t.secret_ref) from pg_temp.term('T1') t),
  'Front reader|stripe_terminal|tmr_A1|tml_L1|terminal:a1800000-0000-4000-8000-00000000000a:whsec|terminal:a1800000-0000-4000-8000-00000000000a:rk-front');
select pg_temp.chk('CONFIG', 'a replay (same client_action_id) returns the same terminal, adds nothing',
  format('%s|%s',
    public.admin_save_stripe_terminal('wp18-action-s1', null, ' Front reader ', 'tmr_A1',
      'terminal:a1800000-0000-4000-8000-00000000000a:rk-front', 'tml_L1', 'terminal:a1800000-0000-4000-8000-00000000000a:whsec',
      'a1800000-0000-4000-8000-0000000000a5') ->> 'terminal_id' = pg_temp.id('T1')::text,
    (select count(*) from public.payment_terminal where provider = 'stripe_terminal' and org_id = 'a1800000-0000-4000-8000-00000000000a')),
  't|1');

-- extra (ops) keys survive an edit; clearing the location / webhook ref removes them
reset role;
update public.payment_terminal set config = config || '{"label_hint": "left counter"}' where id = pg_temp.id('T1');
set local role authenticated;
select public.admin_save_stripe_terminal('wp18-action-s2', pg_temp.id('T1'), 'Front reader', 'tmr_A2',
  'terminal:a1800000-0000-4000-8000-00000000000a:rk-front2', null, null, null, false);
select pg_temp.chk('CONFIG', 'an edit replaces reader / location / webhook ref / key name / active and keeps other config',
  (select format('%s|%s|%s|%s|%s|%s', t.config ->> 'stripe_reader_id', coalesce(t.config ->> 'stripe_location_id', '-'),
                 coalesce(t.config ->> 'webhook_secret_ref', '-'), t.config ->> 'label_hint', t.secret_ref, t.is_active)
   from pg_temp.term('T1') t),
  'tmr_A2|-|-|left counter|terminal:a1800000-0000-4000-8000-00000000000a:rk-front2|f');

select pg_temp.chk('KEYS', 'a Stripe key pasted as a secret ref is refused (only Vault names are stored)',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k1', null, 'K1', 'tmr_K1', 'rk_live_abc123')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k2', null, 'K2', 'tmr_K2', 'terminal:a1800000-0000-4000-8000-00000000000a:sk_test_abc123')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k3', null, 'K3', 'tmr_K3', 'terminal:a1800000-0000-4000-8000-00000000000a:rk', null, 'whsec_abc123')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-k4', null, 'K4', 'tmr_K4', 'terminal:a1800000-0000-4000-8000-00000000000a:has spaces')$$),
  '22023:22023:22023:22023');
select pg_temp.chk('CONFIG', 'reader id, location and key name are validated',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v1', null, 'V1', 'reader-1', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v2', null, 'V2', 'tmr_V2', 'terminal:a1800000-0000-4000-8000-00000000000a:rk', 'loc-1')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v3', null, 'V3', 'tmr_V3', ' ')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-v4', null, ' ', 'tmr_V4', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$),
  '22023:22023:22023:22023');
select pg_temp.chk('CONFIG', 'one reader per terminal; names are unique in the org',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-d1', null, 'Second', 'tmr_A2', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-d2', null, 'Counter cash', 'tmr_D2', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$),
  '23505:23505');
select pg_temp.chk('TENANCY', 'another org''s terminal or site, or a non-Stripe terminal, cannot be edited / bound',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t1', 'b1800000-0000-4000-8000-000000000702', 'B', 'tmr_B9', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t2', null, 'T2', 'tmr_T2', 'terminal:a1800000-0000-4000-8000-00000000000a:rk', null, null, 'b1800000-0000-4000-8000-0000000000b5')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-t3', 'a1800000-0000-4000-8000-000000000701', 'Cash', 'tmr_T3', 'terminal:a1800000-0000-4000-8000-00000000000a:rk')$$),
  'P0002:P0002:P0002');
select pg_temp.chk('TENANCY', 'the same reader id may exist in another org (each tenant has its own Stripe account)',
  pg_temp.err($$insert into t_ids select 'T4', public.admin_save_stripe_terminal('wp18-action-t4', null, 'Mirror', 'tmr_B1',
    'terminal:a1800000-0000-4000-8000-00000000000a:rk') ->> 'terminal_id'$$), 'ok');
select pg_temp.chk('TENANCY', 'an owner cannot name another org''s secret (key or webhook), an unscoped one, or any other Vault secret',
  pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-x1', null, 'X1', 'tmr_X1', 'terminal:b1800000-0000-4000-8000-00000000000b:rk')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-x2', null, 'X2', 'tmr_X2', 'terminal:a1800000-0000-4000-8000-00000000000a:rk', null, 'terminal:b1800000-0000-4000-8000-00000000000b:whsec')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-x3', null, 'X3', 'tmr_X3', 'rk-front')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-x4', null, 'X4', 'tmr_X4', 'shippo_api_key:b1800000-0000-4000-8000-00000000000b')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-x5', null, 'X5', 'tmr_X5', 'terminal:a1800000-0000-4000-8000-00000000000a:')$$) || ':'
  || pg_temp.err($$select public.admin_save_stripe_terminal('wp18-action-x6', null, 'X6', 'tmr_X6', 'terminal:a1800000-0000-4000-8000-00000000000a-x:rk')$$),
  '22023:22023:22023:22023:22023:22023');
select pg_temp.chk('TENANCY', 'none of those was saved',
  (select count(*) from public.payment_terminal where name like 'X_'), 0);

-- Webhook secret + payment lookup (service role only) -----------------------------------------------

select pg_temp.chk('WEBHOOK', 'the browser can read neither the signing secret nor a payment by id',
  pg_temp.err($$select public.payment_terminal_webhook_secret('b1800000-0000-4000-8000-000000000702')$$) || ':'
  || pg_temp.err($$select public.payment_for_webhook(gen_random_uuid(), 'a1800000-0000-4000-8000-00000000000a')$$),
  '42501:42501');

reset role;
select pg_temp.chk('WEBHOOK', 'the service role gets the signing secret and the terminal''s org',
  (select format('%s|%s', r ->> 'org_id', r ->> 'secret')
   from (select public.payment_terminal_webhook_secret('b1800000-0000-4000-8000-000000000702') as r) x),
  'b1800000-0000-4000-8000-00000000000b|not-a-real-signing-secret');
select pg_temp.chk('WEBHOOK', 'no webhook configured, a non-Stripe terminal or an unknown one is not found',
  pg_temp.err(format('select public.payment_terminal_webhook_secret(%L)', pg_temp.id('T1'))) || ':'
  || pg_temp.err($$select public.payment_terminal_webhook_secret('a1800000-0000-4000-8000-000000000701')$$) || ':'
  || pg_temp.err($$select public.payment_terminal_webhook_secret(gen_random_uuid())$$),
  'P0002:P0002:P0002');
update public.payment_terminal set config = config || '{"webhook_secret_ref": "terminal:a1800000-0000-4000-8000-00000000000a:missing"}'
where id = pg_temp.id('T1');
select pg_temp.chk('WEBHOOK', 'a webhook ref naming no Vault secret is not found',
  pg_temp.err(format('select public.payment_terminal_webhook_secret(%L)', pg_temp.id('T1'))), 'P0002');

-- Resolution refuses a mis-scoped name however the row was written (ops, a direct insert) ----------

select pg_temp.chk('TENANCY', 'an org-scoped key name resolves to the terminal''s own key',
  (select r ->> 'secret' from (select public.payment_terminal_runtime(pg_temp.id('T4'), 'a1800000-0000-4000-8000-00000000000a') as r) x),
  'not-a-real-key-a');
update public.payment_terminal set secret_ref = 'terminal:b1800000-0000-4000-8000-00000000000b:rk' where id = pg_temp.id('T4');
select pg_temp.chk('TENANCY', 'a terminal naming another org''s key never resolves it (runtime)',
  pg_temp.err(format('select public.payment_terminal_runtime(%L, %L)', pg_temp.id('T4'), 'a1800000-0000-4000-8000-00000000000a')), '42501');
update public.payment_terminal set secret_ref = 'wp18-unscoped' where id = pg_temp.id('T4');
select pg_temp.chk('TENANCY', 'an unscoped name is refused too',
  pg_temp.err(format('select public.payment_terminal_runtime(%L, %L)', pg_temp.id('T4'), 'a1800000-0000-4000-8000-00000000000a')), '42501');
update public.payment_terminal
set secret_ref = 'terminal:a1800000-0000-4000-8000-00000000000a:rk',
    config = config || '{"webhook_secret_ref": "terminal:b1800000-0000-4000-8000-00000000000b:whsec"}'
where id = pg_temp.id('T4');
select pg_temp.chk('TENANCY', 'a webhook ref naming another org''s signing secret never resolves it',
  pg_temp.err(format('select public.payment_terminal_webhook_secret(%L)', pg_temp.id('T4'))), '42501');
insert into public.payment_terminal (id, org_id, name, provider, config, secret_ref) values
  ('a1800000-0000-4000-8000-000000000703', 'a1800000-0000-4000-8000-00000000000a', 'Dejavoo 1', 'dejavoo_spin',
   '{"tpn": "T1"}', 'terminal:b1800000-0000-4000-8000-00000000000b:rk');
select pg_temp.chk('TENANCY', 'the rule holds for every provider: a Dejavoo row naming another org''s secret is refused',
  pg_temp.err($$select public.payment_terminal_runtime('a1800000-0000-4000-8000-000000000703', 'a1800000-0000-4000-8000-00000000000a')$$),
  '42501');
update public.payment_terminal set is_active = false where id = pg_temp.id('T4');
select pg_temp.chk('TENANCY', 'an inactive terminal still resolves (WP-17: it serves its old payments), scoped as ever',
  (select r ->> 'secret' from (select public.payment_terminal_runtime(pg_temp.id('T4'), 'a1800000-0000-4000-8000-00000000000a') as r) x),
  'not-a-real-key-a');
select pg_temp.chk('WEBHOOK', 'no table stores a secret',
  (select count(*) from public.payment_terminal where config::text like '%not-a-real%' or secret_ref like '%not-a-real%'), 0);

-- Assertions -----------------------------------------------------------------------------------------

select is(got, want, format('%s — %s', inv, label)) from t_check order by seq;

select * from finish();
rollback;
