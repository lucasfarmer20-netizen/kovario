-- v1.1 asset tag capacity (#85): new orgs get 4-digit tags; admin_update_org raises
-- scanner.tag_digits (never lowers it) and re-pads every tag; labels printed before a raise
-- keep resolving; other orgs are untouched.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a2300000-0000-4000-8000-00000000000a', 'tagcap-a', 'Tag A', 'UTC'),
  ('b2300000-0000-4000-8000-00000000000b', 'tagcap-b', 'Tag B', 'UTC');

select is((select settings #>> '{scanner,tag_digits}' from public.org where slug = 'tagcap-b'), '4',
  'I85 a new org gets 4-digit asset tags (org.settings default)');

-- Org A predates v1.1: 3-digit tags, one already on a basket.
update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3')
where slug = 'tagcap-a';
insert into public.site (id, org_id, name) values
  ('a2300000-0000-4000-8000-000000000001', 'a2300000-0000-4000-8000-00000000000a', 'Main');
insert into public.customer (id, org_id, name) values
  ('a2300000-0000-4000-8000-000000000002', 'a2300000-0000-4000-8000-00000000000a', 'Tag customer');
insert into auth.users (id, email) values
  ('a2300000-0000-4000-8000-0000000000a1', 'tagcap-manager@example.test'),
  ('b2300000-0000-4000-8000-0000000000b1', 'tagcap-manager-b@example.test');
insert into public.org_member (org_id, user_id, role, display_name) values
  ('a2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-0000000000a1', 'manager', 'M'),
  ('b2300000-0000-4000-8000-00000000000b', 'b2300000-0000-4000-8000-0000000000b1', 'manager', 'MB');
insert into public.intake (id, org_id, number, customer_id, site_id, tote_count) values
  ('a2300000-0000-4000-8000-000000000011', 'a2300000-0000-4000-8000-00000000000a', 'INT-0001',
   'a2300000-0000-4000-8000-000000000002', 'a2300000-0000-4000-8000-000000000001', 1);
update public.intake set state = 'holding' where org_id = 'a2300000-0000-4000-8000-00000000000a';
insert into public.tote_tag (org_id, intake_id, tote_no, of_count, qr) values
  ('a2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000011', 1, 1,
   'FL:TOTE:INT-0001:1');
update public.intake set state = 'processing' where org_id = 'a2300000-0000-4000-8000-00000000000a';
update public.intake set state = 'rollstock' where org_id = 'a2300000-0000-4000-8000-00000000000a';
update public.intake set state = 'reconcile' where org_id = 'a2300000-0000-4000-8000-00000000000a';

insert into public.asset_tag (org_id, code, qr) values
  ('a2300000-0000-4000-8000-00000000000a', '042', 'FL:TAG:tagcap-a:042'),
  ('a2300000-0000-4000-8000-00000000000a', '043', 'FL:TAG:tagcap-a:043'),
  ('a2300000-0000-4000-8000-00000000000a', '999', 'FL:TAG:tagcap-a:999'),
  ('b2300000-0000-4000-8000-00000000000b', '0042', 'FL:TAG:tagcap-b:0042');

-- Codes are canonical at the org's width ---------------------------------------------------
select throws_ok($$ insert into public.asset_tag (org_id, code, qr) values
  ('a2300000-0000-4000-8000-00000000000a', '0044', 'FL:TAG:tagcap-a:0044') $$,
  '23514', null, 'I85 a 3-digit org refuses a 4-digit code');
select throws_ok($$ insert into public.asset_tag (org_id, code, qr) values
  ('b2300000-0000-4000-8000-00000000000b', '044', 'FL:TAG:tagcap-b:044') $$,
  '23514', null, 'I85 a 4-digit org refuses a 3-digit code');

-- Raise 3 → 4 -------------------------------------------------------------------------------
create temp table t (k text primary key, v jsonb) on commit drop;
grant all on t to authenticated;
select set_config('request.jwt.claims', '{"sub":"a2300000-0000-4000-8000-0000000000a1","role":"authenticated","org_id":"a2300000-0000-4000-8000-00000000000a","app_role":"manager"}', true);
set local role authenticated;

select is((select settings -> 'scanner' from public.org), '{"tag_digits": 3}'::jsonb,
  'I85 an existing org keeps its width');

create function pg_temp.save(p_id text, p_digits int) returns jsonb language sql as $$
  select public.admin_update_org(p_id, 'Tag A', 'UTC',
    (select jsonb_set(settings, '{scanner,tag_digits}', to_jsonb(p_digits)) from public.org))
$$;
grant execute on function pg_temp.save(text, int) to authenticated;

insert into t select 'raise', pg_temp.save('tagcap-raise-4', 4);
select is((select v -> 'repadded_tags' from t where k = 'raise'), '3'::jsonb,
  'I85 raising 3 → 4 re-pads every tag');
select is((select array_agg(code || ' ' || qr order by code) from public.asset_tag),
  array['0042 FL:TAG:tagcap-a:0042', '0043 FL:TAG:tagcap-a:0043', '0999 FL:TAG:tagcap-a:0999'],
  'I85 codes and QR text are at the new width');
select is((select settings #>> '{scanner,tag_digits}' from public.org), '4', 'I85 width stored');
select is(pg_temp.save('tagcap-raise-4', 4), (select v from t where k = 'raise'),
  'I85 a replayed raise returns the stored result');

-- Lowering is rejected -------------------------------------------------------------------------
select throws_ok($$ select pg_temp.save('tagcap-lower-3', 3) $$, '22023',
  'Basket tag digits can only be raised (now 4, asked for 3).', 'I85 lowering 4 → 3 is rejected');
select is((select array_agg(code order by code) from public.asset_tag), array['0042', '0043', '0999'],
  'I85 a rejected lowering leaves the tags alone');
select lives_ok($$ select pg_temp.save('tagcap-same-4', 4) $$,
  'I85 saving other settings at the same width is allowed');

-- Old labels keep scanning ----------------------------------------------------------------------
select is(public.bind_tag('tagcap-bind-old', 'FL:TAG:tagcap-a:042',
  'a2300000-0000-4000-8000-000000000011') ->> 'ok', 'true',
  'I85 an old 3-digit label binds the re-padded tag');
select is((select t.code from public.vessel v join public.asset_tag t on t.id = v.asset_tag_id),
  '0042', 'I85 the vessel is bound to tag 0042');
select is(public.bind_tag('tagcap-bind-bare', '43', 'a2300000-0000-4000-8000-000000000011') ->> 'ok',
  'true', 'I85 a bare code resolves at the new width');
select is(public.bind_tag('tagcap-bind-foreign', 'FL:TAG:tagcap-b:0042',
  'a2300000-0000-4000-8000-000000000011') ->> 'reason', 'Basket not found. Scan a different basket.',
  'I85 another org''s label never resolves');

-- A further raise (4 → 5) still resolves labels printed at 3 and at 4 digits.
select is((pg_temp.save('tagcap-raise-5', 5) -> 'repadded_tags'), '3'::jsonb, 'I85 raising 4 → 5');
select is(public.bind_tag('tagcap-bind-again-3', 'FL:TAG:tagcap-a:042',
  'a2300000-0000-4000-8000-000000000011') ->> 'reason', 'Basket 00042 is already on INT-0001. Scan a different basket.',
  'I85 a 3-digit label resolves after two raises');
select is(public.bind_tag('tagcap-bind-again-4', 'FL:TAG:tagcap-a:0043',
  'a2300000-0000-4000-8000-000000000011') ->> 'reason', 'Basket 00043 is already on INT-0001. Scan a different basket.',
  'I85 a 4-digit label resolves after a raise to 5');

reset role;
select is(app.normalize_tag_code('FL:TAG:tagcap-a:42'), '00042',
  'I85 the SQL lookup normalises the label''s numeric part');
select is(app.normalize_tag_code('FL:TAG:tagcap-a:042:1'), null, 'I85 a malformed label is no code');

-- Other orgs are not changed ------------------------------------------------------------------
select is((select code || ' ' || qr from public.asset_tag where org_id = 'b2300000-0000-4000-8000-00000000000b'),
  '0042 FL:TAG:tagcap-b:0042', 'I85 another org''s tags are untouched by a raise');
select is((select settings #>> '{scanner,tag_digits}' from public.org where slug = 'tagcap-b'), '4',
  'I85 another org''s width is untouched by a raise');

-- A 4-digit org fills its pool through admin_asset_tags -----------------------------------
-- Range payloads as the Admin → Asset tags action builds them (qr.ts normalizeTagCode/encode).
create function pg_temp.tag_range(p_first int, p_last int) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('code', lpad(n::text, 4, '0'),
    'qr', 'FL:TAG:tagcap-b:' || lpad(n::text, 4, '0')) order by n)
  from generate_series(p_first, p_last) n
$$;
grant execute on function pg_temp.tag_range(int, int) to authenticated;
select set_config('request.jwt.claims', '{"sub":"b2300000-0000-4000-8000-0000000000b1","role":"authenticated","org_id":"b2300000-0000-4000-8000-00000000000b","app_role":"manager"}', true);
set local role authenticated;

select lives_ok($$ select public.admin_asset_tags('tagcap-b-1400', pg_temp.tag_range(1, 1400)) $$,
  'I85 a plant creates tags 1–1400 in one range (more than the old 1000 cap)');
select is((select count(*)::int from public.asset_tag), 1400,
  'I85 1400 tags exist (0042 already did; the range skips it)');
select lives_ok($$ select public.admin_asset_tags('tagcap-b-pool', pg_temp.tag_range(0, 9999)) $$,
  'I85 the whole 0–9999 pool is one range');
select is((select count(*)::int || ' ' || min(code) || ' ' || max(code) from public.asset_tag),
  '10000 0000 9999', 'I85 the 4-digit pool is full');
select throws_ok($$ select public.admin_asset_tags('tagcap-b-too-many',
  pg_temp.tag_range(0, 9999) || '[{"code":"0000","qr":"FL:TAG:tagcap-b:0000"}]'::jsonb) $$,
  'P0001', 'Invalid range', 'I85 more than max_tag_range() tags in one call is rejected');

select * from finish();
rollback;
