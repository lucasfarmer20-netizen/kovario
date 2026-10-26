-- Per-org document numbering (docs/01-ARCHITECTURE.md §3): a row-locked counter table,
-- not Postgres sequences, so numbering is tenant-local and gap-free enough for paper.

-- Prefix per kind. Platform reference data shared by every tenant, so it carries no
-- org_id and lives in schema `app` (not exposed through the Data API). RLS is enabled
-- with no policies: only security definer functions read it.
create table if not exists app.sequence_prefix (
  kind text primary key,
  prefix text not null unique check (prefix ~ '^[A-Z]+$'),
  pad int not null default 4 check (pad between 1 and 10)
);

alter table app.sequence_prefix enable row level security;
revoke all on app.sequence_prefix from public, anon, authenticated;

insert into app.sequence_prefix (kind, prefix) values
  ('intake', 'INT'),
  ('storage_intake', 'STG'),
  ('storage_pickup_batch', 'SPB'),
  ('wave', 'WAVE'),
  ('charge', 'CHG'),
  ('allocation_session', 'ALC'),
  ('settlement', 'STL'),
  ('box_plan', 'BOX'),
  ('shipment', 'SHP'),
  ('payment', 'PAY'),
  ('audit_batch', 'FA')
on conflict (kind) do update set prefix = excluded.prefix;

create table if not exists public.sequence_counter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete cascade,
  kind text not null references app.sequence_prefix (kind),
  value int not null default 0 check (value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind)
);

select app.track_updated_at('public.sequence_counter');
select app.enable_org_rls('public.sequence_counter', write_roles => '{}');

-- app.next_seq(org_id, 'intake') → 'INT-0001'. The upsert takes the counter row lock, so
-- concurrent callers serialise on (org_id, kind) and never see the same value. Called
-- from inside the SQL function that creates the numbered row, so a rolled-back create
-- also rolls back its number.
create or replace function app.next_seq(p_org_id uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_pad int;
  v_value int;
begin
  if app.is_end_user() and p_org_id is distinct from app.org_id() then
    raise exception 'next_seq: org mismatch' using errcode = '42501';
  end if;

  select prefix, pad into v_prefix, v_pad from app.sequence_prefix where kind = p_kind;
  if not found then
    raise exception 'next_seq: unknown kind %', p_kind using errcode = '22023';
  end if;

  insert into public.sequence_counter as c (org_id, kind, value)
  values (p_org_id, p_kind, 1)
  on conflict (org_id, kind) do update set value = c.value + 1
  returning c.value into v_value;

  return v_prefix || '-' || case
    when length(v_value::text) >= v_pad then v_value::text
    else lpad(v_value::text, v_pad, '0')
  end;
end;
$$;

revoke all on function app.next_seq(uuid, text) from public;
grant execute on function app.next_seq(uuid, text) to authenticated, service_role;
