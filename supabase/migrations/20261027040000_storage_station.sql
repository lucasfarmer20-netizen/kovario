-- WP-09 cold storage (docs/04-BUSINESS-RULES.md §10, docs/06-STATIONS-UX.md Storage intake,
-- docs/10-LESSONS-FROM-CSP.md §3 S1–S12, docs/03-STATE-MACHINES.md):
--   * confirm_storage_intake — STG- number, boxes, draft → stored; queue_storage_labels queues
--     the box labels the station rendered (non-empty ZPL);
--   * app.storage_box_days(box) — the ONE day count (S4); the storage_box_days view, the
--     pickup quote, the batch snapshot and the pickup receipt all call it;
--   * app.storage_snapshot — the ONE place a storage amount is computed (S4);
--   * create_pickup_batch — snapshot rate/days/amount, one charge(kind=storage) per batch,
--     supersedes (voids) pending batches sharing a box, intake row locked first (S5);
--   * app.release_pickup_batch(batch, payment_ref, mode) — S1, S2, S5, S6, S7, S9, S11, S12;
--     app.release_pickup_batches — the per-batch-savepoint loop the WP-16 paid hook calls
--     (S6 release_failed stamped outside the savepoint, S8 blast radius);
--   * force_release_pickup_batch — manager Force Release (MANUAL) and COMP, reason required.
-- Payment application itself (register, apply_paid_register_order) is WP-16.
-- Printing: the station renders each box label with packages/labels storageBoxLabel (the
-- SBOX QR text comes from packages/rules qr.ts) from storage_label_data, and
-- queue_storage_labels stores that ZPL as the print_job payload the WP-08 agent sends as-is.
-- No receipt print_job is queued: the agent prints PDFs only from an HTTPS URL and there
-- is no PDF render/upload pipeline yet, so the station prints receipts through the browser.

-- Columns ---------------------------------------------------------------------------------

-- S9: intake-level paid markers, stamped only when the intake is fully released.
alter table public.storage_intake
  add column if not exists paid_at timestamptz,
  add column if not exists payment_ref text;

-- S4: the batch snapshot keeps the days it billed per box and the moment it was quoted.
alter table public.storage_pickup_batch
  add column if not exists box_days jsonb not null default '{}'::jsonb,
  add column if not exists snapshot_at timestamptz not null default now(),
  add column if not exists released_by uuid references public.org_member (id) on delete set null;

create index if not exists storage_pickup_batch_pending on public.storage_pickup_batch (storage_intake_id)
  where state = 'pending';

-- S6: notes always append, never overwrite — for every writer, definer code included.
create or replace function app.storage_batch_notes_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if left(new.notes, length(old.notes)) is distinct from old.notes then
    raise exception 'storage_pickup_batch.notes is append-only' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists notes_append_only on public.storage_pickup_batch;
create trigger notes_append_only before update of notes on public.storage_pickup_batch
  for each row execute function app.storage_batch_notes_append_only();

-- Appends a line to the batch notes; warning/error/critical also log loudly (S6): a
-- `storage_batch_alert` domain event (the manager alert feed) and a server log line.
create or replace function app.storage_batch_note(
  p_batch_id uuid, p_level text, p_code text, p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.storage_pickup_batch;
begin
  update public.storage_pickup_batch
  set notes = notes || case when notes = '' then '' else E'\n' end
              || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI"Z"') || ' ['
              || upper(p_level) || '] ' || p_message
  where id = p_batch_id
  returning * into v_batch;
  if not found then
    return;
  end if;
  if p_level in ('warning', 'error', 'critical') then
    perform app.emit_event(v_batch.org_id, 'storage_batch_alert', v_batch.id, jsonb_build_object(
      'level', p_level, 'code', p_code, 'batch_number', v_batch.number, 'message', p_message));
    raise warning 'storage batch % [%] %: %', v_batch.number, p_level, p_code, p_message;
  end if;
end;
$$;

-- Days and money (S4) ---------------------------------------------------------------------

-- THE day count of a box. A stored box: calendar days from its intake to `p_as_of` in the
-- org's timezone; same day = 1. A released box: frozen at the days its releasing batch billed
-- (the batch snapshot, made by this same formula) — so the box view, the pickup receipt and
-- the charged amount agree even when a batch is paid on a later day than it was quoted
-- (that drift is noted on the batch at release). Invoker rights: callers see only their own
-- org's rows.
create or replace function app.storage_box_days(p_box public.storage_box, p_as_of timestamptz default now())
returns int
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select (pb.box_days ->> p_box.id::text)::int
     from public.storage_pickup_batch pb
     where p_box.state = 'released' and pb.id = p_box.batch_id),
    (select app.storage_days(si.intake_at, coalesce(p_box.released_at, p_as_of), coalesce(o.timezone, 'UTC'))
     from public.storage_intake si
     join public.org o on o.id = si.org_id
     where si.id = p_box.storage_intake_id))
$$;

-- The box view reads its day count from the one function. Columns keep their order; new
-- ones are appended.
create or replace view public.storage_box_days with (security_invoker = true) as
  select
    b.id as storage_box_id,
    b.org_id,
    b.storage_intake_id,
    b.box_no,
    b.label,
    b.state,
    si.intake_at,
    b.released_at,
    app.storage_box_days(b) as days_stored,
    b.weight_lb,
    b.description,
    b.batch_id
  from public.storage_box b
  join public.storage_intake si on si.id = b.storage_intake_id;

revoke all on public.storage_box_days from public, anon, authenticated;
grant select on public.storage_box_days to authenticated, service_role;

-- Rate = the rate card in force today, key storage_per_box_day (the rate card is the only
-- source of money rates). Null when the card has no storage rate.
create or replace function app.storage_rate(p_org_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select (app.rate_card_rates(app.intake_rate_card(p_org_id, app.org_today(p_org_id)))
          ->> 'storage_per_box_day')::numeric
$$;

-- The ONE place a storage amount is computed. Validates the box set (distinct, of this
-- intake, still stored) and returns
--   {rate, box_days, amount, boxes: [{box_id, box_no, label, days, amount}]}.
create or replace function app.storage_snapshot(
  p_storage_intake_id uuid, p_box_ids uuid[], p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_rate numeric;
  v_boxes jsonb;
  v_days int;
  v_n int;
begin
  select si.org_id into v_org from public.storage_intake si where si.id = p_storage_intake_id;
  if not found then
    raise exception 'storage intake not found' using errcode = 'P0002';
  end if;
  if coalesce(cardinality(p_box_ids), 0) = 0 then
    raise exception 'select at least one box' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_box_ids) x) <> cardinality(p_box_ids) then
    raise exception 'a box is selected twice' using errcode = '22023';
  end if;
  select count(*) into v_n from public.storage_box b
  where b.id = any (p_box_ids) and b.storage_intake_id = p_storage_intake_id and b.state = 'stored';
  if v_n <> cardinality(p_box_ids) then
    raise exception 'every box must belong to this storage intake and still be stored' using errcode = '22023';
  end if;
  v_rate := app.storage_rate(v_org);
  if v_rate is null then
    raise exception 'the rate card has no storage_per_box_day rate' using errcode = 'P0002';
  end if;

  select jsonb_agg(jsonb_build_object(
           'box_id', d.id, 'box_no', d.box_no, 'label', d.label, 'days', d.days,
           'amount', round(v_rate * d.days, 2)) order by d.box_no),
         sum(d.days)
  into v_boxes, v_days
  from (
    select b.id, b.box_no, b.label, app.storage_box_days(b, p_as_of) as days
    from public.storage_box b
    where b.id = any (p_box_ids)
  ) d;

  return jsonb_build_object('rate', v_rate, 'box_days', v_days, 'amount', round(v_rate * v_days, 2),
                            'boxes', v_boxes);
end;
$$;

-- Numbers ---------------------------------------------------------------------------------

-- next_seq holds the counter row lock; skip numbers taken by rows inserted outside it
-- (seed fixtures, imports) so a create never fails on the unique number.
create or replace function app.next_free_number(p_org_id uuid, p_kind text, p_table regclass)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
  v_taken boolean;
begin
  loop
    v_number := app.next_seq(p_org_id, p_kind);
    execute format('select exists (select 1 from %s where org_id = $1 and number = $2)', p_table)
      into v_taken using p_org_id, v_number;
    exit when not v_taken;
  end loop;
  return v_number;
end;
$$;

-- Print jobs ------------------------------------------------------------------------------

-- What the storage box labels print: {storage_intake_id, storage_number, customer, date,
-- boxes: [{box_id, box_no}]}. The station renders each with storageBoxLabel.
create or replace function app.storage_label_data(p_storage_intake_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'storage_intake_id', si.id,
    'storage_number', si.number,
    'customer', c.name,
    'date', to_char(si.intake_at at time zone coalesce(o.timezone, 'UTC'), 'YYYY-MM-DD'),
    'boxes', (select coalesce(jsonb_agg(jsonb_build_object('box_id', b.id, 'box_no', b.box_no)
                                        order by b.box_no), '[]'::jsonb)
              from public.storage_box b where b.storage_intake_id = si.id))
  from public.storage_intake si
  join public.customer c on c.id = si.customer_id
  join public.org o on o.id = si.org_id
  where si.id = p_storage_intake_id
$$;

create or replace function public.storage_label_data(p_storage_intake_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if not exists (select 1 from public.storage_intake where id = p_storage_intake_id and org_id = app.org_id()) then
    raise exception 'storage intake not found' using errcode = 'P0002';
  end if;
  return app.storage_label_data(p_storage_intake_id);
end;
$$;

-- p_labels: [{box_id, zpl}] — rendered by the station with storageBoxLabel. Each label must
-- be for a box of this intake and be one ^XA…^XZ ZPL document; it is queued as-is on the
-- calling station's label printer (else the site's storage_label printer). Returns
-- {label_jobs_queued, printer_missing}; nothing is queued when no printer is set up.
create or replace function public.queue_storage_labels(
  p_client_action_id text, p_storage_intake_id uuid, p_labels jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_intake public.storage_intake;
  v_printer uuid;
  v_n int := 0;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if jsonb_typeof(p_labels) is distinct from 'array' or jsonb_array_length(p_labels) not between 1 and 200 then
    raise exception 'labels must be a list of 1 to 200 rendered labels' using errcode = '22023';
  end if;
  -- The action log keeps which boxes were printed, not the ZPL.
  v_action := app.action_begin(p_client_action_id, 'storage.queue_labels', jsonb_build_object(
    'storage_intake_id', p_storage_intake_id,
    'box_ids', (select jsonb_agg(l -> 'box_id') from jsonb_array_elements(p_labels) l)));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_intake from public.storage_intake where id = p_storage_intake_id and org_id = app.org_id();
  if not found then
    raise exception 'storage intake not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_labels) l
    where jsonb_typeof(l -> 'zpl') is distinct from 'string'
       or l ->> 'zpl' !~ '^\^XA'
       or l ->> 'zpl' !~ '\^XZ\s*$'
       or octet_length(l ->> 'zpl') > 100000
       or not exists (
         select 1 from public.storage_box b
         where b.id::text = l ->> 'box_id' and b.storage_intake_id = v_intake.id)
  ) then
    raise exception 'each label needs a box of this storage intake and its rendered ZPL' using errcode = '22023';
  end if;

  v_printer := app.station_printer(v_intake.site_id, 'label_zpl', 'storage_label');
  if v_printer is not null then
    insert into public.print_job (org_id, printer_id, kind, payload_type, payload, source)
    select v_intake.org_id, v_printer, 'storage_label', 'zpl', l ->> 'zpl', jsonb_build_object(
      'template', 'storage_box_label', 'storage_intake_id', v_intake.id, 'storage_box_id', b.id,
      'box_no', b.box_no)
    from jsonb_array_elements(p_labels) l
    join public.storage_box b on b.id::text = l ->> 'box_id'
    order by b.box_no;
    get diagnostics v_n = row_count;
  end if;

  v_result := jsonb_build_object('storage_intake_id', v_intake.id, 'label_jobs_queued', v_n,
    'printer_missing', v_printer is null);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Storage intake ----------------------------------------------------------------------------

-- p_payload: {customer_id, site_id?, location_id?, notes?,
--             boxes: [{weight_lb?, description?}]}
-- One transaction: STG- number, boxes 1..n, draft → stored. Returns the label data the
-- station renders and hands to queue_storage_labels.
create or replace function public.confirm_storage_intake(p_client_action_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_boxes jsonb;
  v_customer_id uuid;
  v_site uuid;
  v_location uuid;
  v_intake public.storage_intake;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload must be an object' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'storage.confirm_intake', p_payload);
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_boxes := p_payload -> 'boxes';
  v_customer_id := nullif(p_payload ->> 'customer_id', '')::uuid;
  v_site := nullif(p_payload ->> 'site_id', '')::uuid;
  v_location := nullif(p_payload ->> 'location_id', '')::uuid;
  if v_customer_id is null then
    raise exception 'customer is required' using errcode = '22004';
  end if;
  if jsonb_typeof(v_boxes) is distinct from 'array' or jsonb_array_length(v_boxes) = 0 then
    raise exception 'a storage intake needs at least one box' using errcode = '22023';
  end if;
  if jsonb_array_length(v_boxes) > 200 then
    raise exception 'at most 200 boxes per storage intake' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_boxes) b
    where jsonb_typeof(b) is distinct from 'object'
       or (b ->> 'weight_lb' is not null and (b ->> 'weight_lb')::numeric < 0)
  ) then
    raise exception 'box weights must be 0 or more' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customer where id = v_customer_id and org_id = v_org) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if v_site is not null and not exists (select 1 from public.site where id = v_site and org_id = v_org) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  if v_location is not null and not exists (select 1 from public.location where id = v_location and org_id = v_org) then
    raise exception 'location not found' using errcode = 'P0002';
  end if;
  v_site := coalesce(
    v_site,
    (select d.site_id from public.device d where d.id = app.device_id() and d.org_id = v_org),
    (select s.id from public.site s where s.org_id = v_org and s.is_default)
  );

  insert into public.storage_intake (org_id, number, customer_id, site_id, state, location_id, notes)
  values (v_org, app.next_free_number(v_org, 'storage_intake', 'public.storage_intake'), v_customer_id,
          v_site, 'draft', v_location, nullif(btrim(p_payload ->> 'notes'), ''))
  returning * into v_intake;

  insert into public.storage_box (org_id, storage_intake_id, box_no, label, weight_lb, description)
  select v_org, v_intake.id, b.n, null, (b.v ->> 'weight_lb')::numeric, nullif(btrim(b.v ->> 'description'), '')
  from jsonb_array_elements(v_boxes) with ordinality as b (v, n);

  update public.storage_intake set state = 'stored' where id = v_intake.id returning * into v_intake;
  update public.customer set last_visit_at = now() where id = v_customer_id;

  v_result := jsonb_build_object(
    'storage_intake_id', v_intake.id,
    'number', v_intake.number,
    'state', v_intake.state,
    'box_count', v_intake.box_count,
    'labels', app.storage_label_data(v_intake.id)
  );
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Pickup batches ----------------------------------------------------------------------------

-- Wizard preview: the same snapshot create_pickup_batch will store, without writing.
create or replace function public.storage_pickup_quote(p_storage_intake_id uuid, p_box_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if not exists (select 1 from public.storage_intake where id = p_storage_intake_id and org_id = app.org_id()) then
    raise exception 'storage intake not found' using errcode = 'P0002';
  end if;
  return app.storage_snapshot(p_storage_intake_id, p_box_ids);
end;
$$;

-- Voids a pending batch and its open charge, with a note. Caller holds the intake lock.
create or replace function app.void_pickup_batch(p_batch_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_charge uuid;
begin
  update public.storage_pickup_batch set state = 'void' where id = p_batch_id and state = 'pending'
  returning charge_id into v_charge;
  if not found then
    return;
  end if;
  update public.charge set state = 'voided' where id = v_charge and state = 'open';
  perform app.storage_batch_note(p_batch_id, 'info', 'void', p_note);
end;
$$;

-- Select boxes → a pending batch snapshotting rate/days/amount, with one storage charge.
-- Every pending batch of the intake sharing a box is superseded (void) — the register cart
-- mirrors the server (S3). A box held by a batch whose money was captured but whose release
-- failed is refused: a manager must Force Release it first (S6, no recharge).
create or replace function public.create_pickup_batch(
  p_client_action_id text, p_storage_intake_id uuid, p_box_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_intake public.storage_intake;
  v_snapshot jsonb;
  v_batch public.storage_pickup_batch;
  v_old public.storage_pickup_batch;
  v_superseded text[] := '{}';
  v_charge uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'storage.create_pickup_batch',
    jsonb_build_object('storage_intake_id', p_storage_intake_id, 'box_ids', p_box_ids));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  -- S5: (1) intake row first, (3) read, (4) guard, (5) write.
  select * into v_intake from public.storage_intake
  where id = p_storage_intake_id and org_id = v_org
  for update;
  if not found then
    raise exception 'storage intake not found' using errcode = 'P0002';
  end if;
  if v_intake.state not in ('stored', 'partial') then
    raise exception 'storage intake % has no boxes in storage', v_intake.number using errcode = '55000';
  end if;
  select * into v_old from public.storage_pickup_batch
  where storage_intake_id = v_intake.id and state = 'pending' and box_ids && p_box_ids
    and (release_failed or payment_id is not null)
  order by created_at
  limit 1;
  if found then
    raise exception '% was paid but not released; a manager must Force Release it', v_old.number
      using errcode = '55000';
  end if;

  v_snapshot := app.storage_snapshot(v_intake.id, p_box_ids);

  insert into public.storage_pickup_batch (
    org_id, number, storage_intake_id, state, box_ids, rate_per_box_day, amount, box_days, snapshot_at
  ) values (
    v_org, app.next_free_number(v_org, 'storage_pickup_batch', 'public.storage_pickup_batch'), v_intake.id,
    'pending', (select array_agg(x order by x) from unnest(p_box_ids) x),
    (v_snapshot ->> 'rate')::numeric, (v_snapshot ->> 'amount')::numeric,
    (select jsonb_object_agg(b ->> 'box_id', (b ->> 'days')::int) from jsonb_array_elements(v_snapshot -> 'boxes') b),
    now()
  ) returning * into v_batch;

  for v_old in
    select * from public.storage_pickup_batch
    where storage_intake_id = v_intake.id and state = 'pending' and id <> v_batch.id and box_ids && v_batch.box_ids
    order by id
    for update
  loop
    perform app.void_pickup_batch(v_old.id, format('superseded by %s', v_batch.number));
    v_superseded := v_superseded || v_old.number;
  end loop;

  -- S9: the charge carries only the batch ref, never the intake's.
  insert into public.charge (org_id, number, customer_id, kind, source_type, source_id, description, qty, unit,
                             unit_price)
  values (v_org, app.next_seq(v_org, 'charge'), v_intake.customer_id, 'storage', 'storage_batch', v_batch.id,
          format('Cold storage %s — %s box%s, %s box-days', v_batch.number, cardinality(v_batch.box_ids),
                 case when cardinality(v_batch.box_ids) = 1 then '' else 'es' end, v_snapshot ->> 'box_days'),
          (v_snapshot ->> 'box_days')::numeric, 'day', v_batch.rate_per_box_day)
  returning id into v_charge;
  update public.storage_pickup_batch set charge_id = v_charge where id = v_batch.id;

  v_result := jsonb_build_object(
    'batch_id', v_batch.id,
    'number', v_batch.number,
    'state', 'pending',
    'charge_id', v_charge,
    'rate', v_snapshot -> 'rate',
    'box_days', v_snapshot -> 'box_days',
    'amount', v_snapshot -> 'amount',
    'boxes', v_snapshot -> 'boxes',
    'superseded', to_jsonb(v_superseded)
  );
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Wizard "Cancel": pending → void. A batch with captured money is never cancelled (S6).
create or replace function public.cancel_pickup_batch(p_client_action_id text, p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_intake_id uuid;
  v_batch public.storage_pickup_batch;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'storage.cancel_pickup_batch',
    jsonb_build_object('batch_id', p_batch_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  select storage_intake_id into v_intake_id from public.storage_pickup_batch
  where id = p_batch_id and org_id = app.org_id();
  if not found then
    raise exception 'pickup batch not found' using errcode = 'P0002';
  end if;
  perform 1 from public.storage_intake where id = v_intake_id for update;
  select * into v_batch from public.storage_pickup_batch where id = p_batch_id for update;
  if v_batch.state <> 'pending' then
    raise exception '% is %; only a pending batch can be cancelled', v_batch.number, v_batch.state
      using errcode = '55000';
  end if;
  if v_batch.release_failed or v_batch.payment_id is not null then
    raise exception '% was paid; a manager must Force Release it', v_batch.number using errcode = '55000';
  end if;
  perform app.void_pickup_batch(v_batch.id, 'cancelled at the pickup wizard');
  v_result := jsonb_build_object('batch_id', v_batch.id, 'number', v_batch.number, 'state', 'void');
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Release ------------------------------------------------------------------------------------

-- Releases one batch. p_mode:
--   'payment' — the WP-16 paid hook: p_payment_id must be an APPROVED payment (S11: refunds
--               and reversals never release); p_payment_ref is the terminal ref or the
--               register order number (S7: never empty); p_paid_amount (untaxed, S12) is
--               compared with batch.amount and a mismatch is noted.
--   'manual'  — manager Force Release; ref = p_payment_ref, else the payment already stamped
--               on the batch, else 'MANUAL'. Also releases a void batch (manager edge).
--   'comp'    — manager waiver; ref 'COMP'; the waived amount goes in the note (S7).
-- S5: intake row locked first, then the batch, then its boxes; every guard is evaluated
-- after the locks. Returns {batch_id, number, status, released_box_ids, skipped_box_ids,
-- intake_state} with status released | noop | adopted | duplicate_payment | paid_while_void.
create or replace function app.release_pickup_batch(
  p_batch_id uuid,
  p_payment_ref text,
  p_mode text,
  p_payment_id uuid default null,
  p_reason text default null,
  p_released_by uuid default null,
  p_paid_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake_id uuid;
  v_intake public.storage_intake;
  v_batch public.storage_pickup_batch;
  v_payment public.payment;
  v_ref text := nullif(btrim(p_payment_ref), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_by uuid;
  v_released uuid[];
  v_skipped uuid[];
  v_other public.storage_pickup_batch;
  v_charge public.charge;
  v_left int;
  v_days_now int;
  v_days_billed int;
  v_state public.storage_intake_state;
  v_result jsonb;
begin
  if p_mode is null or p_mode not in ('payment', 'manual', 'comp') then
    raise exception 'release mode must be payment, manual or comp' using errcode = '22023';
  end if;

  select storage_intake_id into v_intake_id from public.storage_pickup_batch where id = p_batch_id;
  if not found then
    raise exception 'pickup batch not found' using errcode = 'P0002';
  end if;
  -- S5 (1) lock the INTAKE row, (3) read, (4) guard, (5) write.
  select * into v_intake from public.storage_intake where id = v_intake_id for update;
  select * into v_batch from public.storage_pickup_batch where id = p_batch_id for update;
  v_by := coalesce(p_released_by,
    (select m.id from public.org_member m where m.user_id = app.user_id() and m.org_id = v_batch.org_id));
  v_result := jsonb_build_object('batch_id', v_batch.id, 'number', v_batch.number,
    'released_box_ids', '[]'::jsonb, 'skipped_box_ids', '[]'::jsonb, 'intake_state', v_intake.state);

  if p_mode = 'payment' then
    if p_payment_id is null then
      raise exception 'a payment release needs the payment' using errcode = '22004';
    end if;
    select * into v_payment from public.payment where id = p_payment_id and org_id = v_batch.org_id;
    if not found then
      raise exception 'payment not found' using errcode = 'P0002';
    end if;
    -- S11: only an approved sale releases; a refund never enters the release path.
    if v_payment.state <> 'approved' then
      raise exception 'payment % is %; only an approved payment releases a batch', v_payment.number, v_payment.state
        using errcode = '22023';
    end if;
    if v_ref is null then
      raise exception 'a released batch needs a payment ref' using errcode = '22004';
    end if;

    if v_batch.state = 'released' then
      -- S2: same payment re-synced = silent no-op.
      if v_batch.payment_id = p_payment_id then
        return v_result || jsonb_build_object('status', 'noop');
      end if;
      -- S7 v1.1: a payment for a MANUAL release with no payment is adopted as the original.
      if v_batch.payment_id is null and v_batch.payment_ref = 'MANUAL' then
        update public.storage_pickup_batch
        set payment_id = p_payment_id, payment_ref = v_ref, paid_at = coalesce(paid_at, now())
        where id = v_batch.id;
        update public.charge set state = 'settled', settled_payment_id = p_payment_id
        where id = v_batch.charge_id and state = 'open';
        perform app.storage_batch_note(v_batch.id, 'error', 'adopted_payment',
          format('payment %s (%s) adopted as the original payment of this MANUAL release', v_payment.number, v_ref));
        return v_result || jsonb_build_object('status', 'adopted');
      end if;
      -- S2: a second payment never releases twice.
      perform app.storage_batch_note(v_batch.id, 'critical', 'charged_twice',
        format('payment %s (%s) arrived for a batch already released as %s; refund it at the register',
               v_payment.number, v_ref, v_batch.payment_ref));
      return v_result || jsonb_build_object('status', 'duplicate_payment');
    end if;

    if v_batch.state = 'void' then
      -- S6: paid-while-void — no release; the money is recorded for the manager remedy.
      update public.storage_pickup_batch
      set payment_id = coalesce(payment_id, p_payment_id),
          payment_ref = coalesce(payment_ref, v_ref),
          paid_at = coalesce(paid_at, now())
      where id = v_batch.id;
      perform app.storage_batch_note(v_batch.id, 'critical', 'paid_while_void',
        format('payment %s (%s) arrived for a void batch; not released — Force Release or refund at the register',
               v_payment.number, v_ref));
      return v_result || jsonb_build_object('status', 'paid_while_void');
    end if;

    if v_batch.payment_id is not null and v_batch.payment_id <> p_payment_id then
      perform app.storage_batch_note(v_batch.id, 'critical', 'charged_twice',
        format('payment %s (%s) arrived for a batch already paid by %s; refund it at the register',
               v_payment.number, v_ref, v_batch.payment_ref));
      return v_result || jsonb_build_object('status', 'duplicate_payment');
    end if;

    -- S12: batch.amount is untaxed; compare the untaxed paid amount.
    if p_paid_amount is not null and p_paid_amount <> v_batch.amount then
      perform app.storage_batch_note(v_batch.id, 'warning', 'amount_mismatch',
        format('paid %s (untaxed) but the batch amount is %s', p_paid_amount, v_batch.amount));
    end if;
  else
    if v_reason is null then
      raise exception 'a reason is required' using errcode = '22023';
    end if;
    if v_batch.state = 'released' then
      raise exception '% is already released', v_batch.number using errcode = '55000';
    end if;
    v_ref := case p_mode when 'comp' then 'COMP' else coalesce(v_ref, v_batch.payment_ref, 'MANUAL') end;
  end if;

  -- S1: exactly the batch's boxes, minus boxes already released elsewhere (logged, skipped).
  perform 1 from public.storage_box where id = any (v_batch.box_ids) order by id for update;
  select coalesce(array_agg(b.id order by b.box_no), '{}') into v_released
  from public.storage_box b
  where b.id = any (v_batch.box_ids) and b.storage_intake_id = v_intake.id and b.state = 'stored';
  select coalesce(array_agg(x order by x), '{}') into v_skipped
  from unnest(v_batch.box_ids) x where x <> all (v_released);

  if p_mode <> 'payment' and cardinality(v_released) = 0 then
    raise exception 'every box of % is already released', v_batch.number using errcode = '55000';
  end if;
  if cardinality(v_skipped) > 0 then
    perform app.storage_batch_note(v_batch.id, 'error', 'box_already_released', format(
      'skipped boxes already released elsewhere: %s', (
        select string_agg(coalesce(b.label || coalesce(' by ' || ob.number, ''), x::text), ', ')
        from unnest(v_skipped) x
        left join public.storage_box b on b.id = x
        left join public.storage_pickup_batch ob on ob.id = b.batch_id)));
  end if;

  -- Billed days are the batch snapshot. A batch released on a later org-local day than it was
  -- quoted keeps its quoted (charged) days; the drift is noted so a manager can see it.
  select coalesce(sum(app.storage_box_days(b)), 0), coalesce(sum((v_batch.box_days ->> b.id::text)::int), 0)
  into v_days_now, v_days_billed
  from public.storage_box b where b.id = any (v_released);
  if v_days_now <> v_days_billed then
    perform app.storage_batch_note(v_batch.id, 'warning', 'stale_quote', format(
      'released on a later day than quoted: billed %s box-days as quoted %s; %s box-days as of release',
      v_days_billed, to_char(v_batch.snapshot_at at time zone coalesce(
        (select o.timezone from public.org o where o.id = v_batch.org_id), 'UTC'), 'YYYY-MM-DD'), v_days_now));
  end if;

  update public.storage_box
  set state = 'released', released_at = now(), released_by = v_by, batch_id = v_batch.id
  where id = any (v_released);

  if v_batch.state = 'void' then
    -- void → released is a manager edge (docs/03-STATE-MACHINES.md); scoped to this row.
    perform set_config('app.forced_transition',
      format('storage_pickup_batch:%s:released', v_batch.id), true);
  end if;
  update public.storage_pickup_batch
  set state = 'released',
      released_at = now(),
      released_by = v_by,
      payment_ref = v_ref,
      payment_id = coalesce(p_payment_id, payment_id),
      paid_at = coalesce(paid_at, now())
  where id = v_batch.id
  returning * into v_batch;
  perform set_config('app.forced_transition', '', true);

  select * into v_charge from public.charge where id = v_batch.charge_id for update;
  if p_mode = 'comp' then
    update public.charge set state = 'comped', comp_reason = v_reason
    where id = v_charge.id and state in ('open', 'voided');
    perform app.storage_batch_note(v_batch.id, 'info', 'comp',
      format('COMP: waived %s — %s', v_batch.amount, v_reason));
  elsif v_batch.payment_id is not null then
    update public.charge set state = 'settled', settled_payment_id = v_batch.payment_id
    where id = v_charge.id and state in ('open', 'voided');
  else
    -- MANUAL without a recorded payment: the charge stays owed; a payment that arrives
    -- later is adopted (S7).
    update public.charge set state = 'open' where id = v_charge.id and state = 'voided';
  end if;
  if p_mode = 'manual' then
    perform app.storage_batch_note(v_batch.id, 'info', 'force_release',
      format('Force Release (%s) — %s', v_ref, v_reason));
  end if;

  -- Pending batches holding any released box are now stale: supersede them.
  for v_other in
    select * from public.storage_pickup_batch
    where storage_intake_id = v_intake.id and state = 'pending' and id <> v_batch.id and box_ids && v_released
    order by id
    for update
  loop
    if v_other.release_failed or v_other.payment_id is not null then
      perform app.storage_batch_note(v_other.id, 'critical', 'boxes_released_elsewhere',
        format('boxes of this paid batch were released by %s; Force Release or refund at the register', v_batch.number));
    else
      perform app.void_pickup_batch(v_other.id, format('superseded: boxes released by %s', v_batch.number));
    end if;
  end loop;

  -- S9: intake rollup; paid markers only when fully released, refs ' / '-joined.
  select count(*) into v_left from public.storage_box where storage_intake_id = v_intake.id and state = 'stored';
  v_state := case when v_left = 0 then 'released'::public.storage_intake_state
                  else 'partial'::public.storage_intake_state end;
  if v_intake.state in ('stored', 'partial') and v_state is distinct from v_intake.state then
    update public.storage_intake set state = v_state where id = v_intake.id;
  end if;
  if v_left = 0 and v_intake.state in ('stored', 'partial') then
    update public.storage_intake
    set paid_at = now(),
        payment_ref = (
          select string_agg(r.ref, ' / ' order by r.first_at, r.first_number)
          from (
            select pb.payment_ref as ref, min(pb.released_at) as first_at, min(pb.number) as first_number
            from public.storage_pickup_batch pb
            where pb.storage_intake_id = v_intake.id and pb.state = 'released' and pb.payment_ref is not null
            group by pb.payment_ref
          ) r)
    where id = v_intake.id;
  end if;

  return v_result || jsonb_build_object(
    'status', 'released',
    'released_box_ids', to_jsonb(v_released),
    'skipped_box_ids', to_jsonb(v_skipped),
    'intake_state', (select state from public.storage_intake where id = v_intake.id),
    'payment_ref', v_ref);
end;
$$;

-- The paid hook's batch loop (WP-16 calls it inside apply_paid_register_order). One
-- savepoint per batch (S8): a failure rolls back only that batch, then — OUTSIDE the
-- savepoint, intake row locked first — stamps release_failed + the payment + a note (S6),
-- so the loader can refuse the batch and a manager can Force Release it. Batches run in
-- (intake, id) order. Returns one result per batch.
create or replace function app.release_pickup_batches(
  p_batch_ids uuid[], p_payment_id uuid, p_payment_ref text, p_paid_amounts jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payment;
  v_row record;
  v_r jsonb;
  v_results jsonb := '[]'::jsonb;
  v_msg text;
begin
  select * into v_payment from public.payment where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  -- S11: a refund / reversal never enters the release path (and never stamps a batch).
  if v_payment.state <> 'approved' then
    raise exception 'payment % is %; only an approved payment releases batches', v_payment.number, v_payment.state
      using errcode = '22023';
  end if;
  if nullif(btrim(p_payment_ref), '') is null then
    raise exception 'a released batch needs a payment ref' using errcode = '22004';
  end if;

  for v_row in
    select x.id, b.storage_intake_id, b.org_id
    from unnest(p_batch_ids) x (id)
    left join public.storage_pickup_batch b on b.id = x.id
    order by b.storage_intake_id nulls last, x.id
  loop
    if v_row.storage_intake_id is null or v_row.org_id <> v_payment.org_id then
      v_results := v_results || jsonb_build_object('batch_id', v_row.id, 'status', 'not_found');
      continue;
    end if;
    begin
      v_r := app.release_pickup_batch(v_row.id, p_payment_ref, 'payment', p_payment_id, null, null,
                                      (p_paid_amounts ->> v_row.id::text)::numeric);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      perform 1 from public.storage_intake where id = v_row.storage_intake_id for update;
      update public.storage_pickup_batch
      set release_failed = true,
          payment_id = coalesce(payment_id, p_payment_id),
          payment_ref = coalesce(payment_ref, btrim(p_payment_ref)),
          paid_at = coalesce(paid_at, now())
      where id = v_row.id;
      perform app.storage_batch_note(v_row.id, 'error', 'release_failed',
        format('payment %s (%s) captured but release failed: %s — Force Release', v_payment.number,
               btrim(p_payment_ref), v_msg));
      v_r := jsonb_build_object('batch_id', v_row.id, 'status', 'release_failed', 'error', v_msg);
    end;
    v_results := v_results || v_r;
  end loop;
  return v_results;
end;
$$;

-- Manager Force Release (p_mode 'manual') and COMP (p_mode 'comp'), reason required: an
-- owner/manager session, or a station presenting a live manager elevation (manager PIN).
create or replace function public.force_release_pickup_batch(
  p_client_action_id text,
  p_batch_id uuid,
  p_mode text,
  p_reason text,
  p_payment_ref text default null,
  p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager uuid;
  v_action jsonb;
  v_result jsonb;
begin
  if p_elevation_token is not null then
    v_manager := app.require_elevation(p_elevation_token);
  else
    perform app.require_role('{owner,manager}');
    select m.id into v_manager from public.org_member m where m.user_id = app.user_id() and m.org_id = app.org_id();
  end if;
  if p_mode is null or p_mode not in ('manual', 'comp') then
    raise exception 'mode must be manual (Force Release) or comp' using errcode = '22023';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'storage.force_release', jsonb_build_object(
    'batch_id', p_batch_id, 'mode', p_mode, 'reason', btrim(p_reason), 'payment_ref', p_payment_ref,
    'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  if not exists (select 1 from public.storage_pickup_batch where id = p_batch_id and org_id = app.org_id()) then
    raise exception 'pickup batch not found' using errcode = 'P0002';
  end if;
  v_result := app.release_pickup_batch(p_batch_id, p_payment_ref, p_mode, null, p_reason, v_manager)
              || jsonb_build_object('approved_by', v_manager);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Receipt -------------------------------------------------------------------------------------

-- What a pickup receipt prints: one line per box with the days the batch billed (its
-- snapshot, made by app.storage_box_days — which also returns these days for the boxes once
-- the batch releases them, so receipt = box view), the snapshotted rate, and the batch amount
-- (= the lines' sum).
create or replace function public.storage_pickup_receipt(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch public.storage_pickup_batch;
  v_intake public.storage_intake;
  v_tz text;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  select * into v_batch from public.storage_pickup_batch where id = p_batch_id and org_id = app.org_id();
  if not found then
    raise exception 'pickup batch not found' using errcode = 'P0002';
  end if;
  select * into v_intake from public.storage_intake where id = v_batch.storage_intake_id;
  select coalesce(o.timezone, 'UTC') into v_tz from public.org o where o.id = v_batch.org_id;
  return jsonb_build_object(
    'batch_id', v_batch.id,
    'number', v_batch.number,
    'state', v_batch.state,
    'storage_number', v_intake.number,
    'customer', (select c.name from public.customer c where c.id = v_intake.customer_id),
    'date', to_char(coalesce(v_batch.released_at, v_batch.snapshot_at) at time zone v_tz, 'YYYY-MM-DD'),
    'rate', v_batch.rate_per_box_day,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'box_id', b.id, 'box_no', b.box_no, 'label', b.label, 'days', d.days,
               'rate', v_batch.rate_per_box_day, 'amount', round(v_batch.rate_per_box_day * d.days, 2))
             order by b.box_no), '[]'::jsonb)
      from public.storage_box b
      cross join lateral (
        select (v_batch.box_days ->> b.id::text)::int as days
      ) d
      where b.id = any (v_batch.box_ids)),
    'total', v_batch.amount,
    'payment_ref', v_batch.payment_ref,
    'paid_at', v_batch.paid_at,
    'released_at', v_batch.released_at
  );
end;
$$;

-- Grants ------------------------------------------------------------------------------------

revoke all on function
  app.storage_batch_notes_append_only(),
  app.storage_batch_note(uuid, text, text, text),
  app.storage_box_days(public.storage_box, timestamptz),
  app.storage_rate(uuid),
  app.storage_snapshot(uuid, uuid[], timestamptz),
  app.next_free_number(uuid, text, regclass),
  app.storage_label_data(uuid),
  app.void_pickup_batch(uuid, text),
  app.release_pickup_batch(uuid, text, text, uuid, text, uuid, numeric),
  app.release_pickup_batches(uuid[], uuid, text, jsonb)
from public;
-- The box view runs with the caller's rights and calls the day-count function.
grant execute on function app.storage_box_days(public.storage_box, timestamptz) to authenticated, service_role;
grant execute on function
  app.release_pickup_batch(uuid, text, text, uuid, text, uuid, numeric),
  app.release_pickup_batches(uuid[], uuid, text, jsonb)
to service_role;

revoke all on function
  public.confirm_storage_intake(text, jsonb),
  public.storage_label_data(uuid),
  public.queue_storage_labels(text, uuid, jsonb),
  public.storage_pickup_quote(uuid, uuid[]),
  public.create_pickup_batch(text, uuid, uuid[]),
  public.cancel_pickup_batch(text, uuid),
  public.force_release_pickup_batch(text, uuid, text, text, text, text),
  public.storage_pickup_receipt(uuid)
from public, anon, authenticated;

grant execute on function
  public.confirm_storage_intake(text, jsonb),
  public.storage_label_data(uuid),
  public.queue_storage_labels(text, uuid, jsonb),
  public.storage_pickup_quote(uuid, uuid[]),
  public.create_pickup_batch(text, uuid, uuid[]),
  public.cancel_pickup_batch(text, uuid),
  public.force_release_pickup_batch(text, uuid, text, text, text, text),
  public.storage_pickup_receipt(uuid)
to authenticated;
