-- GENERATED from packages/rules/src/variance-sql.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.
-- Variance hold at reconcile (#87, docs/04-BUSINESS-RULES.md §6a, variance.ts):
--   app.variance_pct                   — variancePercent (reconcile.ts);
--   app.variance_band                  — varianceBand: within | near | over | unknown;
--   app.format_variance                — formatVariance (refusal messages);
--   app.variance_hold_group            — holdGroup over the rollstock sequence;
--   app.variance_rollstock_window      — ROLLSTOCK_NEIGHBOUR_WINDOW_DAYS;
--   app.variance_hold_limit            — varianceHoldLimit (org settings, with default);
--   app.variance_hold_setting_problem  — varianceHoldSettingProblem;
--   app.variance_signoff_problem       — varianceSignoffProblem;
--   app.variance_hold_blocks           — holdBlocks (HOLD_BLOCKED_STATES);
--   app.variance_actual_frozen         — actualFrozen (SENT_STATES);
--   app.variance_member_keeps_open     — memberKeepsHoldOpen;
--   public.variance_signoff_reason     — VARIANCE_SIGNOFF_REASONS.

do $$ begin
  create type public.variance_signoff_reason as enum ('estimate_wrong', 'mixed_species', 'spoilage', 'trim_heavy', 'other');
exception when duplicate_object then null; end $$;

-- (actual − expected) / expected × 100, 2 decimals; null when nothing was expected.
create or replace function app.variance_pct(p_actual numeric, p_expected numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_expected > 0 then round((p_actual - p_expected) / p_expected * 100, 2) end
$$;

-- "+14%", "−3.5%", "0%", "—": one decimal at most, halves away from zero, via hundredths.
create or replace function app.format_variance(p_pct numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_pct is null then '—'
    when t.tenths = 0 then '0%'
    else case when p_pct > 0 then '+' else '−' end || trim_scale(t.tenths / 10)::text || '%'
  end
  from (select round(round(abs(p_pct) * 100) / 10) as tenths) t
$$;

-- Compared exactly at 2 decimals: |actual − expected| × 100 against limit × expected.
-- Over the limit → over; at or past 2/3 of it → near; no expectation → unknown.
create or replace function app.variance_band(p_actual numeric, p_expected numeric, p_limit_pct int)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_expected numeric;
  v_off numeric;
begin
  if p_limit_pct is null or p_limit_pct < 1 or p_limit_pct > 100 then
    raise exception 'variance hold limit must be a whole percent 1–100' using errcode = '22023';
  end if;
  if p_actual is null or p_expected is null or p_actual < 0 or p_expected < 0
     or p_actual::text in ('NaN', 'Infinity') or p_expected::text in ('NaN', 'Infinity') then
    raise exception 'weights must be finite and >= 0' using errcode = '22023';
  end if;
  v_expected := round(p_expected, 2);
  if v_expected <= 0 then return 'unknown'; end if;
  v_off := abs(round(p_actual, 2) - v_expected) * 100;
  if v_off > p_limit_pct * v_expected then return 'over'; end if;
  if v_off * 3 >= 2 * p_limit_pct * v_expected then return 'near'; end if;
  return 'within';
end;
$$;

-- 1 before, the flagged intake, 2 after, clipped at either end; an
-- intake missing from the sequence is a group of one.
create or replace function app.variance_hold_group(p_sequence uuid[], p_flagged uuid)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select case when p.at is null then array[p_flagged]
    else p_sequence[greatest(1, p.at - 1):p.at + 2] end
  from (select array_position(p_sequence, p_flagged) as at) p
$$;

-- Neighbours are looked for among intakes opened within this of the flagged one.
create or replace function app.variance_rollstock_window()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '7 days'
$$;

create or replace function app.variance_hold_limit(p_settings jsonb)
returns int
language sql
immutable
set search_path = ''
as $$
  select coalesce((p_settings #>> '{reconcile,variance_hold_pct}')::int, 15)
$$;

-- settings.reconcile is optional; when present it is exactly {variance_hold_pct}.
create or replace function app.variance_hold_setting_problem(p_settings jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when not (p_settings ? 'reconcile') then null
    when jsonb_typeof(p_settings -> 'reconcile') <> 'object'
      or app.json_keys(p_settings -> 'reconcile') <> array['variance_hold_pct']
      or not app.json_int_between(p_settings #> '{reconcile,variance_hold_pct}', 1, 100)
      then 'reconcile.variance_hold_pct must be a whole percent between 1 and 100'
  end
$$;

create or replace function app.variance_signoff_problem(p_reason text, p_note text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_reason is null or p_reason <> all (array['estimate_wrong', 'mixed_species', 'spoilage', 'trim_heavy', 'other']) then 'Choose a sign-off reason'
    when length(coalesce(p_note, '')) > 500 then 'Note must be at most 500 characters'
    when p_reason = 'other' and coalesce(p_note, '') !~ '\S' then 'Other needs a note'
  end
$$;

-- Not yet sent to blast: the states a hold blocks.
create or replace function app.variance_hold_blocks(p_state public.intake_state)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_state in ('draft', 'holding', 'processing', 'rollstock', 'reconcile')
$$;

-- Sent to blast: the actual is the weight at Send to Blast.
create or replace function app.variance_actual_frozen(p_state public.intake_state)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_state in ('blast_freezer', 'stored', 'done')
$$;

-- A member keeps its hold open: not yet at reconcile, or at reconcile over the limit and not
-- signed off at its current weight. Past reconcile and cancelled members are not judged.
create or replace function app.variance_member_keeps_open(
  p_state public.intake_state, p_band text, p_signed_off boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_state in ('draft', 'holding', 'processing', 'rollstock')
    or (p_state = 'reconcile' and p_band = 'over' and not coalesce(p_signed_off, false))
$$;

revoke all on function app.variance_pct(numeric, numeric),
  app.variance_band(numeric, numeric, int), app.variance_hold_group(uuid[], uuid),
  app.variance_hold_limit(jsonb), app.variance_hold_setting_problem(jsonb),
  app.variance_signoff_problem(text, text), app.variance_rollstock_window(),
  app.format_variance(numeric), app.variance_hold_blocks(public.intake_state),
  app.variance_actual_frozen(public.intake_state),
  app.variance_member_keeps_open(public.intake_state, text, boolean) from public;
grant execute on function app.variance_pct(numeric, numeric),
  app.variance_band(numeric, numeric, int), app.variance_hold_group(uuid[], uuid),
  app.variance_hold_limit(jsonb), app.variance_rollstock_window(), app.format_variance(numeric),
  app.variance_hold_blocks(public.intake_state), app.variance_actual_frozen(public.intake_state),
  app.variance_member_keeps_open(public.intake_state, text, boolean) to authenticated, service_role;
grant execute on function app.variance_hold_setting_problem(jsonb),
  app.variance_signoff_problem(text, text) to service_role;
