-- Allocation pooling serialises with bin moves and pull backs (#102, I15/I17 residual from #88;
-- docs/04-BUSINESS-RULES.md §6b). variance_move_vessel and intake_pull_back refuse an intake that
-- an allocation session pools (app.pooling_sessions), and read that under the intake's
-- reconcile:<intake_id> advisory lock. save_allocation_session now takes the same lock for every
-- intake it pools (sorted ids), after its session row, and reads the intakes' states under it, so
-- whichever commits second sees the other: a move or pull back waiting on a pooling save is
-- refused; a pooling save waiting on a pull back pools the intake back at reconcile.
-- Which states may be pooled is unchanged (DECISION-32: an intake not yet in blast stays poolable;
-- draft, done and cancelled are refused).
--
-- Lock order (AGENTS rule 3): action_log (key-shares the org row) → the org's allocation billing
-- lock → the session row → each pooled intake's reconcile lock (sorted ids) → allocation_intake's
-- key-share on the intake rows → other priced sessions sharing an intake (reprice). No vessel is
-- locked. Reconcile, move bin and pull back take the reconcile lock(s) → vessels → intakes and
-- never lock a session or the billing lock; the release paths (release_party, release_by_tag:
-- sessions → vessels → intakes, I16) never take a reconcile lock. So no cycle forms.

-- Re-create save_allocation_session from its current definition with exact replacements (as
-- 20261103000100_hold_reevaluate.sql). Raises if the old text is missing, unless the new text is
-- already there (re-run).
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

select pg_temp.reword('public.save_allocation_session(text,jsonb)',
  $o$  v_old_intakes uuid[] := '{}';
  v_bad text;$o$,
  $n$  v_old_intakes uuid[] := '{}';
  v_id uuid;
  v_bad text;$n$,
  -- The state check moves under the locks.
  $o$  select string_agg(i.number || ' (' || i.state || ')', ', ' order by i.number) into v_bad
  from public.intake i
  where i.id = any (v_intakes) and i.state in ('draft', 'done', 'cancelled');
  if v_bad is not null then
    raise exception 'cannot pool %: only saved, open intakes can be allocated', v_bad using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_payload -> 'settlements', '[]'::jsonb)) <> 'array'$o$,
  $n$  if jsonb_typeof(coalesce(p_payload -> 'settlements', '[]'::jsonb)) <> 'array'$n$,
  $o$    returning * into v_session;
  end if;

  -- Pooled intakes$o$,
  $n$    returning * into v_session;
  end if;

  -- Each pooled intake's reconcile lock (sorted ids), as reconcile, move bin and pull back take
  -- it, so a move or pull back of the intake waits for this save, or this save for it (#102).
  -- The states are read under the locks: a pulled-back intake is pooled at reconcile.
  foreach v_id in array (select array_agg(x order by x) from unnest(v_intakes) x) loop
    perform pg_advisory_xact_lock(hashtextextended('reconcile:' || v_id::text, 0));
  end loop;
  select string_agg(i.number || ' (' || i.state || ')', ', ' order by i.number) into v_bad
  from public.intake i
  where i.id = any (v_intakes) and i.state in ('draft', 'done', 'cancelled');
  if v_bad is not null then
    raise exception 'cannot pool %: only saved, open intakes can be allocated', v_bad using errcode = '22023';
  end if;

  -- Pooled intakes$n$);
