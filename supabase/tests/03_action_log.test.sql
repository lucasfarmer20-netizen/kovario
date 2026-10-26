-- action_log idempotency (docs/01-ARCHITECTURE.md §7, AGENTS.md hard rule 3): a mutation
-- claims its client_action_id, writes and stores its result in ONE transaction; replaying
-- the id returns the stored result and never repeats the write.
-- Lost-response and concurrent-duplicate cases across real connections are covered by
-- packages/db/src/with-action.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

insert into public.org (id, slug, name, timezone) values
  ('a0000000-0000-4000-8000-00000000000a', 'org-a', 'Org A', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', 'org-b', 'Org B', 'UTC');

select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"manager"}',
  true);
set local role authenticated;

-- Atomic admin mutation: the write and the stored result commit together.
create temp table t_first on commit drop as
  select public.admin_create_site('act-00000001', 'Dock') as r;

select is((select count(*)::int from public.site where name = 'Dock'), 1, 'the action wrote once');
select is(
  (select result from public.action_log where client_action_id = 'act-00000001'),
  (select r from t_first),
  'action_log stores the result in the same transaction'
);
select ok((select completed_at is not null from public.action_log where client_action_id = 'act-00000001'),
  'the action is completed when its transaction commits');

-- Replaying the id (e.g. after a lost response) returns the stored result, no new write.
select is(public.admin_create_site('act-00000001', 'Dock'), (select r from t_first),
  'replaying a completed action id returns the stored result');
select is((select count(*)::int from public.site where name = 'Dock'), 1, 'a replay does not write again');

select throws_ok(
  $$ select public.admin_rename_site('act-00000001', (select (r ->> 'site_id')::uuid from t_first), 'Pier') $$,
  '23505', null, 'an action id cannot be reused for a different action'
);

-- A failed action rolls back its claim with its writes, so the id can be retried.
select throws_ok($$ select public.admin_create_site('act-00000002', '   ') $$, '23514', null,
  'an invalid write fails');
select is_empty($$ select id from public.action_log where client_action_id = 'act-00000002' $$,
  'a failed action leaves no action_log row');
select isnt(public.admin_create_site('act-00000002', 'Retried'), null,
  'a failed action id can be retried');

select throws_ok($$ select app.action_begin(null, 'site.create', null) $$, '22004', null,
  'a client_action_id is required');

select is((select user_id::text from public.action_log where client_action_id = 'act-00000001'),
  'a0000000-0000-4000-8000-0000000000a1', 'action_log records the acting user');

-- Another org cannot replay or read org A's actions.
reset role;
select set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000b1","role":"authenticated","org_id":"b0000000-0000-4000-8000-00000000000b","app_role":"owner"}',
  true);
set local role authenticated;

select throws_ok(
  $$ select public.admin_create_site('act-00000001', 'Dock') $$,
  '23505', null, 'another org cannot replay org A''s action id'
);
select is_empty($$ select id from public.action_log $$, 'another org cannot read org A''s action_log');

-- Outbox writes are org-guarded like next_seq.
select throws_ok(
  $$ select app.emit_event('a0000000-0000-4000-8000-00000000000a', 'test_event', null, '{}') $$,
  '42501', null, 'end user cannot emit a domain_event into another org'
);

reset role;
select * from finish();
rollback;
