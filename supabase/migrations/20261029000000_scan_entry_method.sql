-- Issue #84: manual code entry. scan_log.entry_method records whether a code was scanned or
-- typed into a station's "Type code" field, and report_manual_entries counts manual codes
-- by station/day beside manual reconcile weights (vessel.manual).
--
-- A typed code calls the SAME scan RPC as a hardware scan (same validation, action_log and
-- client_action_id); the station only adds the PostgREST request header
-- `x-filletry-entry-method: manual` (apps/web/src/components/station/entry-method.ts). The
-- trigger below reads it, so no scan RPC changes and every scan_log writer is covered.

do $$ begin
  create type public.scan_entry_method as enum ('scan', 'manual');
exception when duplicate_object then null; end $$;

alter table public.scan_log
  add column if not exists entry_method public.scan_entry_method not null default 'scan';

create or replace function app.scan_log_entry_method()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_method text;
begin
  begin
    v_method := nullif(current_setting('request.headers', true), '')::jsonb
      ->> 'x-filletry-entry-method';
  exception when others then
    v_method := null; -- an unreadable header never blocks the scan
  end;
  if v_method = 'manual' then
    new.entry_method := 'manual';
  end if;
  return new;
end;
$$;
revoke all on function app.scan_log_entry_method() from public;

drop trigger if exists scan_log_entry_method on public.scan_log;
create trigger scan_log_entry_method before insert on public.scan_log
  for each row execute function app.scan_log_entry_method();

-- Manual entries by station and local day: typed codes over all scans (site from the scanning
-- device; staff browsers are unassigned), and manual reconcile weights over all vessels
-- weighed at reconcile, by reconcile date (as report_reconcile_variance).
create or replace view public.report_manual_entries with (security_invoker = true) as
select s.org_id, d.site_id, (s.scanned_at at time zone o.timezone)::date as day,
  s.station::text as station, 'code'::text as entry,
  count(*) as entry_count, count(*) filter (where s.entry_method = 'manual') as manual_count
from public.scan_log s
join public.org o on o.id = s.org_id
left join public.device d on d.id = s.device_id and d.org_id = s.org_id
group by s.org_id, d.site_id, day, s.station
union all
select i.org_id, i.site_id, (i.reconcile_at at time zone o.timezone)::date as day,
  'reconcile'::text as station, 'weight'::text as entry,
  count(*) as entry_count, count(*) filter (where v.manual) as manual_count
from public.vessel v
join public.intake i on i.id = v.intake_id and i.org_id = v.org_id
join public.org o on o.id = i.org_id
where i.state not in ('draft', 'cancelled') and i.reconcile_at is not null
  -- weighed at reconcile (never the vessel's mutable remainder): typed, or a scale reading
  and (v.manual or v.scale_reading_id is not null)
group by i.org_id, i.site_id, (i.reconcile_at at time zone o.timezone)::date;

revoke all on public.report_manual_entries from public, anon, authenticated;
grant select on public.report_manual_entries to authenticated, service_role;
