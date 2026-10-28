-- WP-17: Dejavoo SPIn terminal config (docs/05 §4) via admin_save_payment_terminal — owner only;
-- endpoint host / TPN / register id / timeout validated; RegisterId stored only when set;
-- secret_ref scoped to the caller's org (no reading another tenant's Vault secret); edits keep
-- other config keys; idempotent per client_action_id; the config reaches
-- payment_terminal_runtime. Table-driven like 16_register.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a1700000-0000-4000-8000-00000000000a', 'terminals-a', 'Terminals A', 'UTC'),
  ('b1700000-0000-4000-8000-00000000000b', 'terminals-b', 'Terminals B', 'UTC');
insert into public.site (id, org_id, name, is_default) values
  ('a1700000-0000-4000-8000-0000000000a5', 'a1700000-0000-4000-8000-00000000000a', 'Dock', true),
  ('b1700000-0000-4000-8000-0000000000b5', 'b1700000-0000-4000-8000-00000000000b', 'Other dock', true);
insert into public.payment_terminal (id, org_id, name, provider, config) values
  ('a1700000-0000-4000-8000-000000000701', 'a1700000-0000-4000-8000-00000000000a', 'Counter cash', 'manual', '{}');
select vault.create_secret('not-a-real-authkey', 'terminal:a1700000-0000-4000-8000-00000000000a:front');
select vault.create_secret('other-tenant-authkey', 'terminal:b1700000-0000-4000-8000-00000000000b:front');

create temp table t_ids (k text primary key, v text) on commit drop;
create temp table t_check (seq serial, inv text, label text, got text, want text) on commit drop;
grant all on t_ids, t_check to authenticated;
grant usage on sequence t_check_seq_seq to authenticated;

create function pg_temp.as_role(p_role text, p_org text default 'a1700000-0000-4000-8000-00000000000a') returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a1700000-0000-4000-8000-0000000000f1',
    'role', 'authenticated', 'org_id', p_org, 'app_role', p_role)::text, true);
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
create function pg_temp.terminal(p_k text) returns public.payment_terminal language sql security definer as $$
  select * from public.payment_terminal where id = pg_temp.id(p_k);
$$;
create function pg_temp.runtime(p_k text, p_org uuid default 'a1700000-0000-4000-8000-00000000000a')
returns jsonb language sql security definer as $$
  select public.payment_terminal_runtime(pg_temp.id(p_k), p_org);
$$;
grant execute on all functions in schema pg_temp to authenticated;

set local role authenticated;

-- ROLE -----------------------------------------------------------------------------------------
select pg_temp.as_role('manager');
select pg_temp.chk('ROLE', 'a manager cannot edit terminals (the endpoint decides where the Authkey goes)',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-mgr', null, 'Front', 'https://spinpos.net',
    'TPN0001', 'terminal:a1700000-0000-4000-8000-00000000000a:front')$$), '42501');
select pg_temp.as_role('cashier');
select pg_temp.chk('ROLE', 'nor a cashier',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-cash', null, 'Front', 'https://spinpos.net',
    'TPN0001', 'terminal:a1700000-0000-4000-8000-00000000000a:front')$$), '42501');
select pg_temp.chk('ROLE', 'no direct writes to payment_terminal',
  pg_temp.err($$insert into public.payment_terminal (org_id, name, provider)
    values ('a1700000-0000-4000-8000-00000000000a', 'X', 'dejavoo_spin')$$), '42501');

-- SAVE -----------------------------------------------------------------------------------------
select pg_temp.as_role('owner');
insert into t_ids select 't1', public.admin_save_payment_terminal('wp17-act-t1', null, ' Front counter ',
  'https://dev.spinpos.net', 'Z8TPN0001', 'terminal:a1700000-0000-4000-8000-00000000000a:front',
  '', 90, 'a1700000-0000-4000-8000-0000000000a5') ->> 'terminal_id';
select pg_temp.chk('SAVE', 'a Dejavoo terminal: trimmed name, site, provider, secret ref',
  (select format('%s|%s|%s|%s|%s', name, site_id, provider, secret_ref, is_active) from pg_temp.terminal('t1')),
  'Front counter|a1700000-0000-4000-8000-0000000000a5|dejavoo_spin|terminal:a1700000-0000-4000-8000-00000000000a:front|t');
select pg_temp.chk('SAVE', 'config: endpoint, TPN, timeout — an empty register id is NOT stored (SPIn 2003)',
  (select config from pg_temp.terminal('t1')),
  '{"tpn": "Z8TPN0001", "endpoint_url": "https://dev.spinpos.net", "timeout_secs": 90}'::jsonb);
select pg_temp.chk('SAVE', 'replay of the same client_action_id returns the same terminal, no second row',
  public.admin_save_payment_terminal('wp17-act-t1', null, ' Front counter ', 'https://dev.spinpos.net', 'Z8TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:front', '', 90, 'a1700000-0000-4000-8000-0000000000a5') ->> 'terminal_id'
  || ':' || (select count(*) from public.payment_terminal where name = 'Front counter'),
  pg_temp.id('t1') || ':1');
select pg_temp.chk('SAVE', 'the saved config + Vault Authkey is what the adapter gets',
  (select format('%s|%s|%s', r -> 'config' ->> 'tpn', r -> 'config' ->> 'endpoint_url', r ->> 'secret')
   from pg_temp.runtime('t1') r),
  'Z8TPN0001|https://dev.spinpos.net|not-a-real-authkey');

-- EDIT -----------------------------------------------------------------------------------------
reset role;
update public.payment_terminal set config = config || '{"note": "kept"}' where id = pg_temp.id('t1');
set local role authenticated;
select public.admin_save_payment_terminal('wp17-act-t1-edit', pg_temp.id('t1'), 'Front counter', 'https://spinpos.net',
  'Z8TPN0001', 'terminal:a1700000-0000-4000-8000-00000000000a:front', 'R7', null, null, false);
select pg_temp.chk('EDIT', 'register id set, timeout cleared, other keys kept, site cleared, inactive',
  (select format('%s|%s|%s', config, site_id is null, is_active) from pg_temp.terminal('t1')),
  format('%s|t|f', '{"tpn": "Z8TPN0001", "note": "kept", "register_id": "R7", "endpoint_url": "https://spinpos.net"}'::jsonb));
select pg_temp.chk('EDIT', 'a deactivated terminal still resolves for its existing payments (status / void / refund)',
  (select format('%s|%s|%s', r -> 'config' ->> 'tpn', r ->> 'is_active', r ->> 'secret') from pg_temp.runtime('t1') r),
  'Z8TPN0001|false|not-a-real-authkey');
select pg_temp.chk('EDIT', 'runtime stays org-scoped: org B''s id never resolves org A''s terminal',
  pg_temp.err($$select pg_temp.runtime('t1', 'b1700000-0000-4000-8000-00000000000b')$$), 'P0002');
select pg_temp.chk('EDIT', 'a non-Dejavoo terminal is not edited here',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-manual', 'a1700000-0000-4000-8000-000000000701',
    'Counter cash', 'https://spinpos.net', 'TPN0001', 'terminal:a1700000-0000-4000-8000-00000000000a:front')$$), '22023');

-- VALIDATION -----------------------------------------------------------------------------------
select pg_temp.chk('VALID', 'endpoint: http to a public host, a path, junk are refused; loopback http is allowed',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v1', null, 'V1', 'http://spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v2', null, 'V2', 'https://spinpos.net/v2/Payment', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v3', null, 'V3', 'spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v4', null, 'V4', 'http://127.0.0.1:9000', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v')$$),
  '22023:22023:22023:ok');
select pg_temp.chk('VALID', 'TPN, register id, timeout bounds',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v5', null, 'V5', 'https://spinpos.net', '',
    'terminal:a1700000-0000-4000-8000-00000000000a:v')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v6', null, 'V6', 'https://spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v', 'bad id!')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v7', null, 'V7', 'https://spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v', null, 600)$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v8', null, 'V8', 'https://spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v', null, 29)$$),
  '22023:22023:22023:22023');
select pg_temp.chk('VALID', 'duplicate name refused; another org''s site refused',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v9', null, 'Front counter', 'https://spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-v10', null, 'V10', 'https://spinpos.net', 'TPN0001',
    'terminal:a1700000-0000-4000-8000-00000000000a:v', null, null, 'b1700000-0000-4000-8000-0000000000b5')$$),
  '23505:P0002');

-- TENANCY: a secret ref names only the caller's own org's Vault secrets ---------------------------
select pg_temp.chk('TENANCY', 'another org''s secret, a bare name, or no secret ref are refused',
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-s1', null, 'S1', 'https://spinpos.net', 'TPN0001',
    'terminal:b1700000-0000-4000-8000-00000000000b:front')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-s2', null, 'S2', 'https://spinpos.net', 'TPN0001',
    'front')$$) || ':' ||
  pg_temp.err($$select public.admin_save_payment_terminal('wp17-act-s3', null, 'S3', 'https://spinpos.net', 'TPN0001',
    null)$$),
  '22023:22023:22023');
select pg_temp.as_role('owner', 'b1700000-0000-4000-8000-00000000000b');
select pg_temp.chk('TENANCY', 'org B cannot edit org A''s terminal',
  pg_temp.err(format($$select public.admin_save_payment_terminal('wp17-act-x', %L, 'Mine now', 'https://spinpos.net',
    'TPN0001', 'terminal:b1700000-0000-4000-8000-00000000000b:front')$$, pg_temp.id('t1'))), 'P0002');
select pg_temp.chk('TENANCY', 'org B does not see org A''s terminals',
  (select count(*) from public.payment_terminal where org_id = 'a1700000-0000-4000-8000-00000000000a'), 0);

reset role;
select is(got, want, format('%s — %s', inv, label)) from t_check order by seq;

select * from finish();
rollback;
