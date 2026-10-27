-- WP-22 onboarding + billing: create_org (signup → org, owner, site, reference seed, default
-- rate card; idempotent without an org claim), org settings validation, rate cards,
-- species/method admin, and the Stripe webhook's org.plan writes (dedupe, ordering).
-- The full processing-rules payload is exercised in packages/db/src/onboarding.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('c2200000-0000-4000-8000-0000000000a1', 'founder@wp22.test'),
  ('c2200000-0000-4000-8000-0000000000a2', 'other@wp22.test'),
  ('c2200000-0000-4000-8000-0000000000a3', 'device@devices.filletry.internal'),
  ('c2200000-0000-4000-8000-0000000000a4', 'staff@wp22.test');

-- An existing org the founder already belongs to (their default) and a device user.
insert into public.org (id, slug, name, timezone) values
  ('c2200000-0000-4000-8000-00000000000e', 'wp22-existing', 'Existing', 'UTC');
insert into public.org_member (org_id, user_id, role, display_name, is_default) values
  ('c2200000-0000-4000-8000-00000000000e', 'c2200000-0000-4000-8000-0000000000a1', 'staff', 'F', true);
insert into public.device (org_id, name, station, auth_user_id) values
  ('c2200000-0000-4000-8000-00000000000e', 'Tablet', 'intake', 'c2200000-0000-4000-8000-0000000000a3');

create temp table t (k text primary key, v jsonb) on commit drop;
grant all on t to authenticated, service_role;

create function pg_temp.as_user(p_user text, p_org text default null, p_role text default null)
returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object(
    'sub', p_user, 'role', 'authenticated', 'org_id', p_org, 'app_role', p_role))::text, true);
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
$$;
grant execute on function pg_temp.as_user(text, text, text), pg_temp.as_service()
  to authenticated, service_role;

-- A minimal reference payload (the real one is packages/rules referenceSeed()).
insert into t values ('ref', $json$ {
  "species": [
    {"code": "salmon_reds", "name": "Reds", "group": "salmon", "shorthand": "SOCK",
     "skin_off_allowed": false, "skin_off_multiplier": 0.85, "sort": 10, "is_active": true},
    {"code": "whitefish_halibut", "name": "Halibut", "group": "whitefish", "shorthand": "HAL",
     "skin_off_allowed": true, "skin_off_multiplier": 0.85, "sort": 20, "is_active": true}],
  "conditions": [
    {"code": "whole", "name": "Whole", "sort": 10, "is_active": true},
    {"code": "filleted", "name": "Filleted", "sort": 20, "is_active": true}],
  "methods": [
    {"code": "fresh", "name": "Fresh", "shorthand": null, "kind": "virtual", "is_exchange": false,
     "lodge_cappable": true, "sort": 10, "is_active": true},
    {"code": "fillets", "name": "Fillets", "shorthand": "FIL", "kind": "service", "is_exchange": false,
     "lodge_cappable": true, "sort": 20, "is_active": true},
    {"code": "portions", "name": "Portions", "shorthand": "POR", "kind": "service", "is_exchange": false,
     "lodge_cappable": true, "sort": 30, "is_active": true},
    {"code": "head_off", "name": "Head off", "shorthand": "H/O", "kind": "service", "is_exchange": false,
     "lodge_cappable": true, "sort": 40, "is_active": false}],
  "condition_matrix": [
    {"matrix_key": "salmon", "condition_code": "whole"},
    {"matrix_key": "whitefish", "condition_code": "filleted"}],
  "processing_matrix": [
    {"matrix_key": "salmon", "condition_code": "whole", "method_code": "fresh"},
    {"matrix_key": "salmon", "condition_code": "whole", "method_code": "fillets"}],
  "yield_factors": [
    {"species_code": "salmon_reds", "condition_code": "whole", "method_code": "fillets", "factor": 0.55}]
} $json$::jsonb);

-- create_org: who may call it ------------------------------------------------------------
set local role anon;
select throws_ok(
  $$ select public.create_org('org-anon-0001', 'X', 'xxx', 'UTC', 'Me', (select v from t where k = 'ref')) $$,
  '42501', null, 'anon cannot create an org');
reset role;

select pg_temp.as_user('c2200000-0000-4000-8000-0000000000a3', 'c2200000-0000-4000-8000-00000000000e', 'station');
set local role authenticated;
select throws_ok(
  $$ select public.create_org('org-device-01', 'X', 'xdevice', 'UTC', 'Me', (select v from t where k = 'ref')) $$,
  '42501', null, 'a station device cannot create an org');

-- Validation (no org claim: a brand-new signup) ---------------------------------------------
select pg_temp.as_user('c2200000-0000-4000-8000-0000000000a1');
select throws_ok(
  $$ select public.create_org('org-bad-slug1', 'Kenai Fish', 'Kenai Fish', 'UTC', 'Fay', (select v from t where k = 'ref')) $$,
  '22023', null, 'slug must be lowercase letters, digits and dashes');
select throws_ok(
  $$ select public.create_org('org-bad-tz-01', 'Kenai Fish', 'kenai-fish', 'Mars/Olympus', 'Fay', (select v from t where k = 'ref')) $$,
  '22023', null, 'timezone must be a known IANA zone');
select throws_ok(
  $$ select public.create_org('org-bad-ref-1', 'Kenai Fish', 'kenai-fish', 'UTC', 'Fay', '{"species": []}') $$,
  '22023', null, 'the reference payload must carry every table');
select throws_ok(
  $$ select public.create_org('org-taken-01', 'Kenai Fish', 'wp22-existing', 'UTC', 'Fay', (select v from t where k = 'ref')) $$,
  '23505', null, 'a taken slug is refused');

-- Success: everything in one transaction ---------------------------------------------------
insert into t select 'created', public.create_org('org-create-01', ' Kenai Fish Co ', 'kenai-fish',
  'America/Anchorage', 'Fay Founder', (select v from t where k = 'ref'), 'Dock');
reset role;

select is((select name || '|' || timezone || '|' || coalesce(plan, '-') from public.org where slug = 'kenai-fish'),
  'Kenai Fish Co|America/Anchorage|-', 'org created with trimmed name, timezone, no plan yet');
select is((select (v ->> 'org_id')::uuid from t where k = 'created'),
  (select id from public.org where slug = 'kenai-fish'), 'result carries the org id');
select is(
  (select role::text || '|' || display_name || '|' || is_default from public.org_member
   where user_id = 'c2200000-0000-4000-8000-0000000000a1' and org_id = (select id from public.org where slug = 'kenai-fish')),
  'owner|Fay Founder|true', 'the signer-up is the owner and the new org is their default');
select is(
  (select is_default from public.org_member where user_id = 'c2200000-0000-4000-8000-0000000000a1'
   and org_id = 'c2200000-0000-4000-8000-00000000000e'),
  false, 'their previous default membership is unset');
select is(
  (app.custom_access_token_hook(jsonb_build_object('user_id', 'c2200000-0000-4000-8000-0000000000a1',
     'claims', '{}'::jsonb)) -> 'claims' ->> 'org_id')::uuid,
  (select id from public.org where slug = 'kenai-fish'),
  'a refreshed token is stamped with the new org');
select is((select name || '|' || is_default from public.site where org_id = (select id from public.org where slug = 'kenai-fish')),
  'Dock|true', 'first site created as the default');

select is((select v -> 'seeded' from t where k = 'created'),
  '{"species": 2, "conditions": 2, "methods": 4, "condition_matrix": 2, "processing_matrix": 2, "yield_factors": 1}'::jsonb,
  'reference data seeded from the payload');
select is((select is_active from public.processing_method
           where org_id = (select id from public.org where slug = 'kenai-fish') and code = 'head_off'),
  false, 'seeded flags are kept (head_off inactive)');

select is(
  (select array_agg(l.key || '=' || l.amount order by l.key) from public.rate_card_line l
   join public.rate_card c on c.id = l.rate_card_id
   where c.org_id = (select id from public.org where slug = 'kenai-fish') and c.is_default),
  array['fast_pass_per_lb=0.00', 'fillets=0.00', 'head_off=0.00', 'portions=0.00',
        'ribbing_per_lb=0.00', 'storage_per_box_day=0.00'],
  'default rate card: every service method (not virtual fresh) + the three named rates, at $0');

select is((select action || '|' || (completed_at is not null) from public.action_log where client_action_id = 'org-create-01'),
  'org.create|true', 'the create is recorded in action_log in the same transaction');
select is((select count(*)::int from public.domain_event
           where kind = 'org_created' and org_id = (select id from public.org where slug = 'kenai-fish')),
  1, 'org_created event written');

-- Replay and misuse of the action id ----------------------------------------------------------
select pg_temp.as_user('c2200000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is(public.create_org('org-create-01', 'Kenai Fish Co', 'kenai-fish', 'America/Anchorage',
  'Fay Founder', (select v from t where k = 'ref'), 'Dock'),
  (select v from t where k = 'created'), 'a retry with the same id replays the stored result');
select pg_temp.as_user('c2200000-0000-4000-8000-0000000000a2');
select throws_ok(
  $$ select public.create_org('org-create-01', 'Thief', 'thief-co', 'UTC', 'T', (select v from t where k = 'ref')) $$,
  '23505', null, 'another user cannot replay someone else''s action id');
reset role;
select is((select count(*)::int from public.org where slug in ('kenai-fish', 'thief-co')), 1,
  'exactly one org exists after replays');

-- Owner session in the new org -------------------------------------------------------------
insert into t select 'org', to_jsonb(id::text) from public.org where slug = 'kenai-fish';
create function pg_temp.as_owner(p_role text default 'owner') returns void language sql as $$
  select pg_temp.as_user('c2200000-0000-4000-8000-0000000000a1', (select v #>> '{}' from t where k = 'org'), p_role);
$$;
grant execute on function pg_temp.as_owner(text) to authenticated;

select pg_temp.as_owner();
set local role authenticated;

select is(
  (public.admin_seed_reference('seed-again-01', (select v from t where k = 'ref')) -> 'seeded'),
  '{"species": 0, "conditions": 0, "methods": 0, "condition_matrix": 0, "processing_matrix": 0, "yield_factors": 0}'::jsonb,
  're-seeding inserts nothing and keeps existing rows');

-- Org settings (§12) --------------------------------------------------------------------------
insert into t values ('settings', '{
  "hold_hours": 36, "estimated_pickup_days": 4, "wave_target_lb": 3500, "wave_tolerance_lb": 200,
  "receipt_footer": "Thanks!", "status_page_enabled": false,
  "tax": {"mode": "exclusive", "rate": 0.07, "cap_amount": null},
  "shipping": {"carrier_allowlist": ["usps", "fedex"], "buy_window_days": 2},
  "scanner": {"tag_digits": 3}}');

select lives_ok(
  $$ select public.admin_update_org('org-upd-0001', 'Kenai Fish', 'America/Juneau', (select v from t where k = 'settings')) $$,
  'owner saves valid settings');
reset role;
select is((select settings ->> 'hold_hours' || '|' || timezone || '|' || name from public.org where slug = 'kenai-fish'),
  '36|America/Juneau|Kenai Fish', 'settings, timezone and name stored');
set local role authenticated;

create function pg_temp.bad_settings(p_patch jsonb) returns text language plpgsql as $$
begin
  perform public.admin_update_org(gen_random_uuid()::text, 'Kenai Fish', 'UTC',
    (select v from t where k = 'settings') || p_patch);
  return 'accepted';
exception when sqlstate '22023' then return 'rejected';
end; $$;
grant execute on function pg_temp.bad_settings(jsonb) to authenticated;

select is(pg_temp.bad_settings('{"hold_hours": 0}'), 'rejected', 'hold_hours below 1 rejected');
select is(pg_temp.bad_settings('{"hold_hours": 12.5}'), 'rejected', 'fractional hold_hours rejected');
select is(pg_temp.bad_settings('{"wave_tolerance_lb": 9000}'), 'rejected', 'tolerance above target rejected');
select is(pg_temp.bad_settings('{"tax": {"mode": "inclusive", "rate": 0.06, "cap_amount": 30}}'),
  'rejected', 'tax mode other than exclusive rejected (DECISION-07 default)');
select is(pg_temp.bad_settings('{"tax": {"mode": "exclusive", "rate": 6, "cap_amount": 30}}'),
  'rejected', 'tax rate as a percentage (6) rejected');
select is(pg_temp.bad_settings('{"shipping": {"carrier_allowlist": [], "buy_window_days": 1}}'),
  'rejected', 'empty carrier allowlist rejected');
select is(pg_temp.bad_settings('{"fast_pass_per_lb": 3}'), 'rejected',
  'money rates are not settings (unknown key rejected)');
select is(pg_temp.bad_settings('{"tax": {"mode": "exclusive", "rate": 0.06, "cap_amount": 30}}'),
  'accepted', 'a tax cap amount is accepted');
select is(pg_temp.bad_settings('{"shipping": {"carrier_allowlist": "*", "buy_window_days": 1}}'),
  'accepted', 'carrier allowlist "*" = all carriers');

select pg_temp.as_owner('staff');
select throws_ok(
  $$ select public.admin_update_org('org-upd-staff', 'X', 'UTC', (select v from t where k = 'settings')) $$,
  '42501', null, 'staff cannot change org settings');
select pg_temp.as_owner();

-- Rate cards ----------------------------------------------------------------------------------
select public.admin_set_rate_card_lines('rc-lines-001',
  (select id from public.rate_card where is_default),
  '[{"key": "fillets", "amount": 1.95}, {"key": "fast_pass_per_lb", "amount": 3.5}]');
select is((select amount from public.rate_card_line l join public.rate_card c on c.id = l.rate_card_id
           where c.is_default and l.key = 'fillets'), 1.95::numeric, 'default card rate saved');

insert into t select 'summer', public.admin_create_rate_card('rc-create-01', 'Summer 2027', '2027-05-01', '2027-09-30');
select is(
  (select amount from public.rate_card_line
   where rate_card_id = (select (v ->> 'rate_card_id')::uuid from t where k = 'summer') and key = 'fillets'),
  1.95::numeric, 'a new season card copies the default card''s rates');
select is(
  (select count(*)::int from public.rate_card_line
   where rate_card_id = (select (v ->> 'rate_card_id')::uuid from t where k = 'summer')),
  6, 'and carries every rate key');

select throws_ok(
  $$ select public.admin_create_rate_card('rc-overlap-1', 'Late summer', '2027-09-01', null) $$,
  '23P01', null, 'one active card per date: overlapping dates rejected');
select throws_ok(
  $$ select public.admin_create_rate_card('rc-nodate-01', 'Undated', null, null) $$,
  '22023', null, 'a season card needs a start date');
select throws_ok(
  $$ select public.admin_update_rate_card('rc-def-dates', (select id from public.rate_card where is_default),
       'Default rates', '2027-01-01', null) $$,
  '22023', null, 'the default card stays undated');
select throws_ok(
  $$ select public.admin_set_rate_card_lines('rc-badkey-01', (select id from public.rate_card where is_default),
       '[{"key": "fresh", "amount": 1}]') $$,
  '22023', null, 'the virtual fresh method has no rate (it splits to fillets + portions)');
select throws_ok(
  $$ select public.admin_set_rate_card_lines('rc-neg-0001', (select id from public.rate_card where is_default),
       '[{"key": "fillets", "amount": -1}]') $$,
  '22023', null, 'negative rates rejected');
select throws_ok(
  $$ select public.admin_set_rate_card_lines('rc-dup-0001', (select id from public.rate_card where is_default),
       '[{"key": "fillets", "amount": 1}, {"key": "fillets", "amount": 2}]') $$,
  '22023', null, 'a key listed twice is rejected');
select throws_ok(
  $$ select public.admin_delete_rate_card('rc-del-def01', (select id from public.rate_card where is_default)) $$,
  '23514', null, 'the default card cannot be deleted');

reset role;
insert into public.customer (id, org_id, name) values
  ('c2200000-0000-4000-8000-0000000000c1', (select v #>> '{}' from t where k = 'org')::uuid, 'Angler');
insert into public.intake (org_id, number, customer_id, rate_card_id) values
  ((select v #>> '{}' from t where k = 'org')::uuid, 'INT-0001', 'c2200000-0000-4000-8000-0000000000c1',
   (select (v ->> 'rate_card_id')::uuid from t where k = 'summer'));
set local role authenticated;
select throws_ok(
  $$ select public.admin_delete_rate_card('rc-del-used1', (select (v ->> 'rate_card_id')::uuid from t where k = 'summer')) $$,
  '23503', null, 'a card intakes were priced with cannot be deleted');
insert into t select 'spring', public.admin_create_rate_card('rc-create-02', 'Spring 2027', '2027-03-01', '2027-04-30');
select lives_ok(
  $$ select public.admin_delete_rate_card('rc-del-ok-01', (select (v ->> 'rate_card_id')::uuid from t where k = 'spring')) $$,
  'an unused season card can be deleted');

-- Species / methods ---------------------------------------------------------------------------
select lives_ok(
  $$ select public.admin_update_species('sp-upd-00001', (select id from public.species where code = 'whitefish_halibut'),
       'Pacific halibut', 'HAL', 5, false) $$,
  'manager edits a species and deactivates it');
reset role;
select is((select name || '|' || is_active || '|' || sort from public.species
           where code = 'whitefish_halibut' and org_id = (select v #>> '{}' from t where k = 'org')::uuid),
  'Pacific halibut|false|5', 'species changes stored');
set local role authenticated;
select throws_ok(
  $$ select public.admin_update_species('sp-upd-bad01', (select id from public.species where code = 'salmon_reds'),
       'Reds', 'too long code', 10, true) $$,
  '22023', null, 'tote-tag shorthand is validated');
select lives_ok(
  $$ select public.admin_update_processing_method('pm-upd-00001',
       (select id from public.processing_method where code = 'head_off'), 'Head off', true, false) $$,
  'a manager activates head_off and makes it non-cappable');
reset role;
select is((select is_active || '|' || lodge_cappable from public.processing_method
           where code = 'head_off' and org_id = (select v #>> '{}' from t where k = 'org')::uuid),
  'true|false', 'method toggles stored');

-- Another org cannot touch these rows ---------------------------------------------------------
select pg_temp.as_user('c2200000-0000-4000-8000-0000000000a1', 'c2200000-0000-4000-8000-00000000000e', 'owner');
set local role authenticated;
select throws_ok(
  $$ select public.admin_update_species('sp-cross-001',
       (select id from public.species where code = 'salmon_reds' limit 1), 'X', null, 1, true) $$,
  'P0002', null, 'species of another org are not found');

-- Stripe Billing: only the service role writes billing state ------------------------------------
select throws_ok(
  $$ select public.billing_apply_subscription('evt_x', now(), 'customer.subscription.updated', 'cus_x', 'sub_x', 'active', 'enterprise') $$,
  '42501', null, 'an org owner cannot set their own plan');
select throws_ok(
  $$ select public.billing_link_customer((select v #>> '{}' from t where k = 'org')::uuid, 'cus_x') $$,
  '42501', null, 'clients cannot link a Stripe customer');
reset role;

select pg_temp.as_service();
set local role service_role;
select is(public.billing_link_customer((select v #>> '{}' from t where k = 'org')::uuid, 'cus_wp22_a'),
  'cus_wp22_a', 'the first customer is linked');
select is(public.billing_link_customer((select v #>> '{}' from t where k = 'org')::uuid, 'cus_wp22_b'),
  'cus_wp22_a', 'a second (racing) customer gets the first one back');

select is(
  public.billing_apply_subscription('evt_unknown', '2027-01-01T00:00:00Z', 'customer.subscription.created',
    'cus_nobody', 'sub_n', 'active', 'plant') ->> 'reason',
  'unknown_customer', 'an event for an unknown customer is ignored');

select is(
  public.billing_apply_subscription('evt_1', '2027-01-01T10:00:00Z', 'customer.subscription.created',
    'cus_wp22_a', 'sub_1', 'active', 'plant') ->> 'applied',
  'true', 'subscription created → plan applied');
select is((select plan || '|' || subscription_status || '|' || stripe_subscription_id from public.org where slug = 'kenai-fish'),
  'plant|active|sub_1', 'webhook updates org.plan');
select is(
  public.billing_apply_subscription('evt_1', '2027-01-01T10:00:00Z', 'customer.subscription.created',
    'cus_wp22_a', 'sub_1', 'active', 'plant') ->> 'reason',
  'duplicate', 'a redelivered event is a no-op');

select is(
  public.billing_apply_subscription('evt_2', '2027-01-02T10:00:00Z', 'customer.subscription.updated',
    'cus_wp22_a', 'sub_1', 'active', 'multi-site') ->> 'applied',
  'true', 'upgrade applied');
select is(
  public.billing_apply_subscription('evt_late', '2027-01-01T12:00:00Z', 'customer.subscription.updated',
    'cus_wp22_a', 'sub_1', 'active', 'starter') ->> 'reason',
  'stale', 'an older event delivered late does not roll the plan back');
select is((select plan from public.org where slug = 'kenai-fish'), 'multi-site', 'plan unchanged by the stale event');

select is(
  public.billing_apply_subscription('evt_old_sub', '2027-01-03T10:00:00Z', 'customer.subscription.deleted',
    'cus_wp22_a', 'sub_0', 'canceled', null) ->> 'reason',
  'other_subscription', 'cancelling a superseded subscription does not clear the current plan');

select is(
  public.billing_apply_subscription('evt_3', '2027-01-04T10:00:00Z', 'customer.subscription.deleted',
    'cus_wp22_a', 'sub_1', 'canceled', null) ->> 'applied',
  'true', 'subscription deleted → applied');
select is((select coalesce(plan, 'none') || '|' || subscription_status from public.org where slug = 'kenai-fish'),
  'none|canceled', 'plan cleared when the subscription ends');

-- One transaction: every event has the same created_at, so compare without order.
select is(
  (select array_agg(coalesce(payload ->> 'plan', 'none') order by coalesce(payload ->> 'plan', 'none'))
   from public.domain_event
   where kind = 'org_plan_changed' and org_id = (select v #>> '{}' from t where k = 'org')::uuid),
  array['multi-site', 'none', 'plant'], 'one org_plan_changed event per real change (none for stale/duplicate)');
select is(
  (select array_agg(stripe_event_id || ':' || applied || ':' || coalesce(reason, '-') order by event_created_at)
   from public.billing_event where org_id = (select v #>> '{}' from t where k = 'org')::uuid),
  array['evt_1:true:-', 'evt_late:false:stale', 'evt_2:true:-', 'evt_old_sub:false:other_subscription', 'evt_3:true:-'],
  'every delivered event is recorded once with its outcome');

-- The metadata org hint links a customer created outside create_org's checkout path.
select is(
  public.billing_apply_subscription('evt_hint', '2027-01-05T10:00:00Z', 'customer.subscription.created',
    'cus_existing', 'sub_e', 'trialing', 'starter', 'c2200000-0000-4000-8000-00000000000e') ->> 'applied',
  'true', 'an org without a customer is found by the subscription metadata org_id');
select is((select stripe_customer_id || '|' || plan from public.org where id = 'c2200000-0000-4000-8000-00000000000e'),
  'cus_existing|starter', 'and its customer is linked');
select is(
  public.billing_apply_subscription('evt_hijack', '2027-01-05T11:00:00Z', 'customer.subscription.created',
    'cus_attacker', 'sub_h', 'active', 'enterprise', 'c2200000-0000-4000-8000-00000000000e') ->> 'reason',
  'unknown_customer', 'the hint never re-points an org that already has a customer');
reset role;

-- Members read billing state; they cannot see other orgs' billing events.
select pg_temp.as_owner();
set local role authenticated;
select is((select count(*)::int from public.billing_event), 5, 'members see their own billing events');
select is((select plan_changed_at is not null from public.org), true, 'members read plan state on org');
reset role;

select * from finish();
rollback;
