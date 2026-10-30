-- An allocation save never pools an intake a concurrent release is closing (#113, I10;
-- docs/04-BUSINESS-RULES.md §8). A save refuses draft, done and cancelled intakes (DECISION-32) by
-- reading their states after it takes the org's allocation billing lock (its first lock, after
-- action_log) and the intakes' reconcile locks. The intake close gate (app.try_close_after_release) runs only
-- inside release_party and release_by_tag, which take the same billing lock at level 0 since #112
-- (20261106000000_release_billing_lock.sql) and hold it to commit. So a release closing an intake
-- commits before the save reads the states and the save refuses the done intake, or it waits for
-- the save and its close gate sees the save's pooling and box plans (I10 (d)). Restore only
-- reopens a done intake, and holds the billing lock too.
--
-- No lock or behaviour changes here: #112's lock order already serialises the two. This rewords
-- the save's comment, which named only the reconcile locks, so the function states why its state
-- read is sound. The forced interleavings (Complete and Release-by-Tag, both orders) are in
-- packages/db/src/allocation-pool-lock.db.test.ts.

-- Re-create save_allocation_session from its current definition with exact replacements (as
-- 20261106000000_release_billing_lock.sql). Raises if the old text is missing, unless the new
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

select pg_temp.reword('public.save_allocation_session(text,jsonb)',
  $o$  -- The states are read under the locks: a pulled-back intake is pooled at reconcile.$o$,
  $n$  -- The states are read under the locks: a pulled-back intake is pooled at reconcile. They are
  -- also read under the billing lock taken above, which every release path holds when it closes
  -- an intake (I10, #112): a release that closed one committed first and it is refused as done
  -- here, or the release waits for this save and its close gate sees this pooling (#113).$n$);
