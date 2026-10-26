-- Printing & devices (docs/02-DOMAIN-MODEL.md §10): print_agent, printer, print_job,
-- scale; plus device.printer_label_id / printer_receipt_id / scale_id (deferred by WP-02).
-- Print routing is per site/device — there is no global default printer.

do $$ begin
  create type public.printer_kind as enum ('label_zpl', 'receipt_pdf');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.print_job_kind as enum (
    'tote_tag', 'receipt', 'storage_label', 'box_label', 'pick_list', 'location_tag', 'shipping_label'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.print_job_payload_type as enum ('zpl', 'pdf_url');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.print_job_state as enum ('queued', 'printing', 'done', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.scale_protocol as enum ('toledo_8217', 'manual');
exception when duplicate_object then null; end $$;

-- print_agent --------------------------------------------------------------------------
create table if not exists public.print_agent (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  site_id uuid references public.site (id) on delete set null,
  -- sha256 of the agent's scoped token; never readable by clients.
  token_hash text unique,
  last_seen_at timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select app.track_updated_at('public.print_agent');
select app.enable_org_rls('public.print_agent', write_roles => '{}');
revoke select on public.print_agent from authenticated;
grant select (id, org_id, name, site_id, last_seen_at, capabilities, created_at, updated_at)
  on public.print_agent to authenticated;

-- printer ------------------------------------------------------------------------------
create table if not exists public.printer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  site_id uuid references public.site (id) on delete set null,
  kind public.printer_kind not null,
  agent_id uuid references public.print_agent (id) on delete set null,
  -- host:port for raw TCP 9100, or a CUPS queue name
  address text,
  is_default_for jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists printer_agent_id on public.printer (agent_id);

select app.track_updated_at('public.printer');
select app.enable_org_rls('public.printer', write_roles => '{}');

-- print_job ----------------------------------------------------------------------------
create table if not exists public.print_job (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  printer_id uuid not null references public.printer (id),
  kind public.print_job_kind not null,
  payload_type public.print_job_payload_type not null,
  payload text not null,
  copies int not null default 1 check (copies between 1 and 100),
  state public.print_job_state not null default 'queued',
  error text,
  source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The agent's work queue.
create index if not exists print_job_queued on public.print_job (printer_id, created_at)
  where state = 'queued';

select app.track_updated_at('public.print_job');
select app.enable_org_rls('public.print_job', write_roles => '{}');
select app.guard_state('public.print_job', 'print_job');

-- scale --------------------------------------------------------------------------------
create table if not exists public.scale (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  site_id uuid references public.site (id) on delete set null,
  agent_id uuid references public.print_agent (id) on delete set null,
  protocol public.scale_protocol not null default 'manual',
  port text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select app.track_updated_at('public.scale');
select app.enable_org_rls('public.scale', write_roles => '{}');

-- device routing (docs/02-DOMAIN-MODEL.md §1) -----------------------------------------
alter table public.device
  add column if not exists printer_label_id uuid references public.printer (id) on delete set null,
  add column if not exists printer_receipt_id uuid references public.printer (id) on delete set null,
  add column if not exists scale_id uuid references public.scale (id) on delete set null;

-- device uses column-level grants (token_hash/pairing_key stay hidden).
grant select (printer_label_id, printer_receipt_id, scale_id) on public.device to authenticated;
