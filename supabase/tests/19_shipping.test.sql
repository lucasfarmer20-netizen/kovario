-- WP-19 shipping: shipments from ship boxes and walk-ins, address check / rates / labels recorded
-- by the route handlers' service role only, the I13 / I13b / I14 buy gate (P10, P11, P12, P23),
-- the purchase claim, label print jobs and reprint (P24), mark shipped, tracking, cancel, the
-- queue, cold-chain box sizes, ship-from, Vault key, tenancy. Shippo itself is exercised in
-- packages/shipping (recorded fixtures) and apps/web/lib/shipping (route flow).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a1900000-0000-4000-8000-0000000000f1', 'staff-ship@test.filletry'),
  ('a1900000-0000-4000-8000-0000000000f2', 'manager-ship@test.filletry');
insert into public.org (id, slug, name, timezone) values
  ('a1900000-0000-4000-8000-00000000000a', 'ship-a', 'Ship A', 'UTC'),
  ('b1900000-0000-4000-8000-00000000000b', 'ship-b', 'Ship B', 'UTC');
insert into public.org_member (id, org_id, user_id, role, display_name) values
  ('a1900000-0000-4000-8000-0000000003a1', 'a1900000-0000-4000-8000-00000000000a',
   'a1900000-0000-4000-8000-0000000000f2', 'manager', 'Mia Manager');
insert into public.site (id, org_id, name, is_default) values
  ('a1900000-0000-4000-8000-0000000000a5', 'a1900000-0000-4000-8000-00000000000a', 'Dock', true);
insert into public.customer (id, org_id, name, phone) values
  ('a1900000-0000-4000-8000-0000000002a1', 'a1900000-0000-4000-8000-00000000000a', 'Pat Party', '+19075551901'),
  ('b1900000-0000-4000-8000-0000000002b1', 'b1900000-0000-4000-8000-00000000000b', 'Other Org', '+19075551902');
insert into public.box_size (id, org_id, name, max_lb, fee, dims) values
  ('a1900000-0000-4000-8000-0000000005a1', 'a1900000-0000-4000-8000-00000000000a', 'Medium', 50, 12.50,
   '{"length_in": 20, "width_in": 14, "height_in": 12, "packaging_lb": 2.5, "dry_ice_lb": 10}');
insert into public.allocation_session (id, org_id, number, state) values
  ('a1900000-0000-4000-8000-000000000051', 'a1900000-0000-4000-8000-00000000000a', 'ALC-0001', 'priced');
insert into public.settlement (id, org_id, number, session_id, angler_name, customer_id) values
  ('a1900000-0000-4000-8000-000000000061', 'a1900000-0000-4000-8000-00000000000a', 'STL-0001',
   'a1900000-0000-4000-8000-000000000051', 'Ann', 'a1900000-0000-4000-8000-0000000002a1'),
  ('a1900000-0000-4000-8000-000000000062', 'a1900000-0000-4000-8000-00000000000a', 'STL-0002',
   'a1900000-0000-4000-8000-000000000051', 'Bo', null);
-- Ann: BOX-0001/0002 ship, BOX-0003 will-call. Bo: BOX-0004/0005/0006 ship.
insert into public.box_plan (id, org_id, number, settlement_id, session_id, method, box_size_id, weight_lb) values
  ('a1900000-0000-4000-8000-000000000071', 'a1900000-0000-4000-8000-00000000000a', 'BOX-0001',
   'a1900000-0000-4000-8000-000000000061', 'a1900000-0000-4000-8000-000000000051', 'ship',
   'a1900000-0000-4000-8000-0000000005a1', 40),
  ('a1900000-0000-4000-8000-000000000072', 'a1900000-0000-4000-8000-00000000000a', 'BOX-0002',
   'a1900000-0000-4000-8000-000000000061', 'a1900000-0000-4000-8000-000000000051', 'ship',
   'a1900000-0000-4000-8000-0000000005a1', 35.5),
  ('a1900000-0000-4000-8000-000000000073', 'a1900000-0000-4000-8000-00000000000a', 'BOX-0003',
   'a1900000-0000-4000-8000-000000000061', 'a1900000-0000-4000-8000-000000000051', 'willcall',
   'a1900000-0000-4000-8000-0000000005a1', 20),
  ('a1900000-0000-4000-8000-000000000074', 'a1900000-0000-4000-8000-00000000000a', 'BOX-0004',
   'a1900000-0000-4000-8000-000000000062', 'a1900000-0000-4000-8000-000000000051', 'ship',
   'a1900000-0000-4000-8000-0000000005a1', 30),
  ('a1900000-0000-4000-8000-000000000075', 'a1900000-0000-4000-8000-00000000000a', 'BOX-0005',
   'a1900000-0000-4000-8000-000000000062', 'a1900000-0000-4000-8000-000000000051', 'ship',
   'a1900000-0000-4000-8000-0000000005a1', 30),
  ('a1900000-0000-4000-8000-000000000076', 'a1900000-0000-4000-8000-00000000000a', 'BOX-0006',
   'a1900000-0000-4000-8000-000000000062', 'a1900000-0000-4000-8000-000000000051', 'ship',
   'a1900000-0000-4000-8000-0000000005a1', 30);
insert into public.printer (id, org_id, name, site_id, kind, is_default_for) values
  ('a1900000-0000-4000-8000-0000000003b2', 'a1900000-0000-4000-8000-00000000000a', 'Ship Zebra',
   'a1900000-0000-4000-8000-0000000000a5', 'label_zpl', '{"shipping_label": true}');
-- A live manager elevation for the staff user (Buy Now / cancel a bought label).
insert into public.elevation_grant (org_id, requested_by, manager_member_id, token_hash, expires_at) values
  ('a1900000-0000-4000-8000-00000000000a', 'a1900000-0000-4000-8000-0000000000f1',
   'a1900000-0000-4000-8000-0000000003a1', app.sha256_hex('wp19-elevation'), now() + interval '5 minutes');
select vault.create_secret('shippo_test_placeholder_not_a_key', 'shippo_api_key:a1900000-0000-4000-8000-00000000000a');

create temp table t_ids (k text primary key, v text) on commit drop;
grant all on t_ids to authenticated, service_role;

create function pg_temp.as_role(p_org text, p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a1900000-0000-4000-8000-0000000000f1', 'role', 'authenticated',
    'org_id', p_org, 'app_role', p_role)::text, true);
$$;
create function pg_temp.id(p_k text) returns uuid language sql as $$
  select v::uuid from t_ids where k = p_k;
$$;
create function pg_temp.addr() returns jsonb language sql as $$
  select '{"name": "Ann Angler", "street1": "1200 W Dimond Blvd", "city": "Anchorage", "state": "ak", "zip": "99515"}'::jsonb;
$$;
create function pg_temp.sh(p_k text) returns public.shipment language sql as $$
  select * from public.shipment where id = pg_temp.id(p_k);
$$;
-- Two labels in the shape packages/shipping buyLabels returns.
create function pg_temp.labels(p_prefix text, p_n int) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('parcelIndex', i, 'transactionId', p_prefix || '_txn_' || i,
    'trackingNumber', '1Z' || p_prefix || i, 'labelUrl', 'https://deliver.goshippo.com/' || p_prefix || i || '.zpl',
    'zpl', '^XA^FD' || p_prefix || i || '^FS^XZ') order by i)
  from generate_series(0, p_n - 1) i;
$$;
create function pg_temp.shop(p_rate text) returns jsonb language sql as $$
  select jsonb_build_object('shippoShipmentId', 'shp_' || p_rate, 'attempts', 1, 'missingCarriers', '[]'::jsonb,
    'carrierMessages', '[]'::jsonb, 'rates', jsonb_build_array(
      jsonb_build_object('rateId', p_rate, 'carrier', 'ups', 'provider', 'UPS', 'service', '2nd Day Air',
        'serviceToken', 'ups_second_day_air', 'amount', 121.75, 'currency', 'USD', 'estimatedDays', 2),
      jsonb_build_object('rateId', p_rate || '_b', 'carrier', 'usps', 'provider', 'USPS', 'service', 'Priority Mail',
        'serviceToken', 'usps_priority', 'amount', 64.10, 'currency', 'USD', 'estimatedDays', 2)));
$$;
create function pg_temp.claim(p_k text) returns uuid language sql as $$
  select buy_claim_id from public.shipment where id = pg_temp.id(p_k);
$$;
grant execute on function pg_temp.claim(text) to authenticated, service_role;
grant execute on function pg_temp.as_role(text, text), pg_temp.id(text), pg_temp.addr(), pg_temp.sh(text),
  pg_temp.labels(text, int), pg_temp.shop(text) to authenticated, service_role;

-- Cold-chain box sizes and ship-from (admin) -----------------------------------------------------

set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'manager');
select lives_ok($$select public.admin_save_box_size('wp19-size-1', null, 'Large', 90, 15,
  '{"length_in": 24, "width_in": 16, "height_in": 14, "packaging_lb": 3, "dry_ice_lb": 0}', true)$$,
  'COLDCHAIN — a box size carries packaging_lb and dry_ice_lb');
select throws_like($$select public.admin_save_box_size('wp19-size-2', null, 'Bad', 90, 15,
  '{"dry_ice_lb": -1}', true)$$, '%dims%', 'COLDCHAIN — cold-chain weights are 0 or more');
select throws_like($$select public.admin_save_box_size('wp19-size-3', null, 'Bad2', 90, 15,
  '{"length_in": 0}', true)$$, '%dims%', 'COLDCHAIN — L/W/H stay above 0');
select throws_like($$select public.admin_set_ship_from('wp19-from-0', 'a1900000-0000-4000-8000-0000000000a5',
  '{"name": "Plant"}')$$, '%ship-from needs%', 'SHIPFROM — a ship-from address must be complete');
select is(public.admin_set_ship_from('wp19-from-1', 'a1900000-0000-4000-8000-0000000000a5',
  '{"name": "Kenai Plant", "street1": "1 Dock Rd", "city": "Kenai", "state": "ak", "zip": "99611"}') #>> '{ship_from,state}',
  'AK', 'SHIPFROM — manager sets the site''s ship-from (cleaned)');
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select throws_ok($$select public.admin_set_ship_from('wp19-from-2', 'a1900000-0000-4000-8000-0000000000a5', null)$$,
  '42501', null, 'SHIPFROM — staff cannot change it');

-- Create ---------------------------------------------------------------------------------------

insert into t_ids select 'ann', public.create_shipment('wp19-create-1',
  array['a1900000-0000-4000-8000-000000000072', 'a1900000-0000-4000-8000-000000000071']::uuid[],
  pg_temp.addr(), current_date) ->> 'shipment_id';
select is((select format('%s:%s:%s:%s:%s', number, state, customer_id, ship_to ->> 'state', blockers)
           from public.shipment where id = pg_temp.id('ann')),
  'SHP-0001:draft:a1900000-0000-4000-8000-0000000002a1:AK:["address_unverified"]',
  'CREATE — a draft SHP- for the angler''s ship boxes, address cleaned and unverified');
select is((select array_agg(format('%s:%s', p.seq, b.number) order by p.seq) from public.shipment_parcel p
           join public.box_plan b on b.id = p.box_plan_id where p.shipment_id = pg_temp.id('ann')),
  array['0:BOX-0001', '1:BOX-0002'], 'CREATE — one parcel per box, in box order');
select is((select count(*)::int from public.box_plan where shipment_id = pg_temp.id('ann')), 2,
  'CREATE — the boxes point at the shipment');
select is(public.create_shipment('wp19-create-1', '{}'::uuid[], '{}', null) ->> 'shipment_id',
  pg_temp.id('ann')::text, 'REPLAY — the same client_action_id returns the stored shipment');
select is((public.shipment_detail(pg_temp.id('ann')) -> 'parcels' -> 0 -> 'dims' ->> 'dry_ice_lb')::numeric, 10::numeric,
  'COLDCHAIN — a box parcel reads its size''s cold-chain weights live (gross rule: packages/shipping boxParcel)');
select throws_like($$select public.create_shipment('wp19-create-2',
  array['a1900000-0000-4000-8000-000000000071']::uuid[], '{}', null)$$,
  '%already in shipment SHP-0001%', 'CREATE — a box is in one live shipment at a time');
select throws_like($$select public.create_shipment('wp19-create-3',
  array['a1900000-0000-4000-8000-000000000073']::uuid[], '{}', null)$$,
  '%not a ship box%', 'CREATE — only ship boxes');
select throws_like($$select public.create_shipment('wp19-create-4',
  array['a1900000-0000-4000-8000-000000000074', 'a1900000-0000-4000-8000-000000000076',
        'a1900000-0000-4000-8000-000000000072']::uuid[], '{}', null)$$,
  '%already in shipment%', 'CREATE — a mixed pick fails whole (no partial shipment)');
select throws_like($$select public.create_shipment('wp19-create-5', array[]::uuid[], '{}', null)$$,
  '%at least one%', 'CREATE — needs a box');
select throws_like($$select public.create_shipment('wp19-create-6',
  array['a1900000-0000-4000-8000-000000000074']::uuid[], '{"street3": "x"}', null)$$,
  '%unknown address field%', 'CREATE — address keys are checked');

-- Walk-in --------------------------------------------------------------------------------------

insert into t_ids select 'walkin', public.create_walkin_shipment('wp19-walkin-1',
  'a1900000-0000-4000-8000-0000000002a1', pg_temp.addr(), current_date,
  '[{"length_in": 12, "width_in": 12, "height_in": 10, "weight_lb": 22.5, "dry_ice_lb": 5}]') ->> 'shipment_id';
select is((select format('%s:%s:%s', is_walkin, cardinality(box_plan_ids),
                         (select format('%s/%s', weight_lb, dry_ice_lb) from public.shipment_parcel
                          where shipment_id = s.id))
           from public.shipment s where id = pg_temp.id('walkin')),
  't:0:22.50/5.00', 'WALKIN — a walk-in shipment carries its own gross parcels, no boxes');
select throws_like($$select public.create_walkin_shipment('wp19-walkin-2', null, '{}', null,
  '[{"length_in": 12, "width_in": 0, "height_in": 10, "weight_lb": 5}]')$$,
  '%each parcel needs%', 'WALKIN — parcels need positive dims and weight');
select throws_like($$select public.create_walkin_shipment('wp19-walkin-3', null, '{}', null, '[]')$$,
  '%1 to 20 parcels%', 'WALKIN — at least one parcel');

-- Provider results are service-role only --------------------------------------------------------

select throws_ok($$select public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  gen_random_uuid(), 'rate_x', pg_temp.labels('fake', 2))$$, '42501', null,
  'SERVICEONLY — a browser session cannot record a bought label');
select throws_ok($$select public.shipping_start_purchase('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  gen_random_uuid())$$, '42501', null,
  'SERVICEONLY — nor grant itself permission to buy (start a purchase)');
select throws_ok($$select public.shipping_record_address('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  pg_temp.addr(), true, pg_temp.addr(), '[]')$$, '42501', null,
  'SERVICEONLY — nor an address check');
select throws_ok($$select public.shipping_api_key('a1900000-0000-4000-8000-00000000000a')$$, '42501', null,
  'VAULT — a browser session cannot read the Shippo key');

-- Address check + rates (route handlers, service role) ------------------------------------------

reset role;
set local role service_role;
select is(public.shipping_api_key('a1900000-0000-4000-8000-00000000000a'), 'shippo_test_placeholder_not_a_key',
  'VAULT — the route reads the org''s key by name shippo_api_key:<org id>');
select is(public.shipping_api_key('b1900000-0000-4000-8000-00000000000b'), null,
  'VAULT — no secret = shipping not configured');
select is(public.shipping_record_address('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  '{"name": "stale"}', true, '{}', '[]') ->> 'stale', 'true',
  'ADDRESS — a check of an address that has since changed is ignored');
select is((public.shipping_record_address('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  (pg_temp.sh('ann')).ship_to, false, null, '["The address as submitted could not be found."]')
  -> 'shipment' -> 'blockers'), '["bad_address"]'::jsonb,
  'ADDRESS — an invalid address becomes the bad_address blocker');
select is((public.shipping_record_address('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  (pg_temp.sh('ann')).ship_to, true,
  '{"name": "Ann Angler", "street1": "1200 W DIMOND BLVD", "city": "ANCHORAGE", "state": "AK", "zip": "99515-1234", "country": "US"}',
  '[]') -> 'shipment' ->> 'ship_to')::jsonb ->> 'zip', '99515-1234',
  'ADDRESS — a valid check stores the carrier-normalised address');
select is((pg_temp.sh('ann')).blockers, '[]'::jsonb, 'ADDRESS — and clears the address blockers');
select is(public.shipping_record_rates('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'),
  (pg_temp.sh('ann')).ship_to, pg_temp.shop('rate_a1')) #>> '{shipment,shippo_shipment_id}', 'shp_rate_a1',
  'RATES — a rate shop is stored with its Shippo shipment');

reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select is((public.shipment_detail(pg_temp.id('ann')) -> 'gate'),
  '{"held": false, "blockers": ["no_service"], "can_buy": false, "can_reprint": false}'::jsonb,
  'GATE — no rate chosen yet is the no_service blocker');
select throws_like($$select public.select_shipment_rate('wp19-rate-0', pg_temp.id('ann'), 'rate_from_rate_check')$$,
  '%not one of%', 'RATES — only a rate from the shipment''s own (allowlisted) shop can be chosen');
select is(public.select_shipment_rate('wp19-rate-1', pg_temp.id('ann'), 'rate_a1') ->> 'service', '2nd Day Air',
  'RATES — choosing a rate sets carrier / service / amount');
select is((select format('%s:%s:%s', carrier, rate_amount, shippo_rate_id) from public.shipment where id = pg_temp.id('ann')),
  'ups:121.75:rate_a1', 'RATES — the chosen rate is stored');

-- I13 / I13b / I14 buy gate ---------------------------------------------------------------------

-- Ann's shipment ships today: buyable. Bo's ships in 5 days: held (P10).
insert into t_ids select 'bo', public.create_shipment('wp19-create-bo',
  array['a1900000-0000-4000-8000-000000000074', 'a1900000-0000-4000-8000-000000000075']::uuid[],
  pg_temp.addr(), current_date + 5) ->> 'shipment_id';
select is((pg_temp.sh('bo')).state::text, 'held', 'P10 — a ship date past today + window parks the shipment held');
reset role;
set local role service_role;
select public.shipping_record_rates('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'),
  (pg_temp.sh('bo')).ship_to, pg_temp.shop('rate_b1'));
reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select public.select_shipment_rate('wp19-rate-bo', pg_temp.id('bo'), 'rate_b1');

select is(public.begin_label_buy('wp19-buy-bo-1', pg_temp.id('bo')) - 'gate' - 'shipment_id',
  '{"ok": false, "held": true, "number": "SHP-0003", "blockers": ["address_unverified"]}'::jsonb,
  'P11 / I13b — held AND a real blocker (unverified address) are reported together');
select is((pg_temp.sh('bo')).buy_claimed_at, null, 'P10 — a held buy claims nothing and buys nothing');
select throws_ok($$select public.begin_label_buy('wp19-buy-bo-2', pg_temp.id('bo'), true, 'not-a-token')$$,
  '42501', null, 'I14 — Buy Now needs a live manager elevation');
select is(public.begin_label_buy('wp19-buy-bo-3', pg_temp.id('bo'), true, 'wp19-elevation') - 'gate' - 'shipment_id',
  '{"ok": false, "held": false, "number": "SHP-0003", "blockers": ["address_unverified"]}'::jsonb,
  'P12 / I14 — Buy Now lifts the date hold but preserves every non-date blocker');

reset role;
set local role service_role;
select public.shipping_record_address('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'),
  (pg_temp.sh('bo')).ship_to, true, (pg_temp.sh('bo')).ship_to, '[]');
reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select is(public.begin_label_buy('wp19-buy-bo-4', pg_temp.id('bo')) ->> 'held', 'true',
  'P10 — with no blockers left a held shipment is still held without Buy Now');
select is(public.begin_label_buy('wp19-buy-bo-5', pg_temp.id('bo'), true, 'wp19-elevation') - 'gate' - 'shipment_id' - 'claim_id',
  '{"ok": true, "held": false, "forced": true, "number": "SHP-0003", "rate_id": "rate_b1", "blockers": [], "parcel_count": 2, "shippo_shipment_id": "shp_rate_b1"}'::jsonb,
  'P12 / I14 — manager Buy Now buys a held label early once nothing else blocks it');
select ok((pg_temp.sh('bo')).notes like '%Buy Now: held label bought early by manager Mia Manager%',
  'I14 — the early buy is noted with the manager');
select throws_like($$select public.begin_label_buy('wp19-buy-bo-6', pg_temp.id('bo'), true, 'wp19-elevation')$$,
  '%already in progress%', 'CLAIM — a second concurrent buy is refused while the first is in flight');
select throws_like($$select public.update_shipment('wp19-upd-bo', pg_temp.id('bo'), pg_temp.addr(), current_date)$$,
  '%in progress%', 'CLAIM — nor can the address change under an in-flight buy');
select throws_like($$select public.select_shipment_rate('wp19-rate-bo-2', pg_temp.id('bo'), 'rate_b1_b')$$,
  '%in progress%', 'CLAIM — nor the chosen rate');

-- P23: no ship date blocks the buy, even under Buy Now.
insert into t_ids select 'nodate', public.create_walkin_shipment('wp19-walkin-nodate', null, pg_temp.addr(), null,
  '[{"length_in": 10, "width_in": 10, "height_in": 10, "weight_lb": 10}]') ->> 'shipment_id';
select is(public.begin_label_buy('wp19-buy-nodate', pg_temp.id('nodate'), true, 'wp19-elevation') -> 'blockers',
  '["address_unverified", "missing_ship_date", "no_service"]'::jsonb,
  'P23 — a missing ship date is a blocker (alongside the others) that Buy Now does not lift');

-- Labels (route, service role) -----------------------------------------------------------------

select is(public.begin_label_buy('wp19-buy-ann-1', pg_temp.id('ann')) ->> 'ok', 'true',
  'I13 — ship date today: the buy is claimed');
select is(public.begin_label_buy('wp19-buy-ann-1', pg_temp.id('ann')) ->> 'replayed', 'true',
  'REPLAY — a replayed buy returns its stored claim, marked replayed (a claim, not permission to pay)');
reset role;
set local role service_role;
select is(public.shipping_start_purchase('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), pg_temp.claim('ann')) ->> 'rate_id', 'rate_a1',
  'PURCHASE — the route consumes the claim once before calling Shippo');
select throws_like($$select public.shipping_start_purchase('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), pg_temp.claim('ann'))$$,
  '%has already started%',
  'PURCHASE — a second request with the same claim (replayed or concurrent identical action id) cannot start another purchase');
select throws_like($$select public.shipping_start_purchase('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), gen_random_uuid())$$,
  '%no longer current%', 'PURCHASE — nor can a claim the shipment did not issue');
select throws_like($$select public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), gen_random_uuid(),
  'rate_a1', pg_temp.labels('ann', 2))$$, '%no longer current%',
  'PURCHASE — labels are recorded only against the claim that started the purchase');
select is((public.shipping_buy_failed('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), gen_random_uuid(), 'stale handler', null) ->> 'buying')::boolean,
  true, 'PURCHASE — a stale handler''s failure report cannot clear the live claim');
select throws_like($$select public.shipping_record_rates('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), (pg_temp.sh('ann')).ship_to,
  pg_temp.shop('rate_new'))$$, '%not recorded yet%',
  'PIN — a rate shop answering during the purchase cannot replace or clear the rate being paid for');
select is((public.shipping_record_address('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), (pg_temp.sh('ann')).ship_to, true,
  '{"name": "X", "street1": "9 Other St", "city": "Kenai", "state": "AK", "zip": "99611"}', '[]') ->> 'stale')::boolean,
  true, 'PIN — nor can an address check answering during the purchase (it would clear the rate)');
select throws_like($$select public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), pg_temp.claim('ann'),
  'rate_a1', pg_temp.labels('ann', 1))$$, '%every parcel needs its label%',
  'LABELS — a two-parcel shipment is never recorded with one label (fetch every label)');
select throws_like($$select public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), pg_temp.claim('ann'),
  'rate_other', pg_temp.labels('ann', 2))$$, '%labels are for rate%',
  'LABELS — labels must be for the chosen rate');
select is(public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), pg_temp.claim('ann'),
  'rate_a1', pg_temp.labels('ann', 2)) ->> 'state', 'label_bought', 'LABELS — every parcel labelled → label_bought');
select is((select array_agg(format('%s:%s:%s', seq, tracking_number, label_zpl is not null) order by seq)
           from public.shipment_parcel where shipment_id = pg_temp.id('ann')),
  array['0:1Zann0:t', '1:1Zann1:t'], 'LABELS — each parcel has its own tracking number and stored ZPL');
select is((select format('%s:%s', tracking_number, buy_claim_id is null) from public.shipment where id = pg_temp.id('ann')),
  '1Zann0:t', 'LABELS — the master tracking number is the first parcel''s; the claim is released');
select is(public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('ann'), null,
  'rate_a1', pg_temp.labels('ann', 2)) ->> 'state', 'label_bought', 'LABELS — recording the same purchase twice is a no-op');

-- Bo's forced buy starts, then fails at Shippo: the claim clears, the reason is kept, and the
-- possibly-spent purchase is noted (S6).
select is(public.shipping_start_purchase('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'), pg_temp.claim('bo')) ->> 'rate_id', 'rate_b1',
  'PURCHASE — a Buy Now claim re-checks the gate with its forced flag');
select is(public.shipping_buy_failed('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'), pg_temp.claim('bo'),
  'only 1 of 2 labels are ready at Shippo', true) ->> 'buy_error', 'only 1 of 2 labels are ready at Shippo',
  'CLAIM — a failed buy releases the claim and keeps the reason');
select ok((pg_temp.sh('bo')).notes like '%was charged by Shippo but not recorded%press Buy to fetch the labels%',
  'CLAIM — a purchase Shippo charged but that was not recorded is noted for the desk');
select is((pg_temp.sh('bo')).buy_outstanding_rate_id, 'rate_b1',
  'PIN — after a charged failure the paid rate stays pinned (the claim is gone)');
select throws_like($$select public.shipping_record_rates('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'), (pg_temp.sh('bo')).ship_to,
  pg_temp.shop('rate_new'))$$, '%not recorded yet%', 'PIN — a re-shop cannot replace the pinned rate');
reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select throws_like($$select public.select_shipment_rate('wp19-rate-bo-3', pg_temp.id('bo'), 'rate_b1_b')$$,
  '%not recorded yet%', 'PIN — another desk cannot choose a different rate over a paid one');
select throws_like($$select public.update_shipment('wp19-upd-bo-2', pg_temp.id('bo'), pg_temp.addr(), current_date + 1)$$,
  '%not recorded yet%', 'PIN — nor edit the shipment (an address change would clear the rate)');
select is(public.shipment_detail(pg_temp.id('bo')) ->> 'shippo_rate_id', 'rate_b1', 'PIN — the paid rate is unchanged');
-- The next Buy recovers on the SAME rate (and Shippo adopts the paid transaction — route test).
select is(public.begin_label_buy('wp19-buy-bo-7', pg_temp.id('bo'), true, 'wp19-elevation') ->> 'rate_id', 'rate_b1',
  'PIN — the next Buy claims the pinned rate');
reset role;
set local role service_role;
select public.shipping_buy_failed('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'), pg_temp.claim('bo'), 'Shippo unreachable', null);
select is((pg_temp.sh('bo')).buy_outstanding_rate_id, 'rate_b1',
  'PIN — an unstarted claim failing with an unknown outcome keeps the pin');
-- …the desk gives up and cancels; the original request is then replayed: refused before any money moves.
reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select throws_ok($$select public.cancel_shipment('wp19-cancel-bo', pg_temp.id('bo'), 'customer changed mind')$$,
  '42501', null, 'PIN — cancelling over an unrecorded purchase needs a manager');
select is(public.cancel_shipment('wp19-cancel-bo-2', pg_temp.id('bo'), 'customer changed mind', 'wp19-elevation') ->> 'state',
  'cancelled', 'CANCEL — a manager cancels it');
select ok((pg_temp.sh('bo')).notes like '%unrecorded purchase on rate rate_b1: check Shippo and refund%',
  'CANCEL — the possible charge is noted for a refund');
select is(public.begin_label_buy('wp19-buy-bo-5', pg_temp.id('bo'), true, 'wp19-elevation') ->> 'replayed', 'true',
  'REPLAY — the failed buy''s action id replays its old claim');
insert into t_ids select 'bo_old_claim', public.begin_label_buy('wp19-buy-bo-5', pg_temp.id('bo'), true,
  'wp19-elevation') ->> 'claim_id';
reset role;
set local role service_role;
select throws_like($$select public.shipping_start_purchase('a1900000-0000-4000-8000-00000000000a', pg_temp.id('bo'), pg_temp.id('bo_old_claim'))$$,
  '%no longer current%',
  'REPLAY — replaying a buy after it failed and the shipment was cancelled can never start a purchase');

-- A failure where Shippo confirms nothing was bought unpins the rate.
reset role;
update public.shipment set shippo_rate_id = 'rate_n', buy_claim_id = 'a1900000-0000-4000-8000-00000000c1a2',
  buy_claimed_at = now(), buy_purchase_started_at = now(), buy_outstanding_rate_id = 'rate_n'
where id = pg_temp.id('nodate');
set local role service_role;
select is(public.shipping_buy_failed('a1900000-0000-4000-8000-00000000000a', pg_temp.id('nodate'), 'a1900000-0000-4000-8000-00000000c1a2',
  'The rate has expired', false) ->> 'rate_lock', null,
  'PIN — when Shippo shows no transaction for the rate, the failure unpins it');

-- Print / reprint (P24) ------------------------------------------------------------------------

reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select throws_like($$select public.print_shipment_labels('wp19-print-0', pg_temp.id('bo'))$$,
  '%no label to print%', 'PRINT — nothing to print before a label is bought');
select is(public.print_shipment_labels('wp19-print-1', pg_temp.id('ann')) - 'shipment_id',
  '{"jobs": 2, "number": "SHP-0001", "printer_missing": false}'::jsonb,
  'PRINT — one shipping_label job per parcel');
select is((select array_agg(format('%s:%s:%s', kind, payload_type, payload) order by source ->> 'parcel_seq')
           from public.print_job where source ->> 'shipment_id' = pg_temp.id('ann')::text),
  array['shipping_label:zpl:^XA^FDann0^FS^XZ', 'shipping_label:zpl:^XA^FDann1^FS^XZ'],
  'PRINT — the jobs carry each parcel''s stored ZPL to the site''s shipping-label printer');
select is((select count(*)::int from public.box_plan where shipment_id = pg_temp.id('ann') and label_printed_at is not null), 2,
  'PRINT — the boxes record that their label printed');
-- P24: a bought label on a FUTURE-dated shipment reprints (the hold gates buying, never printing).
reset role;
update public.shipment set ship_date = current_date + 10 where id = pg_temp.id('ann');
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select is(public.print_shipment_labels('wp19-print-2', pg_temp.id('ann')) ->> 'jobs', '2',
  'P24 — reprinting an already-bought future-dated label always succeeds');
reset role;
update public.shipment set ship_date = current_date where id = pg_temp.id('ann');
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');

-- Mark shipped ---------------------------------------------------------------------------------

select throws_like($$select public.mark_shipment_shipped('wp19-ship-0', pg_temp.id('ann'))$$,
  '%release BOX-0001, BOX-0002 at boxing%', 'SHIPPED — boxes not yet released at boxing cannot ship');
reset role;
update public.box_plan set fulfillment_state = 'packed' where shipment_id = pg_temp.id('ann');
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select is(public.mark_shipment_shipped('wp19-ship-1', pg_temp.id('ann')) ->> 'state', 'shipped',
  'SHIPPED — label_bought → shipped');
select is((select array_agg(distinct fulfillment_state::text) from public.box_plan where shipment_id = pg_temp.id('ann')),
  array['shipped'], 'SHIPPED — its packed boxes become shipped');
select is((select payload ->> 'number' from public.domain_event where kind = 'shipment_shipped'
           and subject_id = pg_temp.id('ann')), 'SHP-0001', 'SHIPPED — shipment_shipped event for the email (WP-20)');
select is(public.print_shipment_labels('wp19-print-3', pg_temp.id('ann')) ->> 'jobs', '2',
  'P24 — a shipped shipment''s labels still reprint');

-- Tracking webhook (route, service role) ---------------------------------------------------------

-- The walk-in gets a label, then the carrier scans it.
reset role;
update public.shipment set blockers = '[]', shippo_rate_id = 'rate_w', service = 'Priority Mail',
  carrier = 'usps', buy_claim_id = 'a1900000-0000-4000-8000-00000000c1a1', buy_claimed_at = now(),
  buy_purchase_started_at = now() where id = pg_temp.id('walkin');
set local role service_role;
select public.shipping_record_labels('a1900000-0000-4000-8000-00000000000a', pg_temp.id('walkin'),
  'a1900000-0000-4000-8000-00000000c1a1', 'rate_w', pg_temp.labels('walk', 1));
select is(public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', null, 'no-such-number', 'TRANSIT', true, null) ->> 'matched', 'false',
  'TRACKING — an unknown tracking number is acknowledged, not an error');
-- Tenancy: an event authenticated for org B never touches org A's shipment, even carrying
-- org A's real transaction id or tracking number (printed on the box).
select is(public.shipping_apply_tracking('b1900000-0000-4000-8000-00000000000b', 'walk_txn_0', '1Zwalk0', 'TRANSIT', true, null) ->> 'matched', 'false',
  'TRACKING TENANCY — org B''s webhook cannot apply an event to org A''s parcel by transaction id');
select is(public.shipping_apply_tracking('b1900000-0000-4000-8000-00000000000b', null, '1Zwalk0', 'TRANSIT', true, null) ->> 'matched', 'false',
  'TRACKING TENANCY — nor by tracking number');
select is((pg_temp.sh('walkin')).state::text, 'label_bought', 'TRACKING TENANCY — org A''s shipment is untouched');
select throws_like($$select public.shipping_apply_tracking(null, null, '1Zwalk0', 'TRANSIT', true, null)$$,
  '%one org%', 'TRACKING TENANCY — an event is always applied for exactly one org');
-- Strict matching: a transaction id that does not match never falls back to the tracking number.
select is(public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', 'txn_someone_else', '1Zwalk0', 'TRANSIT', true, null) ->> 'matched', 'false',
  'TRACKING — a mismatched transaction id does not fall back to the tracking number');
select is((pg_temp.sh('walkin')).state::text, 'label_bought', 'TRACKING — so nothing changed');
select is(public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', 'walk_txn_0', '1Zwalk0', 'PRE_TRANSIT', false, null) ->> 'state', 'label_bought',
  'TRACKING — PRE_TRANSIT records the status only');
select is(public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', 'walk_txn_0', '1Zwalk0', 'TRANSIT', true, 'Origin Scan') ->> 'state', 'shipped',
  'TRACKING — the carrier has it (TRANSIT) → shipped');
select is((select format('%s:%s', s.tracking_status, p.tracking_status) from public.shipment s
           join public.shipment_parcel p on p.shipment_id = s.id where s.id = pg_temp.id('walkin')),
  'TRANSIT:TRANSIT', 'TRACKING — shipment and parcel carry the latest status');
select is(public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', null, '1Zwalk0', 'DELIVERED', true, null) ->> 'state', 'shipped',
  'TRACKING — without a transaction id, matched by tracking number; later events keep it shipped');
select public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', null, '1Zwalk0', 'RETURNED', false, 'Return to sender');
select ok((pg_temp.sh('walkin')).notes like '%Carrier returned: Return to sender%',
  'TRACKING — a carrier exception is noted on the shipment, never auto-resolved');
-- A tracking number on two of the org's parcels (e.g. carrier test numbers) is refused, not guessed.
reset role;
update public.shipment_parcel set tracking_number = '1Zdupe' where shipment_id = pg_temp.id('bo');
set local role service_role;
select throws_like($$select public.shipping_apply_tracking('a1900000-0000-4000-8000-00000000000a', null, '1Zdupe', 'TRANSIT', true, null)$$,
  '%matches 2 parcels%', 'TRACKING — an ambiguous tracking number fails loudly instead of picking one');

-- Cancel -----------------------------------------------------------------------------------------

reset role;
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select throws_like($$select public.cancel_shipment('wp19-cancel-0', pg_temp.id('ann'), 'oops')$$,
  '%already shipped%', 'CANCEL — a shipped shipment is not cancelled here');
-- Bo's boxes ship again in a new shipment with a bought label: cancelling it needs a manager.
insert into t_ids select 'bo2', public.create_shipment('wp19-create-bo2',
  array['a1900000-0000-4000-8000-000000000074', 'a1900000-0000-4000-8000-000000000075']::uuid[],
  pg_temp.addr(), current_date) ->> 'shipment_id';
reset role;
update public.shipment set state = 'label_bought', tracking_number = '1Zbo2' where id = pg_temp.id('bo2');
set local role authenticated;
select pg_temp.as_role('a1900000-0000-4000-8000-00000000000a', 'staff');
select throws_ok($$select public.cancel_shipment('wp19-cancel-1', pg_temp.id('bo2'), 'customer moved')$$,
  '42501', null, 'CANCEL — a bought label needs a manager to cancel');
select is(public.cancel_shipment('wp19-cancel-2', pg_temp.id('bo2'), 'customer moved', 'wp19-elevation') ->> 'state',
  'cancelled', 'CANCEL — manager cancels a bought label');
select ok((pg_temp.sh('bo2')).notes like '%must be refunded in Shippo%', 'CANCEL — the Shippo refund is noted');
select is((select count(*)::int from public.box_plan where shipment_id = pg_temp.id('bo2')), 0,
  'CANCEL — the boxes return to the unassigned ship-box queue');
select is(public.cancel_shipment('wp19-cancel-3', pg_temp.id('nodate'), 'duplicate') ->> 'state', 'cancelled',
  'CANCEL — a draft cancels without a manager');

-- Queue ------------------------------------------------------------------------------------------

select is((select array_agg(s ->> 'number' order by s ->> 'number')
           from jsonb_array_elements(public.shipping_queue() -> 'shipments') s),
  array['SHP-0001', 'SHP-0002', 'SHP-0003', 'SHP-0004', 'SHP-0005'], 'QUEUE — open and recent shipments');
select is((select array_agg(b ->> 'number' order by b ->> 'number')
           from jsonb_array_elements(public.shipping_queue() -> 'unassigned') g, jsonb_array_elements(g -> 'boxes') b),
  array['BOX-0004', 'BOX-0005', 'BOX-0006'], 'QUEUE — ship boxes not in a live shipment, grouped by angler');
select is((select s -> 'gate' from jsonb_array_elements(public.shipping_queue() -> 'shipments') s
           where s ->> 'number' = 'SHP-0001') ->> 'can_reprint', 'true', 'QUEUE — each shipment carries its live gate');

-- Tenancy ----------------------------------------------------------------------------------------

select pg_temp.as_role('b1900000-0000-4000-8000-00000000000b', 'manager');
select throws_like($$select public.shipment_detail(pg_temp.id('ann'))$$, '%not found%',
  'TENANCY — another org cannot read a shipment');
select throws_like($$select public.begin_label_buy('wp19-tenancy-1', pg_temp.id('ann'))$$, '%not found%',
  'TENANCY — nor buy its label');
select is(jsonb_array_length(public.shipping_queue() -> 'shipments'), 0, 'TENANCY — nor see it in its queue');
select is((select count(*)::int from public.shipment_parcel), 0, 'TENANCY — parcels are org-scoped by RLS');
select throws_like($$select public.create_shipment('wp19-tenancy-2',
  array['a1900000-0000-4000-8000-000000000076']::uuid[], '{}', null)$$, '%not found%',
  'TENANCY — nor ship another org''s box');

select * from finish();
rollback;
