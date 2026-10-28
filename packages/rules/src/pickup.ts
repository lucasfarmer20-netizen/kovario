/** Single source of the database pickup-estimate rule. Clients read the derived value. */
export function renderPickupEstimateSql(): string {
  return `create function app.intake_estimated_pickup(p_intake public.intake, p_settings jsonb)
returns timestamptz language sql stable set search_path = '' as $$
  select coalesce(p_intake.estimated_pickup_at, p_intake.intake_at +
    make_interval(days => coalesce((p_settings ->> 'estimated_pickup_days')::integer, 3)));
$$;
revoke all on function app.intake_estimated_pickup(public.intake,jsonb) from public;`;
}
