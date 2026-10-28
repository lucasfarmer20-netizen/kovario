-- GENERATED from packages/rules/src/register-sql.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.
--   app.tax_setting — org settings.tax normalised (taxSetting in tax.ts);
--   app.tax_amount  — THE register tax rule (docs/04-BUSINESS-RULES.md §12, computeTax);
--   app.tax_total   — what the customer pays: subtotal + tax when exclusive.

-- Missing / non-object → no tax; no mode → exclusive (the documented default).
create or replace function app.tax_setting(p_raw jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_raw) is distinct from 'object'
    then jsonb_build_object('mode', 'none', 'rate', 0, 'cap_amount', null)
    else jsonb_build_object(
      'mode', case when p_raw ->> 'mode' in ('exclusive', 'inclusive', 'none') then p_raw ->> 'mode' else 'exclusive' end,
      'rate', case when jsonb_typeof(p_raw -> 'rate') = 'number' then p_raw -> 'rate' else '0'::jsonb end,
      'cap_amount', case when jsonb_typeof(p_raw -> 'cap_amount') = 'number' then p_raw -> 'cap_amount' end)
  end
$$;

-- Whole cents, integer arithmetic, half-up: s·r / d with d = 10⁶ (exclusive) or 10⁶ + r
-- (inclusive), capped at cap_amount. A subtotal ≤ 0 carries no tax.
create or replace function app.tax_amount(p_tax jsonb, p_subtotal numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_tax jsonb := app.tax_setting(p_tax);
  v_s numeric := p_subtotal * 100;
  v_r numeric := (v_tax ->> 'rate')::numeric * 1000000;
  v_cap numeric := (v_tax ->> 'cap_amount')::numeric * 100;
  v_d numeric;
  v_cents numeric;
begin
  if p_subtotal is null or v_s <> trunc(v_s) then
    raise exception 'subtotal must be an amount in cents' using errcode = '22023';
  end if;
  if v_r < 0 or v_r > 1000000 or v_r <> trunc(v_r) then
    raise exception 'tax rate must be between 0 and 1, at most 6 dp' using errcode = '22023';
  end if;
  if v_cap is not null and (v_cap < 0 or v_cap <> trunc(v_cap)) then
    raise exception 'tax cap must be a non-negative amount in cents' using errcode = '22023';
  end if;
  if v_tax ->> 'mode' = 'none' or v_s <= 0 or v_r = 0 then
    return 0;
  end if;
  v_d := case v_tax ->> 'mode' when 'exclusive' then 1000000 else 1000000 + v_r end;
  v_cents := div(2 * v_s * v_r + v_d, 2 * v_d);
  if v_cap is not null and v_cents > v_cap then
    v_cents := v_cap;
  end if;
  return (v_cents / 100)::numeric(12,2);
end;
$$;

create or replace function app.tax_total(p_tax jsonb, p_subtotal numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select (p_subtotal + case when app.tax_setting(p_tax) ->> 'mode' = 'exclusive'
                            then app.tax_amount(p_tax, p_subtotal) else 0 end)::numeric(12,2)
$$;

revoke all on function app.tax_setting(jsonb), app.tax_amount(jsonb, numeric), app.tax_total(jsonb, numeric)
from public;
grant execute on function app.tax_setting(jsonb), app.tax_amount(jsonb, numeric), app.tax_total(jsonb, numeric)
to authenticated, service_role;
