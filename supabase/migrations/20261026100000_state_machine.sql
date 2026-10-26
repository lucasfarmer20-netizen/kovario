-- State-machine guard (docs/03-STATE-MACHINES.md). The allowed edges live in
-- app.state_transitions, filled by supabase/seed/state_transitions.sql — GENERATED from
-- packages/rules/src/states.ts by `pnpm --filter rules gen:states` (WP-04); never edit it
-- here. Every stateful table gets app.state_transition_guard() via app.guard_state(), which
-- rejects any state change that is not an edge and stamps the transition's timestamp
-- column. Managers bypass the table only through public.force_transition(), which writes
-- action_log with the reason.

-- Platform reference data shared by every tenant: no org_id, so it lives in schema `app`
-- (like app.sequence_prefix) with RLS on and no policies — only definer functions read it.
create table if not exists app.state_transitions (
  entity text not null,
  from_state text not null,
  to_state text not null,
  primary key (entity, from_state, to_state),
  check (from_state <> to_state)
);

alter table app.state_transitions enable row level security;
revoke all on app.state_transitions from public, anon, authenticated;

-- The generated seed addresses the table unqualified (`delete from state_transitions`), so
-- expose it on the default search_path as an auto-updatable view. Clients get nothing.
create or replace view public.state_transitions with (security_invoker = true) as
  select entity, from_state, to_state from app.state_transitions;

revoke all on public.state_transitions from public, anon, authenticated;
grant select on public.state_transitions to service_role;

-- Registry of guarded tables, used by force_transition() to find the table and column.
create table if not exists app.state_entity (
  entity text primary key,
  tbl regclass not null unique,
  state_column text not null
);

alter table app.state_entity enable row level security;
revoke all on app.state_entity from public, anon, authenticated;

-- Trigger arguments: entity, state column, then any number of 'to_state:timestamp_col'
-- stamps. A stamp is written (now()) when the row enters to_state, unless the same UPDATE
-- set that column explicitly. INSERTs are not guarded: rows may be created in any state
-- (e.g. a register_order created as paid for cash — docs/02-DOMAIN-MODEL.md §9).
create or replace function app.state_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_col text := tg_argv[1];
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_from text := v_old ->> v_col;
  v_to text := v_new ->> v_col;
  v_stamp text[];
begin
  if v_from is not distinct from v_to then
    return new;
  end if;

  if not exists (
    select 1 from app.state_transitions
    where entity = v_entity and from_state = v_from and to_state = v_to
  ) and coalesce(current_setting('app.forced_transition', true), '')
        <> format('%s:%s:%s', v_entity, v_new ->> 'id', v_to) then
    raise exception 'illegal % transition: % -> %', v_entity, v_from, v_to
      using errcode = '23514',
            hint = 'allowed edges come from packages/rules/src/states.ts; managers use force_transition()';
  end if;

  for i in 3 .. coalesce(array_length(tg_argv, 1), 0) loop
    v_stamp := string_to_array(tg_argv[i - 1], ':');
    if v_stamp[1] = v_to and (v_new -> v_stamp[2]) is not distinct from (v_old -> v_stamp[2]) then
      new := jsonb_populate_record(new, jsonb_build_object(v_stamp[2], now()));
    end if;
  end loop;

  return new;
end;
$$;

-- app.guard_state('public.intake', 'intake', 'state', '{processing:pulled_at,...}')
-- attaches the guard and registers the entity. Idempotent.
create or replace function app.guard_state(
  tbl regclass, p_entity text, p_state_column text default 'state', p_stamps text[] default '{}'
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_args text := format('%L, %L', p_entity, p_state_column);
  v_stamp text;
begin
  foreach v_stamp in array p_stamps loop
    v_args := v_args || format(', %L', v_stamp);
  end loop;

  insert into app.state_entity (entity, tbl, state_column)
  values (p_entity, tbl, p_state_column)
  on conflict (entity) do update set tbl = excluded.tbl, state_column = excluded.state_column;

  execute format('drop trigger if exists state_transition_guard on %s', tbl);
  execute format(
    'create trigger state_transition_guard before update of %I on %s '
    'for each row execute function app.state_transition_guard(%s)',
    p_state_column, tbl, v_args
  );
end;
$$;

revoke all on function app.state_transition_guard(), app.guard_state(regclass, text, text, text[]) from public;

-- Manager override: moves `p_id` of `p_entity` to `p_to_state` even when the edge is not in
-- the table, as one idempotent action whose action_log input carries the reason.
-- Callers are owners/managers, or a station presenting a live manager elevation token
-- (app.require_elevation, WP-02). The forced flag is scoped to this one row and state and
-- cleared before returning, so it cannot leak to other writes in the transaction.
create or replace function public.force_transition(
  p_client_action_id text,
  p_entity text,
  p_id uuid,
  p_to_state text,
  p_reason text,
  p_elevation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.org_id();
  v_manager uuid;
  v_action jsonb;
  v_reg app.state_entity;
  v_type regtype;
  v_from text;
  v_result jsonb;
begin
  if p_elevation_token is not null then
    v_manager := app.require_elevation(p_elevation_token);
  else
    perform app.require_role('{owner,manager}');
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'force_transition: a reason is required' using errcode = '22023';
  end if;

  v_action := app.action_begin(p_client_action_id, 'state.force', jsonb_build_object(
    'entity', p_entity, 'id', p_id, 'to_state', p_to_state, 'reason', trim(p_reason),
    'approved_by', v_manager));
  if v_action ->> 'status' = 'done' then return v_action -> 'result'; end if;

  select * into v_reg from app.state_entity where entity = p_entity;
  if not found then
    raise exception 'force_transition: unknown entity %', p_entity using errcode = '22023';
  end if;
  select a.atttypid::regtype into v_type
  from pg_catalog.pg_attribute a
  where a.attrelid = v_reg.tbl and a.attname = v_reg.state_column;

  execute format('select %I::text from %s where id = $1 and org_id = $2 for update',
                 v_reg.state_column, v_reg.tbl)
    into v_from using p_id, v_org;
  if v_from is null then
    raise exception 'force_transition: % % not found', p_entity, p_id using errcode = 'P0002';
  end if;

  perform set_config('app.forced_transition', format('%s:%s:%s', p_entity, p_id, p_to_state), true);
  execute format('update %s set %I = $1::text::%s where id = $2', v_reg.tbl, v_reg.state_column, v_type)
    using p_to_state, p_id;
  perform set_config('app.forced_transition', '', true);

  v_result := jsonb_build_object(
    'entity', p_entity, 'id', p_id, 'from_state', v_from, 'to_state', p_to_state);
  perform app.action_complete(p_client_action_id, v_result);
  return v_result;
end;
$$;

revoke all on function public.force_transition(text, text, uuid, text, text, text) from public, anon;
grant execute on function public.force_transition(text, text, uuid, text, text, text) to authenticated;
