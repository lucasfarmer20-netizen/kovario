-- WP-21: live reports. All dates are calendar dates in the org timezone.
-- Invoker views retain RLS on every underlying relation; no privileged read RPC.
create or replace view public.report_daily_volume with (security_invoker = true) as
select i.org_id, i.site_id, (i.intake_at at time zone o.timezone)::date as day,
  l.species_code, sum(l.lb) as incoming_lb
from public.intake i
join public.org o on o.id = i.org_id
join public.intake_line l on l.intake_id = i.id and l.org_id = i.org_id
where i.state not in ('draft', 'cancelled')
group by i.org_id, i.site_id, day, l.species_code;

-- Current state of the intake cohort selected by intake date, not a historical snapshot.
create or replace view public.report_pipeline with (security_invoker = true) as
select i.org_id, i.site_id, (i.intake_at at time zone o.timezone)::date as day,
  i.state, count(*) as intake_count, sum(i.total_incoming_lb) as incoming_lb
from public.intake i join public.org o on o.id = i.org_id
where i.state not in ('draft', 'cancelled')
group by i.org_id, i.site_id, day, i.state;

create or replace view public.report_throughput with (security_invoker = true) as
select i.org_id, i.site_id, (s.finished_at at time zone o.timezone)::date as day,
  s.stage, count(*) as intake_count,
  avg(extract(epoch from (s.finished_at - s.started_at)) / 3600) as hours
from public.intake i join public.org o on o.id = i.org_id
cross join lateral (values
  ('Intake → processing', i.intake_at, i.pulled_at),
  ('Processing → rollstock', i.pulled_at, i.rollstock_at),
  ('Rollstock → reconcile', i.rollstock_at, i.rollstock_done_at),
  ('Reconcile → blast', i.reconcile_at, i.blast_at),
  ('Blast → stored', i.blast_at, i.stored_at),
  ('Stored → done', i.stored_at, i.done_at)
) s(stage, started_at, finished_at)
where i.state not in ('draft', 'cancelled')
  and s.started_at is not null and s.finished_at >= s.started_at
group by i.org_id, i.site_id, day, s.stage;

-- One row per charge before aggregation. Never join a pooled settlement directly
-- to its intakes (that would multiply money). Ambiguous/missing sites stay null.
-- Revenue is currently settled charges, excluding tax/tips and comped/voided rows;
-- this is not a cash ledger or a net-refund report.
create or replace view public.report_revenue with (security_invoker = true) as
with attributed as (
  select c.org_id, c.kind, c.amount, p.approved_at,
    case c.source_type
      when 'intake' then i.site_id
      when 'storage_batch' then si.site_id
      when 'settlement' then (
        select case when count(*) = count(n.site_id) and count(distinct n.site_id) = 1
          then (array_agg(n.site_id))[1] end
        from public.settlement st
        join public.allocation_intake ai on ai.session_id = st.session_id and ai.org_id = st.org_id
        join public.intake n on n.id = ai.intake_id and n.org_id = ai.org_id
        where st.id = c.source_id and st.org_id = c.org_id
      )
      else pt.site_id
    end as site_id
  from public.charge c
  join public.payment p on p.id = c.settled_payment_id and p.org_id = c.org_id
  left join public.intake i on c.source_type = 'intake' and i.id = c.source_id and i.org_id = c.org_id
  left join public.storage_pickup_batch b on c.source_type = 'storage_batch' and b.id = c.source_id and b.org_id = c.org_id
  left join public.storage_intake si on si.id = b.storage_intake_id and si.org_id = b.org_id
  left join public.payment_terminal pt on pt.id = p.terminal_id and pt.org_id = p.org_id
  where c.state = 'settled' and p.approved_at is not null
)
select a.org_id, a.site_id, (a.approved_at at time zone o.timezone)::date as day,
  a.kind, count(*) as charge_count, sum(a.amount) as amount
from attributed a join public.org o on o.id = a.org_id
group by a.org_id, a.site_id, day, a.kind;

-- Use attributed reconcile measurements, never the vessel's mutable remainder.
create or replace view public.report_reconcile_variance with (security_invoker = true) as
select i.org_id, i.site_id, (i.reconcile_at at time zone o.timezone)::date as day,
  l.species_code, count(*) as line_count, sum(r.expected_lb) as expected_lb,
  sum(r.actual_lb) as actual_lb,
  round((sum(r.actual_lb) - sum(r.expected_lb)) / nullif(sum(r.expected_lb), 0) * 100, 2) as variance_pct
from public.reconcile_line r
join public.intake i on i.id = r.intake_id and i.org_id = r.org_id
join public.intake_line l on l.id = r.intake_line_id and l.intake_id = i.id and l.org_id = i.org_id
join public.org o on o.id = i.org_id
where i.state not in ('draft', 'cancelled') and i.reconcile_at is not null
group by i.org_id, i.site_id, day, l.species_code;

revoke all on public.report_daily_volume, public.report_pipeline, public.report_throughput,
  public.report_revenue, public.report_reconcile_variance from public, anon, authenticated;
grant select on public.report_daily_volume, public.report_pipeline, public.report_throughput,
  public.report_revenue, public.report_reconcile_variance to authenticated, service_role;
