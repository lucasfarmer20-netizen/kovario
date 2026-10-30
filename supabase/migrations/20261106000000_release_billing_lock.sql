-- The release paths take the org's allocation billing lock (#112, I16; docs/04-BUSINESS-RULES.md
-- §8, §9). A save that pools an intake key-shares it (allocation_intake's FK) and only then
-- reprices the other priced sessions sharing it (app.reprice_sessions_sharing, FOR UPDATE), while
-- a release holds its session and locks the intakes last (app.try_close_after_release, FOR
-- UPDATE). Interleaved, the save waited for the session and the release for the intake: 40P01.
-- release_party, release_by_tag and restore_vessel now take app.lock_allocation_billing right
-- before their session lock, as every allocation write and the paid hook already do, so every
-- path that locks a session row holds the billing lock first and two of them never interleave.
--
-- Lock order (AGENTS rule 3), every path that locks a session row:
--   action_log (key-shares the org row) → [the paid hook: the cart row] → the org's allocation
--   billing lock → sessions (sorted ids) → then, per path:
--     a release: its box plans → vessels (sorted ids) → tag → intakes (sorted ids);
--     a save: each pooled intake's reconcile lock (sorted ids) → the intakes' key-share
--       (allocation_intake FK) → its own settlements / box plans → the other priced sessions
--       sharing an intake (reprice, sorted ids);
--     the paid hook: settlements (sorted ids) → charges.
-- The reprice is the one session lock taken after an intake (a key-share); it closes no cycle,
-- because every other holder of a session row also holds the billing lock. Move bin, pull back
-- and reconcile (variance lock → reconcile locks → vessels → intakes) lock no session and take no
-- billing lock. A save reads its pooled intakes' states under the billing lock, which every
-- release path now holds when it closes an intake, so #113 serialises on this same lock order.
-- Cost: releases in an org serialise with each other and with allocation writes; they are a few
-- tablets and short transactions, as the counter's allocation writes already are.

-- Re-create the functions from their current definitions with exact replacements (as
-- 20261105000000_allocation_pool_lock.sql). Raises if the old text is missing, unless the new
-- text is already there (re-run).
create or replace function pg_temp.reword(p_fn regprocedure, variadic p_pairs text[])
returns void
language plpgsql
as $$
declare
  v_def text := pg_get_functiondef(p_fn);
  v_n int;
begin
  for v_n in 1 .. cardinality(p_pairs) / 2 loop
    if strpos(v_def, p_pairs[2 * v_n - 1]) > 0 then
      v_def := replace(v_def, p_pairs[2 * v_n - 1], p_pairs[2 * v_n]);
    elsif strpos(v_def, p_pairs[2 * v_n]) = 0 then
      raise exception 'reword(%): text not found: %', p_fn, p_pairs[2 * v_n - 1];
    end if;
  end loop;
  execute v_def;
end;
$$;

-- Billing lock ------------------------------------------------------------------------------

-- The org's allocation billing lock: the root of the session lock envelope. Every path that
-- locks an allocation_session row takes it first: allocation writes (save, price, cancel), the
-- paid hook, and the release paths (release_party, release_by_tag, restore_vessel; #112). A save
-- locks its session and, after key-sharing its pooled intakes, reprices the other sessions
-- sharing an intake; a release locks its session(s), then vessels, then the intakes. Taken
-- first, this lock serialises any two of them, so none holds a session while it waits for
-- another session, or an intake, that a second one holds. Counter and release traffic is a few
-- tablets and these transactions are short.
create or replace function app.lock_allocation_billing(p_org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('allocation_billing:' || p_org_id::text, 0))
$$;

-- Reprices the other priced, unpaid sessions pooling any of `p_intake_ids` — the billing
-- session of a shared intake can change when this session adds, drops or cancels it.
-- Callers hold app.lock_allocation_billing, as does every path that locks a session row (the
-- release paths since #112), so no other transaction holds these rows: locking them after the
-- caller's own session and its intakes' key-shares closes no cycle.
create or replace function app.reprice_sessions_sharing(p_session_id uuid, p_intake_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  for v_id in
    select s.id from public.allocation_session s
    where s.id <> p_session_id and s.state = 'priced'
      and exists (select 1 from public.allocation_intake ai
                  where ai.session_id = s.id and ai.intake_id = any (p_intake_ids))
      and not exists (select 1 from public.settlement st where st.session_id = s.id and st.state = 'paid')
    order by s.id
    for update of s
  loop
    perform app.price_session_apply(v_id);
  end loop;
end;
$$;

-- Release paths -----------------------------------------------------------------------------

select pg_temp.reword('public.release_party(text,uuid,uuid[],jsonb,text,uuid,text,text)',
  $o$  -- Lock level 1: the session. Serialises concurrent Completes on this party (I16).$o$,
  $n$  -- Lock level 0: the org's billing lock, as allocation writes take it before any session, so
  -- a save repricing this session never interleaves with this release (#112).
  perform app.lock_allocation_billing(v_org);
  -- Lock level 1: the session. Serialises concurrent Completes on this party (I16).$n$);

select pg_temp.reword('public.release_by_tag(text,text,numeric,text,text)',
  $o$  -- Level 1: every non-cancelled session pooling the basket's intake.$o$,
  $n$  -- Level 0: the org's billing lock, before any session (#112).
  perform app.lock_allocation_billing(app.org_id());
  -- Level 1: every non-cancelled session pooling the basket's intake.$n$);

select pg_temp.reword('public.restore_vessel(text,uuid,text,text)',
  $o$  -- Level 1: the sessions this intake's movement is attributed to.$o$,
  $n$  -- Level 0: the org's billing lock, before any session (#112).
  perform app.lock_allocation_billing(app.org_id());
  -- Level 1: the sessions this intake's movement is attributed to.$n$);

-- Move bin: the comment predates #111, which made a pooling save take the reconcile lock.
select pg_temp.reword('public.variance_move_vessel(text,uuid,uuid,uuid,text)',
  $o$    -- Allocation does not lock the intake when it pools it, so a session created at the same
    -- moment can still commit alongside this move (#102).$o$,
  $n$    -- A save that pools either intake takes its reconcile lock, which this move holds, and
    -- reads the states under it: it commits first and this move sees its pooling, or it waits
    -- and pools the intakes as moved (#102).$n$);
