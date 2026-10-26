-- GENERATED from packages/rules/src/states.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:states`; a rules test fails when this is stale.
-- Allowed state transitions (docs/03-STATE-MACHINES.md) for state_transition_guard().
-- Rows marked `manager` are manager-only in canTransition(); the function performing
-- the transition enforces the role.

delete from state_transitions;

insert into state_transitions (entity, from_state, to_state) values
  ('intake', 'draft', 'holding'),
  ('intake', 'holding', 'processing'),
  ('intake', 'processing', 'rollstock'),
  ('intake', 'rollstock', 'reconcile'),
  ('intake', 'reconcile', 'blast_freezer'),
  ('intake', 'blast_freezer', 'stored'),
  ('intake', 'stored', 'done'),
  ('intake', 'blast_freezer', 'done'),
  ('intake', 'draft', 'cancelled'), -- manager
  ('intake', 'holding', 'cancelled'), -- manager
  ('intake', 'processing', 'cancelled'), -- manager
  ('intake', 'rollstock', 'cancelled'), -- manager
  ('intake', 'reconcile', 'cancelled'), -- manager
  ('intake', 'blast_freezer', 'cancelled'), -- manager
  ('intake', 'stored', 'cancelled'), -- manager
  ('storage_intake', 'draft', 'stored'),
  ('storage_intake', 'stored', 'partial'),
  ('storage_intake', 'stored', 'released'),
  ('storage_intake', 'partial', 'released'),
  ('storage_pickup_batch', 'pending', 'released'),
  ('storage_pickup_batch', 'pending', 'void'),
  ('storage_pickup_batch', 'void', 'released'), -- manager
  ('storage_box', 'stored', 'released'),
  ('wave', 'draft', 'verifying'),
  ('wave', 'verifying', 'done'),
  ('wave', 'draft', 'cancelled'),
  ('wave', 'verifying', 'cancelled'),
  ('asset_tag', 'available', 'in_use'),
  ('asset_tag', 'in_use', 'available'),
  ('asset_tag', 'available', 'retired'),
  ('asset_tag', 'retired', 'available'),
  ('vessel', 'occupied', 'emptied'),
  ('vessel', 'occupied', 'void'), -- manager
  ('vessel', 'emptied', 'void'), -- manager
  ('vessel', 'emptied', 'occupied'), -- manager
  ('box_plan', 'planned', 'packed'),
  ('box_plan', 'packed', 'shipped'),
  ('box_plan', 'planned', 'picked_up'),
  ('allocation_session', 'draft', 'priced'),
  ('allocation_session', 'priced', 'done'),
  ('allocation_session', 'draft', 'cancelled'),
  ('allocation_session', 'priced', 'cancelled'),
  ('allocation_session', 'done', 'cancelled'),
  ('settlement', 'draft', 'paid'),
  ('shipment', 'draft', 'held'),
  ('shipment', 'draft', 'label_bought'),
  ('shipment', 'held', 'label_bought'),
  ('shipment', 'label_bought', 'shipped'),
  ('shipment', 'draft', 'cancelled'),
  ('shipment', 'held', 'cancelled'),
  ('shipment', 'label_bought', 'cancelled'),
  ('shipment', 'shipped', 'cancelled'),
  ('payment', 'pending', 'approved'),
  ('payment', 'pending', 'declined'),
  ('payment', 'pending', 'cancelled'),
  ('payment', 'pending', 'indeterminate'),
  ('payment', 'pending', 'error'),
  ('payment', 'indeterminate', 'approved'),
  ('payment', 'indeterminate', 'declined'),
  ('payment', 'indeterminate', 'cancelled'),
  ('payment', 'approved', 'voided'), -- manager
  ('payment', 'approved', 'refunded'), -- manager
  ('register_order', 'open', 'paid'),
  ('register_order', 'open', 'void'),
  ('print_job', 'queued', 'printing'),
  ('print_job', 'printing', 'done'),
  ('print_job', 'printing', 'failed'),
  ('print_job', 'failed', 'queued');
