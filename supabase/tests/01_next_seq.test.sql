-- next_seq: per-org, per-kind formatted counters (docs/01-ARCHITECTURE.md §3).
-- Concurrency (no duplicates under 10 parallel callers) is covered by
-- packages/db/src/next-seq.db.test.ts, which needs real parallel connections.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(10);

insert into public.org (id, slug, name, timezone) values
  ('a0000000-0000-4000-8000-00000000000a', 'org-a', 'Org A', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', 'org-b', 'Org B', 'UTC');

select is(app.next_seq('a0000000-0000-4000-8000-00000000000a', 'intake'), 'INT-0001', 'first intake number is INT-0001');
select is(app.next_seq('a0000000-0000-4000-8000-00000000000a', 'intake'), 'INT-0002', 'second intake number is INT-0002');
select is(app.next_seq('b0000000-0000-4000-8000-00000000000b', 'intake'), 'INT-0001', 'numbering is per org');
select is(app.next_seq('a0000000-0000-4000-8000-00000000000a', 'storage_intake'), 'STG-0001', 'numbering is per kind');
select is(app.next_seq('a0000000-0000-4000-8000-00000000000a', 'wave'), 'WAVE-0001', 'wave prefix');

update public.sequence_counter set value = 9999
where org_id = 'a0000000-0000-4000-8000-00000000000a' and kind = 'intake';
select is(app.next_seq('a0000000-0000-4000-8000-00000000000a', 'intake'), 'INT-10000', 'numbers past the pad width are not truncated');

select throws_ok(
  $$ select app.next_seq('a0000000-0000-4000-8000-00000000000a', 'bogus') $$,
  '22023', null, 'unknown kind is rejected'
);

select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a0000000-0000-4000-8000-00000000000a","app_role":"owner"}',
  true);
set local role authenticated;

select is(app.next_seq('a0000000-0000-4000-8000-00000000000a', 'charge'), 'CHG-0001', 'end user can number rows in their own org');

select throws_ok(
  $$ select app.next_seq('b0000000-0000-4000-8000-00000000000b', 'charge') $$,
  '42501', null, 'end user cannot consume another org''s sequence'
);

select throws_ok(
  $$ update public.sequence_counter set value = 0 $$,
  '42501', null, 'sequence_counter is not directly writable by clients'
);

reset role;
select * from finish();
rollback;
