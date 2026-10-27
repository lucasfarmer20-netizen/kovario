-- WP-07 sport intake station (docs/06-STATIONS-UX.md Intake, docs/04-BUSINESS-RULES.md §1–§3,
-- docs/02-DOMAIN-MODEL.md §4):
--   * save_intake — one transaction: INT- number, rate card + lodge flag snapshot, lines with
--     the rules engine's yield snapshot, charges priced from the snapshotted card by
--     app.price_per_lb (generated from packages/rules), tote_tag rows, locked, → holding,
--     print_job rows (tote tags + optional receipt);
--   * unlock_intake (manager), re-save (re-creates only the charges that are still open);
--   * reprint / print receipt;
--   * the lodge-flip reprice, run by the WP-06 customer_lodge_flag_changed event.
-- The station computes lines + charge drafts with packages/rules (savePayload) and never
-- sends a price; this file enforces structure only (draft ↔ line consistency, locks).
-- Print transport and label rendering are WP-08: here a print_job is just a row whose
-- `source` names the template and ids; `payload` stays empty until WP-08 renders it.

-- charge: which rate-card key priced it (the reprice re-reads it) and which line made it.
alter table public.charge
  add column if not exists rate_key text,
  add column if not exists intake_line_id uuid references public.intake_line (id) on delete set null;

create index if not exists charge_intake_line_id on public.charge (intake_line_id);

-- A saved intake is read-only until a manager unlocks it ---------------------------------
create or replace function app.intake_line_guard_locked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A cascaded delete (org or intake removed) runs inside the FK trigger: let it through.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if (tg_op <> 'INSERT' and exists (select 1 from public.intake where id = old.intake_id and locked))
     or (tg_op <> 'DELETE' and exists (select 1 from public.intake where id = new.intake_id and locked)) then
    raise exception 'intake is locked; a manager must unlock it first' using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists intake_line_guard_locked on public.intake_line;
create trigger intake_line_guard_locked before insert or update or delete on public.intake_line
  for each row execute function app.intake_line_guard_locked();

-- Rate card + printers -------------------------------------------------------------------

-- The card in force on `p_on`: the dated card covering it, else the org's default card.
create or replace function app.intake_rate_card(p_org_id uuid, p_on date)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.rate_card c
  where c.org_id = p_org_id
    and (c.is_default or daterange(c.starts_on, c.ends_on, '[]') @> p_on)
  order by c.is_default, c.starts_on desc nulls last
  limit 1
$$;

create or replace function app.rate_card_rates(p_rate_card_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(l.key, l.amount), '{}'::jsonb)
  from public.rate_card_line l where l.rate_card_id = p_rate_card_id
$$;

create or replace function app.org_today(p_org_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(o.timezone, 'UTC'))::date from public.org o where o.id = p_org_id
$$;

-- The printer for a job: the calling station's own printer, else the site's printer of that
-- kind whose is_default_for marks the job kind ({"tote_tag": true}). Never an org-wide
-- default (docs/10-LESSONS-FROM-CSP.md §1). Null when none is configured.
create or replace function app.station_printer(
  p_site_id uuid, p_kind public.printer_kind, p_job public.print_job_kind
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select case when p_kind = 'label_zpl' then d.printer_label_id else d.printer_receipt_id end
     from public.device d
     where d.id = app.device_id() and d.org_id = app.org_id()),
    (select p.id from public.printer p
     where p.org_id = app.org_id() and p.site_id = p_site_id and p.kind = p_kind
       and coalesce(p.is_default_for ->> p_job::text, 'false') = 'true'
     order by p.created_at, p.id
     limit 1)
  )
$$;

-- One tote_tag job per tote; returns how many were queued (0 when no printer is set up).
create or replace function app.queue_intake_tote_jobs(p_intake_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.intake;
  v_printer uuid;
  v_tag public.tote_tag;
  v_job uuid;
  v_n int := 0;
begin
  select * into v_intake from public.intake where id = p_intake_id;
  v_printer := app.station_printer(v_intake.site_id, 'label_zpl', 'tote_tag');
  if v_printer is null then
    return 0;
  end if;
  for v_tag in
    select * from public.tote_tag where intake_id = p_intake_id order by tote_no
  loop
    insert into public.print_job (org_id, printer_id, kind, payload_type, payload, source)
    values (v_intake.org_id, v_printer, 'tote_tag', 'zpl', '', jsonb_build_object(
      'template', 'tote_tag', 'intake_id', v_intake.id, 'intake_number', v_intake.number,
      'tote_tag_id', v_tag.id, 'tote_no', v_tag.tote_no, 'of_count', v_tag.of_count, 'qr', v_tag.qr))
    returning id into v_job;
    update public.tote_tag set print_job_id = v_job where id = v_tag.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function app.queue_intake_receipt_job(p_intake_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.intake;
  v_printer uuid;
  v_job uuid;
begin
  select * into v_intake from public.intake where id = p_intake_id;
  v_printer := app.station_printer(v_intake.site_id, 'receipt_pdf', 'receipt');
  if v_printer is null then
    return null;
  end if;
  insert into public.print_job (org_id, printer_id, kind, payload_type, payload, source)
  values (v_intake.org_id, v_printer, 'receipt', 'pdf_url', '', jsonb_build_object(
    'template', 'intake_receipt', 'intake_id', v_intake.id, 'intake_number', v_intake.number))
  returning id into v_job;
  return v_job;
end;
$$;

-- Price context for the live price panel ---------------------------------------------------

-- Rates the station previews with packages/rules buildIntakeDraft: the card save_intake will
-- snapshot (the intake's own card when `p_intake_id` is given), per-method lodge_cappable,
-- and the customer's lodge flag and cap.
create or replace function public.intake_price_context(
  p_customer_id uuid default null, p_intake_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_card uuid;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if p_intake_id is not null then
    select i.rate_card_id into v_card from public.intake i where i.id = p_intake_id and i.org_id = v_org;
  end if;
  v_card := coalesce(v_card, app.intake_rate_card(v_org, app.org_today(v_org)));
  return jsonb_build_object(
    'rate_card', (select jsonb_build_object('id', c.id, 'name', c.name)
                  from public.rate_card c where c.id = v_card),
    'rates', app.rate_card_rates(v_card),
    'lodge_cappable', (select coalesce(jsonb_object_agg(m.code, m.lodge_cappable), '{}'::jsonb)
                       from public.processing_method m where m.org_id = v_org and m.kind = 'service'),
    'customer', (select jsonb_build_object(
                   'id', c.id, 'name', c.name, 'phone', c.phone, 'is_lodge_guest', c.is_lodge_guest,
                   'lodge_id', c.lodge_id, 'lodge_name', l.name, 'lodge_cap', l.pricing_cap)
                 from public.customer c left join public.lodge l on l.id = c.lodge_id
                 where c.id = p_customer_id and c.org_id = v_org)
  );
end;
$$;

-- save_intake -------------------------------------------------------------------------------

-- p_payload is packages/rules SaveIntakePayload:
--   {intake_id?, customer_id, site_id?, tote_count, dirty_fish, dirty_notes, cut_notes,
--    processing_notes, fast_pass, print_receipt,
--    lines:   [{species_code, condition_code, method_code, lb, fillets_pct, skin_off,
--              yield_factor, notes}],
--    charges: [{kind: processing|ribbing, line_index, rate_key, qty, description}]}
-- Without intake_id it creates the intake; with one it re-saves an unlocked intake: lines are
-- replaced, the intake's open charges are voided and re-created, and charges already settled
-- or comped are kept (a draft matching a kept charge's kind + rate key is not re-created).
-- Locks: customer row(s) by id, then the intake — the same order as the lodge flip
-- (customer → its charges), so a flip either precedes the save (the new flag is snapshotted)
-- or follows it (its reprice sees these charges).
create or replace function public.save_intake(p_client_action_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_action jsonb;
  v_intake public.intake;
  v_customer public.customer;
  v_customer_id uuid;
  v_previous_customer uuid;
  v_intake_id uuid;
  v_number text;
  v_site uuid;
  v_card uuid;
  v_rates jsonb;
  v_cap numeric;
  v_fast_pass boolean;
  v_tote_count int;
  v_lines jsonb;
  v_charges jsonb;
  v_line jsonb;
  v_charge jsonb;
  v_n int;
  v_idx int;
  v_line_ids uuid[] := '{}';
  v_id uuid;
  v_kept jsonb;
  v_key text;
  v_list numeric;
  v_price numeric;
  v_created int := 0;
  v_kept_n int := 0;
  v_voided int := 0;
  v_tote_jobs int;
  v_receipt uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload must be an object' using errcode = '22023';
  end if;
  v_action := app.action_begin(p_client_action_id, 'intake.save', p_payload);
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  v_lines := p_payload -> 'lines';
  v_charges := p_payload -> 'charges';
  v_customer_id := nullif(p_payload ->> 'customer_id', '')::uuid;
  v_intake_id := nullif(p_payload ->> 'intake_id', '')::uuid;
  v_fast_pass := coalesce((p_payload ->> 'fast_pass')::boolean, false);
  v_tote_count := (p_payload ->> 'tote_count')::int;
  if v_customer_id is null then
    raise exception 'customer is required' using errcode = '22004';
  end if;
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'an intake needs at least one line' using errcode = '22023';
  end if;
  if jsonb_typeof(v_charges) is distinct from 'array' then
    raise exception 'charges must be an array' using errcode = '22023';
  end if;
  if v_tote_count is null or v_tote_count < 1 then
    raise exception 'tote count must be at least 1' using errcode = '22023';
  end if;

  -- Charge drafts must be the rules engine's expansion of these lines: processing qty sums to
  -- the line's lb (to the stored 2 dp), the rate key is the line's method (fresh → fillets /
  -- portions), and exactly one ribbing draft per filleted_ribs line, at the line's lb.
  if exists (
    select 1 from jsonb_array_elements(v_charges) c
    where c ->> 'kind' not in ('processing', 'ribbing')
       or (c ->> 'line_index')::int not between 0 and jsonb_array_length(v_lines) - 1
       or (c ->> 'qty')::numeric < 0
       or (c ->> 'kind' = 'ribbing' and (c ->> 'rate_key' is distinct from 'ribbing_per_lb'
             or (c ->> 'qty')::numeric <> (v_lines -> ((c ->> 'line_index')::int) ->> 'lb')::numeric))
       or (c ->> 'kind' = 'processing' and not (
             c ->> 'rate_key' = v_lines -> ((c ->> 'line_index')::int) ->> 'method_code'
             or (v_lines -> ((c ->> 'line_index')::int) ->> 'method_code' = 'fresh'
                 and c ->> 'rate_key' in ('fillets', 'portions'))))
  ) or exists (
    select 1 from jsonb_array_elements(v_lines) with ordinality as l (v, n)
    where abs((l.v ->> 'lb')::numeric - coalesce((
            select sum((c ->> 'qty')::numeric) from jsonb_array_elements(v_charges) c
            where c ->> 'kind' = 'processing' and (c ->> 'line_index')::int = l.n - 1), -1)) > 0.01
       or (select count(*) from jsonb_array_elements(v_charges) c
           where c ->> 'kind' = 'ribbing' and (c ->> 'line_index')::int = l.n - 1)
          <> case when l.v ->> 'condition_code' = 'filleted_ribs' then 1 else 0 end
  ) then
    raise exception 'charge drafts do not match the intake lines' using errcode = '22023';
  end if;

  if v_intake_id is not null then
    select i.customer_id into v_previous_customer
    from public.intake i where i.id = v_intake_id and i.org_id = v_org;
    if not found then
      raise exception 'intake not found' using errcode = 'P0002';
    end if;
  end if;

  perform 1 from public.customer
  where org_id = v_org and id in (v_customer_id, v_previous_customer)
  order by id
  for update;
  select * into v_customer from public.customer where id = v_customer_id and org_id = v_org;
  if not found then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if v_customer.is_lodge_guest then
    select l.pricing_cap into v_cap from public.lodge l where l.id = v_customer.lodge_id;
  end if;

  v_site := nullif(p_payload ->> 'site_id', '')::uuid;
  if v_site is not null and not exists (select 1 from public.site where id = v_site and org_id = v_org) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;

  if v_intake_id is null then
    v_card := app.intake_rate_card(v_org, app.org_today(v_org));
    if v_card is null then
      raise exception 'no active rate card; set one up in Admin → Rate cards' using errcode = 'P0002';
    end if;
    v_site := coalesce(
      v_site,
      (select d.site_id from public.device d where d.id = app.device_id() and d.org_id = v_org),
      (select s.id from public.site s where s.org_id = v_org and s.is_default)
    );
    -- next_seq holds the counter row lock; skip numbers taken by rows inserted outside it
    -- (seed fixtures, imports) so a save never fails on the unique number.
    loop
      v_number := app.next_seq(v_org, 'intake');
      exit when not exists (select 1 from public.intake where org_id = v_org and number = v_number);
    end loop;
    insert into public.intake (
      org_id, number, customer_id, site_id, state, tote_count, dirty_fish, dirty_notes, cut_notes,
      processing_notes, fast_pass, is_lodge_guest, rate_card_id, locked
    ) values (
      v_org, v_number, v_customer_id, v_site, 'draft', v_tote_count,
      coalesce((p_payload ->> 'dirty_fish')::boolean, false), p_payload ->> 'dirty_notes',
      p_payload ->> 'cut_notes', p_payload ->> 'processing_notes', v_fast_pass,
      v_customer.is_lodge_guest, v_card, false
    ) returning * into v_intake;
    update public.customer set last_visit_at = now() where id = v_customer_id;
  else
    select * into v_intake from public.intake where id = v_intake_id for update;
    if v_intake.customer_id is distinct from v_previous_customer then
      raise exception 'intake changed while saving; try again' using errcode = '40001';
    end if;
    if v_intake.locked then
      raise exception 'intake is locked; a manager must unlock it first' using errcode = '55000';
    end if;
    if v_intake.state not in ('draft', 'holding') then
      raise exception 'only an intake still in the cooler can be edited' using errcode = '55000';
    end if;
    v_card := coalesce(v_intake.rate_card_id, app.intake_rate_card(v_org, app.org_today(v_org)));
    update public.intake
    set customer_id = v_customer_id,
        site_id = coalesce(v_site, site_id),
        tote_count = v_tote_count,
        dirty_fish = coalesce((p_payload ->> 'dirty_fish')::boolean, false),
        dirty_notes = p_payload ->> 'dirty_notes',
        cut_notes = p_payload ->> 'cut_notes',
        processing_notes = p_payload ->> 'processing_notes',
        fast_pass = v_fast_pass,
        is_lodge_guest = v_customer.is_lodge_guest,
        rate_card_id = v_card
    where id = v_intake.id
    returning * into v_intake;
    delete from public.intake_line where intake_id = v_intake.id;
  end if;
  if v_card is null then
    raise exception 'no active rate card; set one up in Admin → Rate cards' using errcode = 'P0002';
  end if;
  v_rates := app.rate_card_rates(v_card);

  -- Lines, with the rules engine's yield snapshot.
  for v_line, v_n in select l.v, l.n from jsonb_array_elements(v_lines) with ordinality as l (v, n) loop
    insert into public.intake_line (
      org_id, intake_id, sort, species_code, condition_code, method_code, lb, fillets_pct,
      skin_off, yield_factor, notes
    ) values (
      v_org, v_intake.id, v_n - 1, v_line ->> 'species_code', v_line ->> 'condition_code',
      v_line ->> 'method_code', (v_line ->> 'lb')::numeric, (v_line ->> 'fillets_pct')::numeric,
      coalesce((v_line ->> 'skin_off')::boolean, false), (v_line ->> 'yield_factor')::numeric,
      nullif(btrim(v_line ->> 'notes'), '')
    ) returning id into v_id;
    v_line_ids := v_line_ids || v_id;
  end loop;

  -- Charges: open ones are re-created; settled / comped ones are kept.
  update public.charge
  set state = 'voided'
  where source_type = 'intake' and source_id = v_intake.id and state = 'open';
  get diagnostics v_voided = row_count;
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_kept
  from (
    select ch.kind::text || '|' || coalesce(ch.rate_key, '') as k, count(*) as n
    from public.charge ch
    where ch.source_type = 'intake' and ch.source_id = v_intake.id and ch.state in ('settled', 'comped')
    group by 1
  ) kept;

  for v_charge in select c from jsonb_array_elements(v_charges) c loop
    v_key := (v_charge ->> 'kind') || '|' || (v_charge ->> 'rate_key');
    if coalesce((v_kept ->> v_key)::int, 0) > 0 then
      v_kept := jsonb_set(v_kept, array[v_key], to_jsonb((v_kept ->> v_key)::int - 1));
      v_kept_n := v_kept_n + 1;
      continue;
    end if;
    if v_charge ->> 'kind' = 'processing' and not exists (
      select 1 from public.processing_method m
      where m.org_id = v_org and m.code = v_charge ->> 'rate_key' and m.kind = 'service'
    ) then
      raise exception 'unknown processing method %', v_charge ->> 'rate_key' using errcode = '22023';
    end if;
    v_list := (v_rates ->> (v_charge ->> 'rate_key'))::numeric;
    if v_list is null then
      raise exception 'the rate card has no rate for %', v_charge ->> 'rate_key' using errcode = 'P0002';
    end if;
    v_price := app.price_per_lb(
      case when v_charge ->> 'kind' = 'ribbing' then 'ribbing' else v_charge ->> 'rate_key' end,
      v_list,
      v_fast_pass,
      (v_rates ->> 'fast_pass_per_lb')::numeric,
      v_customer.is_lodge_guest,
      v_cap,
      (select m.lodge_cappable from public.processing_method m
       where m.org_id = v_org and m.code = v_charge ->> 'rate_key')
    );
    v_idx := (v_charge ->> 'line_index')::int;
    insert into public.charge (
      org_id, number, customer_id, kind, source_type, source_id, description, qty, unit,
      unit_price, rate_key, intake_line_id
    ) values (
      v_org, app.next_seq(v_org, 'charge'), v_customer_id, (v_charge ->> 'kind')::public.charge_kind,
      'intake', v_intake.id, v_charge ->> 'description', (v_charge ->> 'qty')::numeric, 'lb',
      v_price, v_charge ->> 'rate_key', v_line_ids[v_idx + 1]
    );
    v_created := v_created + 1;
  end loop;

  -- Tote tags 1..n (QR from the generated app.qr_tote).
  delete from public.tote_tag where intake_id = v_intake.id and tote_no > v_tote_count;
  insert into public.tote_tag (org_id, intake_id, tote_no, of_count, qr)
  select v_org, v_intake.id, n, v_tote_count, app.qr_tote(v_intake.number, n)
  from generate_series(1, v_tote_count) n
  on conflict (intake_id, tote_no) do update set of_count = excluded.of_count;

  update public.intake set locked = true, state = 'holding' where id = v_intake.id
  returning * into v_intake;

  v_tote_jobs := app.queue_intake_tote_jobs(v_intake.id);
  if coalesce((p_payload ->> 'print_receipt')::boolean, false) then
    v_receipt := app.queue_intake_receipt_job(v_intake.id);
  end if;

  v_result := jsonb_build_object(
    'intake_id', v_intake.id,
    'number', v_intake.number,
    'state', v_intake.state,
    'locked', v_intake.locked,
    'charges_created', v_created,
    'charges_kept', v_kept_n,
    'charges_voided', v_voided,
    'tote_tags', v_tote_count,
    'tote_jobs_queued', v_tote_jobs,
    'receipt_job_id', v_receipt,
    'printer_missing', v_tote_jobs = 0
  );
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Unlock (manager) ------------------------------------------------------------------------

-- A manager, or a station presenting a live manager elevation (manager PIN), unlocks a
-- saved intake still in the cooler so it can be edited and re-saved. action_log records it
-- (with the approving manager and reason).
create or replace function public.unlock_intake(
  p_client_action_id text, p_intake_id uuid, p_reason text default null,
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
  v_intake public.intake;
  v_result jsonb;
begin
  if p_elevation_token is not null then
    v_manager := app.require_elevation(p_elevation_token);
  else
    perform app.require_role('{owner,manager}');
  end if;
  v_action := app.action_begin(p_client_action_id, 'intake.unlock', jsonb_build_object(
    'intake_id', p_intake_id, 'reason', nullif(btrim(p_reason), ''), 'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_intake from public.intake
  where id = p_intake_id and org_id = app.org_id()
  for update;
  if not found then
    raise exception 'intake not found' using errcode = 'P0002';
  end if;
  if v_intake.state not in ('draft', 'holding') then
    raise exception 'only an intake still in the cooler can be unlocked' using errcode = '55000';
  end if;
  update public.intake set locked = false where id = p_intake_id;

  v_result := jsonb_build_object('intake_id', p_intake_id, 'number', v_intake.number,
    'locked', false, 'approved_by', v_manager);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Reprint / receipt -----------------------------------------------------------------------

create or replace function public.reprint_intake_tote_tags(p_client_action_id text, p_intake_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_n int;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'intake.reprint_tote_tags',
    jsonb_build_object('intake_id', p_intake_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  if not exists (select 1 from public.intake where id = p_intake_id and org_id = app.org_id()) then
    raise exception 'intake not found' using errcode = 'P0002';
  end if;
  v_n := app.queue_intake_tote_jobs(p_intake_id);
  v_result := jsonb_build_object('intake_id', p_intake_id, 'tote_jobs_queued', v_n,
    'printer_missing', v_n = 0);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

create or replace function public.print_intake_receipt(p_client_action_id text, p_intake_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_job uuid;
  v_result jsonb;
begin
  perform app.require_role('{owner,manager,staff,cashier,station}');
  v_action := app.action_begin(p_client_action_id, 'intake.print_receipt',
    jsonb_build_object('intake_id', p_intake_id));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;
  if not exists (select 1 from public.intake where id = p_intake_id and org_id = app.org_id()) then
    raise exception 'intake not found' using errcode = 'P0002';
  end if;
  v_job := app.queue_intake_receipt_job(p_intake_id);
  v_result := jsonb_build_object('intake_id', p_intake_id, 'receipt_job_id', v_job,
    'printer_missing', v_job is null);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

-- Lodge-flip reprice (docs/04-BUSINESS-RULES.md §2) ----------------------------------------

-- Reprices the customer's open, unpaid processing charges on non-Fast-Pass intakes from each
-- intake's snapshotted rate card with the customer's current lodge flag and cap. Fast Pass
-- is never repriced and ribbing never capped. Returns the number of charges changed.
create or replace function app.reprice_customer_open_charges(p_customer_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customer;
  v_cap numeric;
  v_n int;
begin
  select * into v_customer from public.customer where id = p_customer_id;
  if not found then
    return 0;
  end if;
  if v_customer.is_lodge_guest then
    select l.pricing_cap into v_cap from public.lodge l where l.id = v_customer.lodge_id;
  end if;

  perform 1 from public.charge ch
  where ch.customer_id = p_customer_id and ch.kind = 'processing' and ch.state = 'open'
    and ch.settled_payment_id is null and ch.source_type = 'intake'
  order by ch.id
  for update;

  with priced as (
    select ch.id,
           app.price_per_lb(ch.rate_key, rl.amount, false, null, v_customer.is_lodge_guest, v_cap,
                            m.lodge_cappable) as price
    from public.charge ch
    join public.intake i on i.id = ch.source_id and not i.fast_pass
    join public.rate_card_line rl on rl.rate_card_id = i.rate_card_id and rl.key = ch.rate_key
    left join public.processing_method m on m.org_id = ch.org_id and m.code = ch.rate_key
    where ch.customer_id = p_customer_id and ch.kind = 'processing' and ch.state = 'open'
      and ch.settled_payment_id is null and ch.source_type = 'intake'
  )
  update public.charge ch
  set unit_price = p.price
  from priced p
  where ch.id = p.id and ch.unit_price is distinct from p.price;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Consumes the WP-06 event in the flip's own transaction, so the reprice can never be missed.
create or replace function app.on_customer_lodge_flag_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.reprice_customer_open_charges(new.subject_id);
  update public.domain_event set processed_at = now() where id = new.id;
  return null;
end;
$$;

drop trigger if exists domain_event_lodge_reprice on public.domain_event;
create trigger domain_event_lodge_reprice after insert on public.domain_event
  for each row when (new.kind = 'customer_lodge_flag_changed')
  execute function app.on_customer_lodge_flag_changed();

-- Grants ----------------------------------------------------------------------------------

revoke all on function
  app.intake_line_guard_locked(), app.intake_rate_card(uuid, date), app.rate_card_rates(uuid),
  app.org_today(uuid),
  app.station_printer(uuid, public.printer_kind, public.print_job_kind),
  app.queue_intake_tote_jobs(uuid), app.queue_intake_receipt_job(uuid),
  app.reprice_customer_open_charges(uuid), app.on_customer_lodge_flag_changed()
from public;

revoke all on function
  public.intake_price_context(uuid, uuid),
  public.save_intake(text, jsonb),
  public.unlock_intake(text, uuid, text, text),
  public.reprint_intake_tote_tags(text, uuid),
  public.print_intake_receipt(text, uuid)
from public, anon, authenticated;

grant execute on function
  public.intake_price_context(uuid, uuid),
  public.save_intake(text, jsonb),
  public.unlock_intake(text, uuid, text, text),
  public.reprint_intake_tote_tags(text, uuid),
  public.print_intake_receipt(text, uuid)
to authenticated;
