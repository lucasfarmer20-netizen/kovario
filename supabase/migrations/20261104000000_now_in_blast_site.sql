-- v1.2 (#96): the "now in blast" lines are scoped to the station's site (docs/06-STATIONS-UX.md,
-- Reconcile, Blast). A paired station device (JWT `device_id`) bound to a site sees only that
-- site's intakes, so a multi-site org's blast and reconcile screens read as one rollstock line
-- (DECISION-25: rollstock order is per site). Everyone else (managers and owners in Admin,
-- signed-in staff, a device with no site) still sees every site. The view stays security_invoker
-- and keeps its columns; the scope is a filter, not an RLS rule.

-- The caller's station site: the paired device's site, null for a non-device caller or a device
-- with no site. Not security definer: device rows and device.site_id are readable by the org.
create or replace function app.station_site_id()
returns uuid language sql stable set search_path = '' as $$
  select d.site_id from public.device d where d.id = app.device_id() and d.org_id = app.org_id()
$$;
revoke all on function app.station_site_id() from public;
grant execute on function app.station_site_id() to authenticated, service_role;

-- As 20261030000100_variance_hold.sql, plus the station-site filter.
create or replace view public.now_in_blast with (security_invoker = true) as
select iv.org_id, iv.site_id, iv.intake_id, iv.number as intake_number, iv.state, i.blast_at,
  ro.opened_at as rollstock_opened_at, ro.scan_id as rollstock_scan_id,
  iv.expected_lb, iv.actual_lb, iv.variance_pct, iv.limit_pct, iv.band
from public.intake i
join public.intake_variance iv on iv.intake_id = i.id and iv.org_id = i.org_id
left join public.rollstock_open ro on ro.intake_id = i.id and ro.org_id = i.org_id
cross join lateral (select app.station_site_id() as site_id) st
where (i.state = 'blast_freezer'
  or (i.state = 'stored' and exists (select 1 from public.vessel v where v.intake_id = i.id
    and v.org_id = i.org_id and v.lifecycle_state = 'occupied' and v.stored_at is null)))
  and (st.site_id is null or i.site_id is not distinct from st.site_id);
