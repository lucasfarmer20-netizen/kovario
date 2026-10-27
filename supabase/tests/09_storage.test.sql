-- WP-09 cold storage: confirm_storage_intake (STG- number, boxes, stored, label + receipt
-- jobs), the one day count app.storage_box_days (S4), create_pickup_batch (snapshot, one
-- storage charge, supersede), and the release paths against the storage pickup invariants
-- S1–S12 (docs/10-LESSONS-FROM-CSP.md §3). Table-driven: every scenario records
-- (invariant, label, got, want) rows in t_check; one assertion per row at the end.
-- The S5 lock-order / concurrent-payment checks need two connections:
-- packages/db/src/storage.db.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.org (id, slug, name, timezone) values
  ('a9000000-0000-4000-8000-00000000000a', 'storage-a', 'Storage A', 'America/Anchorage'),
  ('b9000000-0000-4000-8000-00000000000b', 'storage-b', 'Storage B', 'UTC');
insert into public.site (id, org_id, name, is_default) values
  ('a9000000-0000-4000-8000-0000000000a5', 'a9000000-0000-4000-8000-00000000000a', 'Dock', true);
insert into public.rate_card (id, org_id, name, is_default) values
  ('a9000000-0000-4000-8000-0000000000c1', 'a9000000-0000-4000-8000-00000000000a', 'Standard', true);
insert into public.rate_card_line (org_id, rate_card_id, key, amount) values
  ('a9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-0000000000c1', 'storage_per_box_day', 0.75);
insert into public.customer (id, org_id, name, phone) values
  ('a9000000-0000-4000-8000-0000000002a1', 'a9000000-0000-4000-8000-00000000000a', 'Sam Store', '+19075550101'),
  ('b9000000-0000-4000-8000-0000000002b1', 'b9000000-0000-4000-8000-00000000000b', 'Other Org', '+19075550102');
insert into public.printer (id, org_id, name, site_id, kind, is_default_for) values
  ('a9000000-0000-4000-8000-0000000003a1', 'a9000000-0000-4000-8000-00000000000a', 'Freezer ZD421',
   'a9000000-0000-4000-8000-0000000000a5', 'label_zpl', '{"storage_label": true}'),
  ('a9000000-0000-4000-8000-0000000003a2', 'a9000000-0000-4000-8000-00000000000a', 'Desk receipt',
   'a9000000-0000-4000-8000-0000000000a5', 'receipt_pdf', '{"receipt": true}');
insert into public.location (id, org_id, zone, kind, code, qr) values
  ('a9000000-0000-4000-8000-0000000004a1', 'a9000000-0000-4000-8000-00000000000a', 'IF', 'pallet',
   'IF-PALLET-01', 'FL:LOC:storage-a:IF-PALLET-01');
-- Payments the WP-16 paid hook would hand over (P4 is a refund: S11).
insert into public.payment (id, org_id, number, customer_id, provider, amount, state, provider_ref)
select ('a9000000-0000-4000-8000-0000000005a' || n)::uuid, 'a9000000-0000-4000-8000-00000000000a',
       'PAY-000' || n, 'a9000000-0000-4000-8000-0000000002a1', 'manual', 10,
       (case when n = 4 then 'refunded' else 'approved' end)::public.payment_state, 'REF-' || n || n || n
from generate_series(1, 5) n;

create temp table t_ids (k text primary key, v text) on commit drop;
create temp table t_check (seq serial, inv text, label text, got text, want text) on commit drop;
grant all on t_ids, t_check to authenticated;
grant usage on sequence t_check_seq_seq to authenticated;

create function pg_temp.as_role(p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', 'a9000000-0000-4000-8000-0000000000f1', 'role', 'authenticated',
    'org_id', 'a9000000-0000-4000-8000-00000000000a', 'app_role', p_role)::text, true);
$$;
create function pg_temp.id(p_k text) returns uuid language sql as $$
  select v::uuid from t_ids where k = p_k;
$$;
create function pg_temp.res(p_k text) returns jsonb language sql as $$
  select v::jsonb from t_ids where k = p_k;
$$;
create function pg_temp.chk(p_inv text, p_label text, p_got anycompatible, p_want anycompatible) returns void
language sql as $$
  insert into t_check (inv, label, got, want) values (p_inv, p_label, p_got::text, p_want::text);
$$;
-- 'ok', or the SQLSTATE the statement raised (its writes roll back with the savepoint).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;
create function pg_temp.confirm(p_id text, p_boxes jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
  select public.confirm_storage_intake(p_id, jsonb_build_object(
    'customer_id', 'a9000000-0000-4000-8000-0000000002a1', 'boxes', p_boxes) || p_extra);
$$;
create function pg_temp.batch(p_id text, p_intake text, p_boxes text[]) returns jsonb language sql as $$
  select public.create_pickup_batch(p_id, pg_temp.id(p_intake),
    (select array_agg(pg_temp.id(b)) from unnest(p_boxes) b));
$$;
-- The paid hook's call (WP-16): one payment, its ref, the batches on the order.
create function pg_temp.pay(p_batches text[], p_payment int, p_amounts jsonb default null) returns jsonb
language sql security definer as $$
  select app.release_pickup_batches(
    (select array_agg(coalesce(pg_temp.id(b), 'a9000000-0000-4000-8000-00000000dead')) from unnest(p_batches) b),
    ('a9000000-0000-4000-8000-0000000005a' || p_payment)::uuid, 'REF-' || repeat(p_payment::text, 3), p_amounts);
$$;
create function pg_temp.force(p_id text, p_batch text, p_mode text, p_reason text) returns jsonb language sql as $$
  select public.force_release_pickup_batch(p_id, pg_temp.id(p_batch), p_mode, p_reason);
$$;
create function pg_temp.box_states(p_intake text) returns text[] language sql as $$
  select array_agg(format('%s:%s:%s', b.box_no, b.state, coalesce(pb.number, '-')) order by b.box_no)
  from public.storage_box b left join public.storage_pickup_batch pb on pb.id = b.batch_id
  where b.storage_intake_id = pg_temp.id(p_intake);
$$;
create function pg_temp.b(p_k text) returns public.storage_pickup_batch language sql as $$
  select * from public.storage_pickup_batch where id = pg_temp.id(p_k);
$$;
create function pg_temp.charge_of(p_k text) returns text language sql as $$
  select format('%s:%s:%s', c.state, coalesce(p.number, '-'), coalesce(c.comp_reason, '-'))
  from public.charge c left join public.payment p on p.id = c.settled_payment_id
  where c.id = (pg_temp.b(p_k)).charge_id;
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.as_role('staff');
set local role authenticated;

-- Storage intake ------------------------------------------------------------------------------

insert into t_ids values ('r1', pg_temp.confirm('wp09-confirm-0001',
  '[{"weight_lb":20,"description":"halibut"},{"weight_lb":18.5},{},{"description":" kings "}]',
  '{"location_id":"a9000000-0000-4000-8000-0000000004a1","notes":"top shelf"}')::text);
insert into t_ids select 'si1', pg_temp.res('r1') ->> 'storage_intake_id';
insert into t_ids select 'b' || box_no, id::text from public.storage_box where storage_intake_id = pg_temp.id('si1');

select pg_temp.chk('INTAKE', 'confirm assigns the first STG- number', pg_temp.res('r1') ->> 'number', 'STG-0001');
select pg_temp.chk('INTAKE', 'confirmed intake: stored, 4 boxes, location, default site, notes',
  (select row(state, box_count, active_box_count, location_id, site_id, notes)::text
   from public.storage_intake where id = pg_temp.id('si1')),
  row('stored', 4, 4, 'a9000000-0000-4000-8000-0000000004a1', 'a9000000-0000-4000-8000-0000000000a5', 'top shelf')::text);
select pg_temp.chk('INTAKE', 'boxes 1..n with label, weight, description',
  (select array_agg(format('%s|%s|%s|%s', box_no, label, weight_lb, description) order by box_no)
   from public.storage_box where storage_intake_id = pg_temp.id('si1')),
  array['1|Box 1|20.00|halibut', '2|Box 2|18.50|', '3|Box 3||', '4|Box 4||kings']);
select pg_temp.chk('INTAKE', 'confirm returns the label data the station renders (number, customer, org-tz date, boxes)',
  (select format('%s|%s|%s|%s', l ->> 'storage_number', l ->> 'customer', l ->> 'date',
                 (select string_agg(b ->> 'box_no', ',') from jsonb_array_elements(l -> 'boxes') b))
   from (select pg_temp.res('r1') -> 'labels' as l) x),
  format('STG-0001|Sam Store|%s|1,2,3,4', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD')));
select pg_temp.chk('INTAKE', 'confirm itself queues no print job (no empty payloads)',
  (select count(*) from public.print_job), 0);
create function pg_temp.labels(p_boxes text[], p_zpl text default null) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('box_id', pg_temp.id(b),
    'zpl', coalesce(p_zpl, '^XA^CI28^FD' || b || '^FS^XZ')) order by b)
  from unnest(p_boxes) b;
$$;
grant execute on function pg_temp.labels(text[], text) to authenticated;
insert into t_ids values ('lq1', public.queue_storage_labels('wp09-labels-0001', pg_temp.id('si1'),
  pg_temp.labels(array['b1', 'b2', 'b3', 'b4']))::text);
select pg_temp.chk('INTAKE', 'queue_storage_labels: one queued ZPL job per box on the site''s label printer, payload as rendered',
  (select array_agg(format('%s:%s:%s:%s:%s', j.state, j.payload_type, j.source ->> 'template', j.source ->> 'box_no', j.payload)
                    order by (j.source ->> 'box_no')::int)
   from public.print_job j
   where j.kind = 'storage_label' and j.printer_id = 'a9000000-0000-4000-8000-0000000003a1'
     and j.source ->> 'storage_intake_id' = pg_temp.id('si1')::text),
  array['queued:zpl:storage_box_label:1:^XA^CI28^FDb1^FS^XZ', 'queued:zpl:storage_box_label:2:^XA^CI28^FDb2^FS^XZ',
        'queued:zpl:storage_box_label:3:^XA^CI28^FDb3^FS^XZ', 'queued:zpl:storage_box_label:4:^XA^CI28^FDb4^FS^XZ']);
select pg_temp.chk('INTAKE', 'label queue result', pg_temp.res('lq1') ->> 'label_jobs_queued', '4');
select pg_temp.chk('INTAKE', 'replaying the label action queues nothing more',
  public.queue_storage_labels('wp09-labels-0001', pg_temp.id('si1'), pg_temp.labels(array['b1'])) = pg_temp.res('lq1')
    and (select count(*) from public.print_job) = 4, true);
select pg_temp.chk('INTAKE', 'labels are refused when empty, not ZPL, or for a box of another intake',
  pg_temp.err($$select public.queue_storage_labels('wp09-labels-empty', pg_temp.id('si1'), pg_temp.labels(array['b1'], ''))$$)
    || ':' || pg_temp.err($$select public.queue_storage_labels('wp09-labels-text', pg_temp.id('si1'), pg_temp.labels(array['b1'], 'Box 1'))$$)
    || ':' || pg_temp.err($$select public.queue_storage_labels('wp09-labels-none', pg_temp.id('si1'), '[]')$$)
    || ':' || pg_temp.err($$select public.queue_storage_labels('wp09-labels-xbox', pg_temp.id('si1'),
                              '[{"box_id":"a9000000-0000-4000-8000-00000000beef","zpl":"^XA^XZ"}]')$$),
  '22023:22023:22023:22023');
reset role;
update public.printer set is_default_for = '{}' where id = 'a9000000-0000-4000-8000-0000000003a1';
set local role authenticated;
select pg_temp.chk('INTAKE', 'no label printer: nothing queued, the station is told',
  (public.queue_storage_labels('wp09-labels-noprinter', pg_temp.id('si1'), pg_temp.labels(array['b2'])) ->> 'printer_missing')
    || ':' || (select count(*) from public.print_job), 'true:4');
reset role;
update public.printer set is_default_for = '{"storage_label": true}' where id = 'a9000000-0000-4000-8000-0000000003a1';
set local role authenticated;
select pg_temp.chk('INTAKE', 'replaying the client_action_id returns the stored result',
  pg_temp.confirm('wp09-confirm-0001', '[]'), pg_temp.res('r1'));
select pg_temp.chk('INTAKE', 'a replay writes nothing', (select count(*) from public.storage_intake), 1);
select pg_temp.chk('INTAKE', 'no boxes is refused',
  pg_temp.err($$select pg_temp.confirm('wp09-confirm-nobox', '[]')$$), '22023');
select pg_temp.chk('INTAKE', 'a negative weight is refused',
  pg_temp.err($$select pg_temp.confirm('wp09-confirm-neg', '[{"weight_lb":-1}]')$$), '22023');
select pg_temp.chk('INTAKE', 'another org''s customer is not found',
  pg_temp.err($$select public.confirm_storage_intake('wp09-confirm-xorg',
    '{"customer_id":"b9000000-0000-4000-8000-0000000002b1","boxes":[{}]}')$$), 'P0002');
select pg_temp.chk('INTAKE', 'clients cannot write boxes directly',
  pg_temp.err($$update public.storage_box set weight_lb = 1$$), '42501');

-- Three days in the freezer.
reset role;
update public.storage_intake set intake_at = now() - interval '3 days' where id = pg_temp.id('si1');
set local role authenticated;

-- S4 one money formula ------------------------------------------------------------------------

select pg_temp.chk('S4', 'same calendar day = 1',
  app.storage_days('2026-10-01 18:00Z', '2026-10-01 19:00Z', 'America/Anchorage'), 1);
select pg_temp.chk('S4', 'days count in the org timezone (Anchorage: Sep 30 → Oct 2 = 2)',
  app.storage_days('2026-10-01 07:00Z', '2026-10-02 09:00Z', 'America/Anchorage'), 2);
select pg_temp.chk('S4', 'the same instants in UTC are 1 day',
  app.storage_days('2026-10-01 07:00Z', '2026-10-02 09:00Z', 'UTC'), 1);
select pg_temp.chk('S4', 'the box view reads app.storage_box_days',
  (select array_agg(days_stored order by box_no) from public.storage_box_days where storage_intake_id = pg_temp.id('si1')),
  array[3, 3, 3, 3]);
insert into t_ids values ('q1', public.storage_pickup_quote(pg_temp.id('si1'), array[pg_temp.id('b1'), pg_temp.id('b2')])::text);
select pg_temp.chk('S4', 'quote: rate from the rate card × box-days',
  format('%s × %s = %s', pg_temp.res('q1') ->> 'rate', pg_temp.res('q1') ->> 'box_days', pg_temp.res('q1') ->> 'amount'),
  '0.75 × 6 = 4.50');
select pg_temp.chk('S4', 'a box selected twice is refused',
  pg_temp.err($$select public.storage_pickup_quote(pg_temp.id('si1'), array[pg_temp.id('b1'), pg_temp.id('b1')])$$), '22023');

insert into t_ids values ('rb1', pg_temp.batch('wp09-batch-0001', 'si1', array['b1', 'b2'])::text);
insert into t_ids select 'B1', pg_temp.res('rb1') ->> 'batch_id';
select pg_temp.chk('S4', 'the batch snapshots the quote (rate, days, amount)',
  (select format('%s:%s:%s:%s:%s', number, state, rate_per_box_day, amount, box_days ->> pg_temp.id('b1')::text)
   from pg_temp.b('B1')),
  format('SPB-0001:pending:%s:%s:3', pg_temp.res('q1') ->> 'rate', pg_temp.res('q1') ->> 'amount'));
select pg_temp.chk('S4', 'one storage charge per batch: box-days × rate = amount',
  (select format('%s:%s:%s:%s %s@%s=%s:%s', c.kind, c.source_type, c.source_id = pg_temp.id('B1'), c.customer_id,
                 c.qty, c.unit_price, c.amount, c.state)
   from public.charge c where c.id = (pg_temp.b('B1')).charge_id),
  'storage:storage_batch:t:a9000000-0000-4000-8000-0000000002a1 6.00@0.75=4.50:open');
select pg_temp.chk('S9', 'the batch''s charge carries only the batch ref, never the intake ref',
  (select description ~ 'SPB-0001' and description !~ 'STG-' from public.charge where id = (pg_temp.b('B1')).charge_id),
  true);

-- S3 cart mirrors server: a new batch for the same boxes supersedes the pending one -------------

insert into t_ids values ('rb2', pg_temp.batch('wp09-batch-0002', 'si1', array['b2', 'b3'])::text);
insert into t_ids select 'B2', pg_temp.res('rb2') ->> 'batch_id';
select pg_temp.chk('S3', 'creating a batch reports what it superseded', pg_temp.res('rb2') -> 'superseded', '["SPB-0001"]'::jsonb);
select pg_temp.chk('S3', 'the superseded batch is void with a note',
  (select format('%s:%s', state, notes ~ 'superseded by SPB-0002') from pg_temp.b('B1')), 'void:t');
select pg_temp.chk('S3', 'its charge is voided (never collected)', pg_temp.charge_of('B1'), 'voided:-:-');
select pg_temp.chk('S3', 'at most one pending batch holds a box',
  (select count(*) from public.storage_pickup_batch where state = 'pending' and pg_temp.id('b2') = any (box_ids)), 1);

-- S11 refunds are not payments ----------------------------------------------------------------

reset role;
select pg_temp.chk('S11', 'a refunded payment never enters the release path',
  pg_temp.err($$select pg_temp.pay(array['B2'], 4)$$), '22023');
select pg_temp.chk('S11', '… and leaves the batch untouched (no release, no note, no flag)',
  (select format('%s:%s:%s', state, release_failed, notes = '') from pg_temp.b('B2')), 'pending:f:t');

-- S1 exact set, S7 release artifact, S9 partial pickups ----------------------------------------

insert into t_ids values ('p1', pg_temp.pay(array['B2'], 1)::text);
select pg_temp.chk('S1', 'payment releases the batch', pg_temp.res('p1') -> 0 ->> 'status', 'released');
select pg_temp.chk('S1', 'exactly the batch''s boxes are released (2, 3); others stay stored',
  pg_temp.box_states('si1'), array['1:stored:-', '2:released:SPB-0002', '3:released:SPB-0002', '4:stored:-']);
select pg_temp.chk('S7', 'release artifact: amount, ref, payment, paid_at, released_at',
  (select format('%s:%s:%s:%s:%s', state, amount, payment_ref, payment_id, paid_at is not null and released_at is not null)
   from pg_temp.b('B2')),
  'released:4.50:REF-111:a9000000-0000-4000-8000-0000000005a1:t');
select pg_temp.chk('S7', 'the batch charge is settled by the payment', pg_temp.charge_of('B2'), 'settled:PAY-0001:-');
select pg_temp.chk('S9', 'partial pickup: intake partial, NOT stamped paid',
  (select format('%s:%s:%s:%s', state, active_box_count, paid_at is null, payment_ref is null)
   from public.storage_intake where id = pg_temp.id('si1')), 'partial:2:t:t');
set local role authenticated;
select pg_temp.chk('S4', 'receipt day counts are identical to the box view',
  (select array_agg(format('%s:%s', l ->> 'label', l ->> 'days') order by (l ->> 'box_no')::int)
   from jsonb_array_elements(public.storage_pickup_receipt(pg_temp.id('B2')) -> 'lines') l),
  (select array_agg(format('%s:%s', label, days_stored) order by box_no) from public.storage_box_days
   where storage_box_id in (pg_temp.id('b2'), pg_temp.id('b3'))));
select pg_temp.chk('S4', 'receipt total is the batch amount',
  (public.storage_pickup_receipt(pg_temp.id('B2')) ->> 'total')::numeric, (pg_temp.b('B2')).amount);
select pg_temp.chk('S5', 'a box released elsewhere fails the post-lock guard of a new batch',
  pg_temp.err($$select pg_temp.batch('wp09-batch-stale', 'si1', array['b2', 'b4'])$$), '22023');

-- S2 single charge ------------------------------------------------------------------------------

reset role;
insert into t_ids select 'released_at_b2', released_at::text from public.storage_box where id = pg_temp.id('b2');
select pg_temp.chk('S2', 'same payment re-synced: silent no-op', pg_temp.pay(array['B2'], 1) -> 0 ->> 'status', 'noop');
select pg_temp.chk('S2', '… no note', (pg_temp.b('B2')).notes, '');
select pg_temp.chk('S2', 'a different payment against a released batch: never a second release',
  pg_temp.pay(array['B2'], 2) -> 0 ->> 'status', 'duplicate_payment');
select pg_temp.chk('S2', '… critical note appended, original ref kept',
  (select format('%s:%s', payment_ref, notes ~ '\[CRITICAL\] payment PAY-0002 \(REF-222\)') from pg_temp.b('B2')), 'REF-111:t');
select pg_temp.chk('S2', '… logged loudly (critical alert event)',
  (select count(*) from public.domain_event where kind = 'storage_batch_alert' and subject_id = pg_temp.id('B2')
     and payload ->> 'level' = 'critical' and payload ->> 'code' = 'charged_twice'), 1);
select pg_temp.chk('S2', '… boxes untouched',
  (select released_at::text from public.storage_box where id = pg_temp.id('b2')), (select v from t_ids where k = 'released_at_b2'));

-- S6 no shell-only states -------------------------------------------------------------------------

select pg_temp.chk('S6', 'notes are append-only, even for privileged writers',
  pg_temp.err(format('update public.storage_pickup_batch set notes = %L where id = %L', 'rewritten', pg_temp.id('B2'))), '55000');
select pg_temp.chk('S6', 'paid-while-void: no release', pg_temp.pay(array['B1'], 2) -> 0 ->> 'status', 'paid_while_void');
select pg_temp.chk('S6', '… batch stays void, box stays stored, money recorded, critical note',
  (select format('%s:%s:%s', state, payment_ref, notes ~ '\[CRITICAL\].*void batch') from pg_temp.b('B1'))
    || ':' || (pg_temp.box_states('si1'))[1],
  'void:REF-222:t:1:stored:-');
set local role authenticated;
select pg_temp.chk('S6', 'staff cannot Force Release',
  pg_temp.err($$select pg_temp.force('wp09-force-staff', 'B1', 'manual', 'paid while void')$$), '42501');
select pg_temp.as_role('manager');
select pg_temp.chk('S6', 'Force Release needs a reason',
  pg_temp.err($$select pg_temp.force('wp09-force-noreason', 'B1', 'manual', '  ')$$), '22023');
insert into t_ids values ('f1', pg_temp.force('wp09-force-0001', 'B1', 'manual', 'paid while void at the register')::text);
select pg_temp.chk('S6', 'manager remedy: Force Release of the void batch releases it',
  (select format('%s:%s', state, payment_ref) from pg_temp.b('B1')), 'released:REF-222');
select pg_temp.chk('S1', '… box 1 released; box 2, released elsewhere, skipped and logged',
  format('%s:%s:%s', (pg_temp.box_states('si1'))[1], pg_temp.res('f1') -> 'skipped_box_ids' ->> 0 = pg_temp.id('b2')::text,
    (pg_temp.b('B1')).notes ~ '\[ERROR\] skipped boxes already released elsewhere: Box 2 by SPB-0002'),
  '1:released:SPB-0001:t:t');
select pg_temp.chk('S6', '… its charge is settled by the payment that arrived', pg_temp.charge_of('B1'), 'settled:PAY-0002:-');
select pg_temp.chk('S6', 'Force Release is audited with its reason',
  (select input ->> 'reason' from public.action_log where client_action_id = 'wp09-force-0001'), 'paid while void at the register');
select pg_temp.as_role('staff');

-- S8 blast radius + S6 release failure + S12 tax basis ------------------------------------------

insert into t_ids values ('r2', pg_temp.confirm('wp09-confirm-0002', '[{},{}]')::text);
insert into t_ids select 'si2', pg_temp.res('r2') ->> 'storage_intake_id';
insert into t_ids select 'c' || box_no, id::text from public.storage_box where storage_intake_id = pg_temp.id('si2');
insert into t_ids select 'B3', pg_temp.batch('wp09-batch-0003', 'si1', array['b4']) ->> 'batch_id';
insert into t_ids select 'B4', pg_temp.batch('wp09-batch-0004', 'si2', array['c1', 'c2']) ->> 'batch_id';

reset role;
create function public.wp09_test_break_box() returns trigger language plpgsql as $$
begin
  if new.id = (select v::uuid from pg_temp.t_ids where k = 'b4') and new.state = 'released' then
    raise exception 'injected release failure';
  end if;
  return new;
end;
$$;
create trigger wp09_test_break_box before update on public.storage_box
  for each row execute function public.wp09_test_break_box();

insert into t_ids values ('p3', pg_temp.pay(array['B3', 'B4', 'missing'], 3,
  jsonb_build_object((select v from t_ids where k = 'B4'), 9.99))::text);
select pg_temp.chk('S8', 'one broken batch never blocks its siblings',
  (select array_agg(coalesce(b.number, 'missing') || ':' || (r ->> 'status') order by coalesce(b.number, 'zz'))
   from jsonb_array_elements(pg_temp.res('p3')) r
   left join public.storage_pickup_batch b on b.id = (r ->> 'batch_id')::uuid),
  array['SPB-0003:release_failed', 'SPB-0004:released', 'missing:not_found']);
select pg_temp.chk('S6', 'release failure: stamped release_failed + payment + note outside the rolled-back savepoint',
  (select format('%s:%s:%s:%s', state, release_failed, payment_ref, notes ~ '\[ERROR\] payment PAY-0003 \(REF-333\) captured but release failed: injected release failure')
   from pg_temp.b('B3')) || ':' || (pg_temp.box_states('si1'))[4],
  'pending:t:REF-333:t:4:stored:-');
select pg_temp.chk('S12', 'untaxed paid amount ≠ batch amount: warning note, still released',
  (select format('%s:%s', state, notes ~ '\[WARNING\] paid 9.99 \(untaxed\) but the batch amount is 1.50') from pg_temp.b('B4')),
  'released:t');
select pg_temp.chk('S9', 'a fully released intake is stamped paid with the batch ref',
  (select format('%s:%s:%s', state, paid_at is not null, payment_ref) from public.storage_intake where id = pg_temp.id('si2')),
  'released:t:REF-333');
drop trigger wp09_test_break_box on public.storage_box;
set local role authenticated;
select pg_temp.chk('S6', 'a paid-but-unreleased batch cannot be re-batched (no recharge)',
  pg_temp.err($$select pg_temp.batch('wp09-batch-recharge', 'si1', array['b4'])$$), '55000');
select pg_temp.chk('S6', '… nor cancelled',
  pg_temp.err($$select public.cancel_pickup_batch('wp09-cancel-paid', pg_temp.id('B3'))$$), '55000');
select pg_temp.as_role('manager');
insert into t_ids values ('f3', pg_temp.force('wp09-force-0003', 'B3', 'manual', 'release failed after payment')::text);
select pg_temp.chk('S6', 'Force Release of the failed batch keeps the captured payment''s ref',
  (select format('%s:%s', state, payment_ref) from pg_temp.b('B3')) || ':' || pg_temp.charge_of('B3'),
  'released:REF-333:settled:PAY-0003:-');
select pg_temp.chk('S9', 'fully released at last: paid stamped, refs '' / ''-joined',
  (select format('%s:%s:%s:%s', state, active_box_count, paid_at is not null, payment_ref)
   from public.storage_intake where id = pg_temp.id('si1')),
  'released:0:t:REF-222 / REF-111 / REF-333');
select pg_temp.as_role('staff');

-- S7 COMP and MANUAL ------------------------------------------------------------------------------

insert into t_ids select 'si3', pg_temp.confirm('wp09-confirm-0003', '[{}]') ->> 'storage_intake_id';
insert into t_ids select 'd1', id::text from public.storage_box where storage_intake_id = pg_temp.id('si3');
insert into t_ids select 'B5', pg_temp.batch('wp09-batch-0005', 'si3', array['d1']) ->> 'batch_id';
insert into t_ids select 'si4', pg_temp.confirm('wp09-confirm-0004', '[{}]') ->> 'storage_intake_id';
insert into t_ids select 'e1', id::text from public.storage_box where storage_intake_id = pg_temp.id('si4');
insert into t_ids select 'B6', pg_temp.batch('wp09-batch-0006', 'si4', array['e1']) ->> 'batch_id';
select pg_temp.as_role('manager');
select pg_temp.chk('S7', 'COMP needs a reason',
  pg_temp.err($$select pg_temp.force('wp09-comp-noreason', 'B5', 'comp', null)$$), '22023');
insert into t_ids values ('c5', pg_temp.force('wp09-comp-0001', 'B5', 'comp', 'freezer outage')::text);
select pg_temp.chk('S7', 'COMP: ref COMP, charge comped with the reason, waived amount in the note',
  (select format('%s:%s:%s', state, payment_ref, notes ~ 'COMP: waived 0\.75 — freezer outage') from pg_temp.b('B5'))
    || ':' || pg_temp.charge_of('B5'),
  'released:COMP:t:comped:-:freezer outage');
insert into t_ids values ('m6', pg_temp.force('wp09-manual-0001', 'B6', 'manual', 'cash taken, register down')::text);
select pg_temp.chk('S7', 'MANUAL with no recorded payment: ref MANUAL, charge still owed',
  (select format('%s:%s:%s', state, payment_ref, payment_id is null) from pg_temp.b('B6')) || ':' || pg_temp.charge_of('B6'),
  'released:MANUAL:t:open:-:-');
select pg_temp.chk('S7', 'a released batch cannot be released again',
  pg_temp.err($$select pg_temp.force('wp09-manual-again', 'B6', 'manual', 'again')$$), '55000');
reset role;
select pg_temp.chk('S7', 'a payment for a MANUAL release is adopted as the original',
  pg_temp.pay(array['B6'], 5) -> 0 ->> 'status', 'adopted');
select pg_temp.chk('S7', '… ref + payment recorded, charge settled, error log — not a charged-twice critical',
  (select format('%s:%s:%s', payment_ref, notes ~ '\[ERROR\] payment PAY-0005 \(REF-555\) adopted', notes !~ 'CRITICAL')
   from pg_temp.b('B6')) || ':' || pg_temp.charge_of('B6'),
  'REF-555:t:t:settled:PAY-0005:-');
select pg_temp.chk('S2', 'the adopted payment re-synced is a no-op', pg_temp.pay(array['B6'], 5) -> 0 ->> 'status', 'noop');
select pg_temp.chk('S7', 'every released batch has amount, a non-empty ref, paid_at and released_at',
  (select count(*) from public.storage_pickup_batch
   where state = 'released' and (coalesce(btrim(payment_ref), '') = '' or paid_at is null or released_at is null or amount is null)),
  0);

-- S10 legacy is inert or loud ------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_role('staff');
select pg_temp.chk('S10', 'no client path stamps an intake paid without a batch release',
  pg_temp.err(format('update public.storage_intake set paid_at = now() where id = %L', pg_temp.id('si3'))), '42501');
select pg_temp.chk('S10', 'the release functions are not client-callable',
  pg_temp.err(format('select app.release_pickup_batch(%L, %L, %L)', pg_temp.id('B4'), 'X', 'manual')), '42501');

-- S12 tax basis ------------------------------------------------------------------------------------

select pg_temp.chk('S12', 'batch.amount is untaxed: exactly rate × snapshotted box-days',
  (select count(*) from public.storage_pickup_batch b
   where b.amount <> round(b.rate_per_box_day * (select sum(value::int) from jsonb_each_text(b.box_days)), 2)),
  0);

-- S4 a batch quoted on one org-local day and paid on a later one ---------------------------------

insert into t_ids select 'si6', pg_temp.confirm('wp09-confirm-0006', '[{}]') ->> 'storage_intake_id';
insert into t_ids select 'g1', id::text from public.storage_box where storage_intake_id = pg_temp.id('si6');
reset role;
update public.storage_intake set intake_at = now() - interval '2 days' where id = pg_temp.id('si6');
insert into public.payment (id, org_id, number, customer_id, provider, amount, state, provider_ref)
values ('a9000000-0000-4000-8000-0000000005a6', 'a9000000-0000-4000-8000-00000000000a', 'PAY-0006',
        'a9000000-0000-4000-8000-0000000002a1', 'manual', 10, 'approved', 'REF-666');
set local role authenticated;
insert into t_ids select 'B8', pg_temp.batch('wp09-batch-0008', 'si6', array['g1']) ->> 'batch_id';
select pg_temp.chk('S4', 'quoted day: 2 days billed', (select format('%s:%s', box_days ->> pg_temp.id('g1')::text, amount)
  from pg_temp.b('B8')), '2:1.50');
-- A day passes before the register takes payment.
reset role;
update public.storage_intake set intake_at = intake_at - interval '1 day' where id = pg_temp.id('si6');
set local role authenticated;
select pg_temp.chk('S4', 'while stored, the box view counts to today (3 days)',
  (select days_stored from public.storage_box_days where storage_box_id = pg_temp.id('g1')), 3);
reset role;
select pg_temp.chk('S4', 'paid on the later day: released', pg_temp.pay(array['B8'], 6) -> 0 ->> 'status', 'released');
set local role authenticated;
select pg_temp.chk('S4', 'receipt lines are the billed days and sum to the charged total',
  (select format('%s|%s|%s', string_agg(format('%s:%s:%s', l ->> 'label', l ->> 'days', l ->> 'amount'), ','),
                 sum((l ->> 'amount')::numeric), r ->> 'total')
   from (select public.storage_pickup_receipt(pg_temp.id('B8')) as r) x
   cross join lateral jsonb_array_elements(x.r -> 'lines') l
   group by r ->> 'total'),
  'Box 1:2:1.50|1.50|1.50');
select pg_temp.chk('S4', '… the charge is that total', (select amount from public.charge where id = (pg_temp.b('B8')).charge_id), 1.50);
select pg_temp.chk('S4', 'after release the box view shows the billed days, identical to the receipt',
  (select days_stored from public.storage_box_days where storage_box_id = pg_temp.id('g1')), 2);
select pg_temp.chk('S6', 'the stale quote is noted on the batch (billed 2, 3 as of release)',
  (pg_temp.b('B8')).notes ~ '\[WARNING\] released on a later day than quoted: billed 2 box-days as quoted \d{4}-\d{2}-\d{2}; 3 box-days as of release',
  true);
select pg_temp.chk('S4', 'a same-day release notes nothing', (pg_temp.b('B2')).notes !~ 'stale|later day', true);

-- Wizard cancel + tenancy -----------------------------------------------------------------------

insert into t_ids select 'si5', pg_temp.confirm('wp09-confirm-0005', '[{}]') ->> 'storage_intake_id';
insert into t_ids select 'f1box', id::text from public.storage_box where storage_intake_id = pg_temp.id('si5');
insert into t_ids select 'B7', pg_temp.batch('wp09-batch-0007', 'si5', array['f1box']) ->> 'batch_id';
insert into t_ids values ('x7', public.cancel_pickup_batch('wp09-cancel-0001', pg_temp.id('B7'))::text);
select pg_temp.chk('S3', 'the wizard''s Cancel voids a pending batch and its charge',
  (select state::text from pg_temp.b('B7')) || ':' || pg_temp.charge_of('B7'), 'void:voided:-:-');

select set_config('request.jwt.claims', json_build_object(
  'sub', 'b9000000-0000-4000-8000-0000000000f1', 'role', 'authenticated',
  'org_id', 'b9000000-0000-4000-8000-00000000000b', 'app_role', 'manager')::text, true);
select pg_temp.chk('TENANCY', 'another org sees no storage rows',
  (select count(*) from public.storage_box_days) + (select count(*) from public.storage_pickup_batch), 0);
select pg_temp.chk('TENANCY', 'another org cannot batch, quote or force-release',
  pg_temp.err($$select public.storage_pickup_quote(pg_temp.id('si5'), array[pg_temp.id('f1box')])$$)
    || ':' || pg_temp.err($$select pg_temp.batch('wp09-batch-xorg', 'si5', array['f1box'])$$)
    || ':' || pg_temp.err($$select pg_temp.force('wp09-force-xorg', 'B7', 'manual', 'x')$$),
  'P0002:P0002:P0002');

-- Assertions ---------------------------------------------------------------------------------------

reset role;
select is(got, want, format('%s — %s', inv, label)) from t_check order by seq;

select * from finish();
rollback;
