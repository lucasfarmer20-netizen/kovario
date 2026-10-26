-- action_log idempotency: replaying a client_action_id returns the stored result
-- (docs/01-ARCHITECTURE.md §7).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

insert into public.org (id, slug, name, timezone) values
  ('a0000000-0000-4000-8000-00000000000a', 'org-a', 'Org A', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', 'org-b', 'Org B', 'UTC');

select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"staff"}',
  true);
set local role authenticated;

select is(public.action_begin('act-00000001', 'intake.save', '{"x":1}') ->> 'status', 'new',
  'first begin claims the action');
select is(public.action_begin('act-00000001', 'intake.save', '{"x":1}') ->> 'status', 'pending',
  'a concurrent replay sees the action in flight');

select public.action_complete('act-00000001', '{"number":"INT-0001"}');

select is(public.action_begin('act-00000001', 'intake.save', '{"x":1}'),
  '{"status":"done","result":{"number":"INT-0001"}}'::jsonb,
  'replaying a completed action id returns the stored result');

select throws_ok(
  $$ select public.action_begin('act-00000001', 'payment.void', null) $$,
  '23505', null, 'an action id cannot be reused for a different action'
);

select throws_ok(
  $$ select public.action_complete('act-00000001', '{"other":true}') $$,
  'P0002', null, 'a completed action cannot be completed again'
);

-- Abort releases the claim so a retry can run.
select public.action_begin('act-00000002', 'intake.save', null);
select public.action_abort('act-00000002');
select is(public.action_begin('act-00000002', 'intake.save', null) ->> 'status', 'new',
  'an aborted action can be retried with the same id');

-- A stale in-flight claim (crashed request) is taken over.
reset role;
update public.action_log set at = now() - interval '10 minutes' where client_action_id = 'act-00000002';
set local role authenticated;
select is(public.action_begin('act-00000002', 'intake.save', null) ->> 'status', 'new',
  'a stale in-flight claim is taken over');

select is((select user_id::text from public.action_log where client_action_id = 'act-00000001'),
  'a0000000-0000-4000-8000-0000000000a1', 'action_log records the acting user');

-- Another org cannot replay or read org A's actions.
reset role;
select set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000b1","role":"authenticated","org_id":"b0000000-0000-4000-8000-00000000000b","app_role":"owner"}',
  true);
set local role authenticated;

select throws_ok(
  $$ select public.action_begin('act-00000001', 'intake.save', '{"x":1}') $$,
  '23505', null, 'another org cannot replay org A''s action id'
);
select is_empty($$ select id from public.action_log $$, 'another org cannot read org A''s action_log');

-- Outbox writes are org-guarded like next_seq.
select isnt(app.emit_event('b0000000-0000-4000-8000-00000000000b', 'test_event', null, '{}'), null,
  'end user emits a domain_event for their own org');
select throws_ok(
  $$ select app.emit_event('a0000000-0000-4000-8000-00000000000a', 'test_event', null, '{}') $$,
  '42501', null, 'end user cannot emit a domain_event into another org'
);

reset role;
select * from finish();
rollback;
