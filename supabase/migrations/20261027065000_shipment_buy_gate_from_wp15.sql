-- CARRIED FROM WP-15 (PR #67) UNTIL IT MERGES — byte-for-byte the I13 / I13b / I14 buy gate
-- WP-15 defines (`app.shipment_buy_gate`, generated from packages/rules/src/release.ts, and its
-- feeder `app.shipment_gate`). WP-19's buy path consumes that interface; this file only exists so
-- WP-19 runs on a main without #67. Both are `create or replace` with identical bodies, so
-- whichever migration applies last is a no-op. Delete this file when rebasing onto #67.

-- {held, blockers, can_buy, can_reprint}. Held = ship date past today + window (info, not
-- an error); blockers are reported alongside it (I13b). Manager force overrides the date
-- hold only — every blocker, a missing ship date included, survives it (I14). A bought
-- label can always be reprinted.
create or replace function app.shipment_buy_gate(
  p_ship_date date, p_today date, p_buy_window_days int, p_force_buy_held boolean,
  p_service text, p_blockers text[], p_label_bought boolean
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_blockers text[];
  v_held boolean;
begin
  if p_today is null or p_buy_window_days is null or p_buy_window_days < 0 then
    raise exception 'buy gate needs today and a buy window of 0 days or more' using errcode = '22023';
  end if;
  select coalesce(array_agg(b order by n), '{}') into v_blockers
  from (select b, min(n) as n from unnest(coalesce(p_blockers, '{}')) with ordinality as x (b, n)
        group by b) d;
  if p_ship_date is null and not 'missing_ship_date' = any (v_blockers) then
    v_blockers := v_blockers || 'missing_ship_date'::text;
  end if;
  if coalesce(btrim(p_service), '') = '' and not 'no_service' = any (v_blockers) then
    v_blockers := v_blockers || 'no_service'::text;
  end if;
  if coalesce(p_label_bought, false) then
    return jsonb_build_object('held', false, 'blockers', '[]'::jsonb, 'can_buy', false, 'can_reprint', true);
  end if;
  v_held := p_ship_date is not null and not coalesce(p_force_buy_held, false)
            and p_ship_date > p_today + p_buy_window_days;
  return jsonb_build_object('held', v_held, 'blockers', to_jsonb(v_blockers),
    'can_buy', not v_held and cardinality(v_blockers) = 0, 'can_reprint', false);
end;
$$;

revoke all on function app.shipment_buy_gate(date, date, int, boolean, text, text[], boolean) from public;
grant execute on function app.shipment_buy_gate(date, date, int, boolean, text, text[], boolean) to service_role;

-- The rule is app.shipment_buy_gate (generated from rules/release.ts); this feeds it the
-- shipment, the org's today and buy window, and the stored blockers (strings or {code}).
create or replace function app.shipment_gate(p_shipment public.shipment, p_force_buy_held boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app.shipment_buy_gate(
    p_shipment.ship_date,
    app.org_today(p_shipment.org_id),
    coalesce((o.settings #>> '{shipping,buy_window_days}')::int, 1),
    p_force_buy_held,
    p_shipment.service,
    (select coalesce(array_agg(coalesce(x.b ->> 'code', x.b #>> '{}') order by x.n), '{}')
     from jsonb_array_elements(case when jsonb_typeof(p_shipment.blockers) = 'array'
                                    then p_shipment.blockers else '[]'::jsonb end)
          with ordinality as x (b, n)),
    p_shipment.state in ('label_bought', 'shipped'))
  from public.org o
  where o.id = p_shipment.org_id
$$;


revoke all on function app.shipment_gate(public.shipment, boolean) from public;
