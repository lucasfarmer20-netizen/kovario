-- v1.2 floor wording (#98, docs/11-FLOOR-WORDING.md): the reason / message text the floor
-- RPCs return to operators says order / tote / basket / location / box, never intake / vessel /
-- bin / asset tag, and a reject says why, then what to do. Code identifiers, columns and enum
-- values do not change; only the quoted text does.
--
-- Each function is re-created from its current definition (pg_get_functiondef) with exact
-- old → new replacements, so this file lists only what changes. A replacement whose old text is
-- missing raises, unless its new text is already there (re-run). Grants survive CREATE OR REPLACE.
-- Rule messages generated from packages/rules (app.bin_move_problem, app.pull_back_problem,
-- app.release_line_issue) are regenerated there (20261101000000_suspect_rules_wording.sql,
-- 20261101000010_release_rules_wording.sql), not reworded here.

create function pg_temp.reword(p_fn regprocedure, variadic p_pairs text[])
returns void
language plpgsql
as $$
declare
  v_def text := pg_get_functiondef(p_fn);
  v_n int;
begin
  if cardinality(p_pairs) % 2 <> 0 then
    raise exception 'reword(%): pairs must be old, new', p_fn;
  end if;
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

-- Wave -----------------------------------------------------------------------------------------
select pg_temp.reword('public.create_wave(uuid[],text,uuid)',
  $o$'Select holding intakes'$o$,
  $n$'Tap orders to add to the wave'$n$,
  $o$'Selection changed: choose unassigned holding intakes'$o$,
  $n$'The orders changed. Tap orders to add to the wave again.'$n$);
select pg_temp.reword('public.advance_wave(uuid,text,uuid)',
  $o$'Wave intakes are no longer holding'$o$,
  $n$'An order in this wave is no longer in the cooler. Cancel the wave and start again.'$n$);
select pg_temp.reword('public.scan_wave_tote(uuid,text,text,uuid)',
  $o$'Unknown tote: scan a numbered tote label'$o$,
  $n$'Tote not found. Scan a tote from this wave.'$n$);
select pg_temp.reword('public.cancel_wave(uuid,text,uuid)',
  $o$'Wave cancelled; intakes returned to holding queue'$o$,
  $n$'Wave cancelled. Its orders are back in the cooler queue.'$n$);

-- Rollstock ------------------------------------------------------------------------------------
select pg_temp.reword('public.rollstock_scan_advance(text,uuid,text,uuid,text,text)',
  $o$'Intake wave changed; scan again'$o$,
  $n$'The order''s wave changed. Scan the tote again.'$n$,
  $o$'Open intake changed; refresh station'$o$,
  $n$'The open order changed. Refresh the station.'$n$,
  $o$'Unknown tote: scan a numbered tote label'$o$,
  $n$'Tote not found. Scan a tote.'$n$,
  $o$'Intake is not eligible for rollstock'$o$,
  $n$'This order is not ready for rollstock. Scan a different tote.'$n$,
  $o$'Intake already open at rollstock'$o$,
  $n$'This order is already open at rollstock.'$n$,
  $o$'Remove intake from verifying wave before bypass'$o$,
  $n$'This order is in a wave being checked. Remove it from the wave first.'$n$);

-- Reconcile ------------------------------------------------------------------------------------
select pg_temp.reword('app.vessel_label(public.vessel)',
  $o$'Tag ' || t.code$o$,
  $n$'Basket ' || t.code$n$);
select pg_temp.reword('public.reconcile_action(text,uuid,text,uuid,text,numeric,uuid,text,jsonb)',
  $o$raise exception 'Unknown tote';$o$,
  $n$raise exception 'Tote not found. Scan a tote.';$n$,
  $o$'Intake is not at reconcile'$o$,
  $n$'This order is not at reconcile. Scan a different tote.'$n$,
  $o$'Unknown tag'$o$,
  $n$'Basket not found. Scan a different basket.'$n$,
  $o$'Tag retired'$o$,
  $n$'This basket is retired. Scan a different basket.'$n$,
  $o$'Tag % in use by %'$o$,
  $n$'Basket % is already on %. Scan a different basket.'$n$,
  $o$'Unknown occupied vessel'$o$,
  $n$'Basket not found on this order'$n$,
  $o$'No positive stable reading for device scale'$o$,
  $n$'No stable reading from the scale. Enter the weight manually.'$n$,
  $o$'Every vessel needs positive weight and a tag unless exchange'$o$,
  $n$'Weigh every basket first'$n$,
  $o$Fix the bins or get a manager sign-off$o$,
  $n$Fix the baskets or get a manager sign-off$n$,
  -- Accept feedback says what happened, noun first ("Basket 005 added to INT-0002").
  $o$coalesce(reason,'Accepted'),'intake_id'$o$,
  $n$coalesce(reason,case p_operation
   when 'open' then format('Order %s open',i.number)
   when 'bind' then format('Basket %s added to %s',t.code,i.number)
   when 'exchange' then format('Exchange basket added to %s',i.number)
   when 'remove' then format('%s removed from %s',app.vessel_label(v),i.number)
   when 'manual' then format('%s weighed: %s lb (entered manually)',app.vessel_label(v),p_weight)
   when 'accept' then format('%s weighed: %s lb',app.vessel_label(v),sr.weight_lb)
   when 'send' then format('Order %s sent to blast',i.number)
   else 'Accepted' end),'intake_id'$n$);

-- Suspect picker / pull back (#88) --------------------------------------------------------------
select pg_temp.reword('public.variance_move_vessel(text,uuid,uuid,uuid,text)',
  $o$'Unknown vessel'$o$,
  $n$'Basket not found'$n$,
  $o$'Unknown intake'$o$,
  $n$'Order not found'$n$,
  $o$'Unknown occupied vessel'$o$,
  $n$'Basket not found on an order'$n$,
  $o$coalesce(v_tag, 'The exchange bin')$o$,
  $n$coalesce('Basket ' || v_tag, 'The exchange basket')$n$,
  $o$coalesce(v_tag, 'exchange bin')$o$,
  $n$coalesce('basket ' || v_tag, 'exchange basket')$n$);
select pg_temp.reword('public.intake_pull_back(text,uuid,text,text)',
  $o$'Unknown intake'$o$,
  $n$'Order not found'$n$);

-- Blast / Locate -------------------------------------------------------------------------------
select pg_temp.reword('app.freezer_vessel(text)',
  $o$'Scan a vessel tag first'$o$,
  $n$'Scan basket first'$n$,
  $o$'Unknown tag'$o$,
  $n$'Basket not found. Scan a different basket.'$n$,
  $o$'Tag % is not on a vessel'$o$,
  $n$'Basket % is not on an order. Scan a different basket.'$n$,
  $o$'Tag % is not on an occupied vessel'$o$,
  $n$'Basket % is empty. Scan a different basket.'$n$);
select pg_temp.reword('app.freezer_vessel_by_id(uuid)',
  $o$'Unknown vessel'$o$,
  $n$'Basket not found'$n$,
  $o$'Vessel % has a tag; scan the tag'$o$,
  $n$'Basket % has a tag. Scan it instead.'$n$);
select pg_temp.reword('app.freezer_vessel_scan(public.device_station,text,uuid,jsonb,uuid)',
  $o$label:=coalesce(tag,$o$,
  $n$label:=coalesce('Basket '||tag,$n$,
  $o$'Intake % has not been sent to blast'$o$,
  $n$'Order % has not been sent to blast. Scan a different basket.'$n$,
  $o$coalesce('Vessel '||tag, label)$o$,
  $n$label$n$,
  $o$'In blast: '||label||' · '||i.number$o$,
  $n$label||' in blast · '||i.number$n$,
  $o$'Already in blast: '||label||' · '||i.number$o$,
  $n$label||' already in blast · '||i.number$n$,
  $o$' — scan a location'$o$,
  $n$'. Scan a location.'$n$);
select pg_temp.reword('app.freezer_place(text,text,uuid,jsonb,uuid,boolean)',
  $o$'Vessel selection expired; scan the tag again'$o$,
  $n$'The basket selection expired. Scan the basket again.'$n$,
  $o$'Selected vessel changed since its tag was scanned; scan the tag again'$o$,
  $n$'The selected basket changed since it was scanned. Scan the basket again.'$n$,
  $o$label:=coalesce(tag,$o$,
  $n$label:=coalesce('Basket '||tag,$n$,
  $o$'Intake % has not been sent to blast'$o$,
  $n$'Order % has not been sent to blast. Scan a different basket.'$n$,
  $o$'Placed '||label||' → '||l.code$o$,
  $n$label||' placed at '||l.code$n$);

-- Boxing / release -----------------------------------------------------------------------------
select pg_temp.reword('public.boxing_scan(text,text,uuid,uuid)',
  $o$'Tag ' || $o$,
  $n$'Basket ' || $n$,
  $o$'Scan a basket tag or a boxing QR'$o$,
  $n$'Scan a basket or the boxing QR'$n$);
select pg_temp.reword('public.release_by_tag(text,text,numeric,text,text)',
  $o$'Unknown tag'$o$,
  $n$'Basket not found'$n$,
  $o$'Tag %s is not on a basket (already released?)'$o$,
  $n$'Basket %s is not on an order (already released?)'$n$,
  $o$'Tag %s was released meanwhile; nothing to do'$o$,
  $n$'Basket %s was released meanwhile; nothing to do'$n$);
select pg_temp.reword('public.release_party(text,uuid,uuid[],jsonb,text,uuid,text,text)',
  $o$'vessel lines are [$o$,
  $n$'basket lines are [$n$,
  $o$'a ticked vessel line needs$o$,
  $n$'a ticked basket line needs$n$,
  $o$'each vessel is listed once'$o$,
  $n$'each basket is listed once'$n$,
  $o$'vessel not found'$o$,
  $n$'basket not found'$n$,
  -- At boxing a basket is a basket, not a tote (totes are the numbered totes from intake).
  $o$'Nothing ticked: tick boxes or totes before Complete'$o$,
  $n$'Nothing ticked. Tick each box and basket being handed over, then Complete.'$n$,
  $o$tick the totes being handed over before finalising boxes$o$,
  $n$tick the baskets being handed over before finalising boxes$n$,
  $o$'% still has a tote to tick (%);$o$,
  $n$'% still has a basket to tick (%);$n$);
select pg_temp.reword('public.restore_vessel(text,uuid,text,text)',
  $o$'vessel not found'$o$,
  $n$'basket not found'$n$);

-- Admin: the printable tag pool is "basket tags" ------------------------------------------------
select pg_temp.reword('public.admin_update_org(text,text,text,jsonb)',
  $o$'Asset tag digits can only be raised$o$,
  $n$'Basket tag digits can only be raised$n$);

-- Storage pickup -------------------------------------------------------------------------------
select pg_temp.reword('app.storage_snapshot(uuid,uuid[],timestamp with time zone)',
  $o$'storage intake not found'$o$,
  $n$'storage order not found'$n$,
  $o$'every box must belong to this storage intake and still be stored'$o$,
  $n$'every box must belong to this storage order and still be stored'$n$);
select pg_temp.reword('public.storage_pickup_quote(uuid,uuid[])',
  $o$'storage intake not found'$o$,
  $n$'storage order not found'$n$);
select pg_temp.reword('public.create_pickup_batch(text,uuid,uuid[])',
  $o$'storage intake not found'$o$,
  $n$'storage order not found'$n$,
  $o$'storage intake % has no boxes in storage'$o$,
  $n$'storage order % has no boxes in storage'$n$);
select pg_temp.reword('public.storage_box_scan(text,text,uuid,text,integer)',
  $o$'Storage intake not found.'$o$,
  $n$'Storage order not found.'$n$,
  $o$'Not a storage box code. Type it as printed, e.g. STG-0001-2.'$o$,
  $n$'Not a box code. Enter it as printed, e.g. STG-0001-2.'$n$);
