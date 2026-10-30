-- GENERATED from packages/rules/src/states.ts — do not edit by hand.
-- Regenerate with `pnpm --filter rules gen:states`; a rules test fails when this is stale.
-- Allowed state transitions (docs/03-STATE-MACHINES.md) for state_transition_guard().
-- `manager` edges are manager-only in canTransition(); the function performing the
-- transition enforces the role. Idempotent: upserts every edge and deletes edges that are
-- no longer in states.ts, so the table equals the generated set.

with generated (entity, from_state, to_state, manager) as (values
  ('intake', 'draft', 'holding', false),
  ('intake', 'holding', 'processing', false),
  ('intake', 'processing', 'rollstock', false),
  ('intake', 'rollstock', 'reconcile', false),
  ('intake', 'reconcile', 'blast_freezer', false),
  ('intake', 'blast_freezer', 'stored', false),
  ('intake', 'stored', 'done', false),
  ('intake', 'blast_freezer', 'done', false),
  ('intake', 'blast_freezer', 'reconcile', true),
  ('intake', 'draft', 'cancelled', true),
  ('intake', 'holding', 'cancelled', true),
  ('intake', 'processing', 'cancelled', true),
  ('intake', 'rollstock', 'cancelled', true),
  ('intake', 'reconcile', 'cancelled', true),
  ('intake', 'blast_freezer', 'cancelled', true),
  ('intake', 'stored', 'cancelled', true),
  ('storage_intake', 'draft', 'stored', false),
  ('storage_intake', 'stored', 'partial', false),
  ('storage_intake', 'stored', 'released', false),
  ('storage_intake', 'partial', 'released', false),
  ('storage_pickup_batch', 'pending', 'released', false),
  ('storage_pickup_batch', 'pending', 'void', false),
  ('storage_pickup_batch', 'void', 'released', true),
  ('storage_box', 'stored', 'released', false),
  ('wave', 'draft', 'verifying', false),
  ('wave', 'verifying', 'done', false),
  ('wave', 'draft', 'cancelled', false),
  ('wave', 'verifying', 'cancelled', false),
  ('asset_tag', 'available', 'in_use', false),
  ('asset_tag', 'in_use', 'available', false),
  ('asset_tag', 'available', 'retired', false),
  ('asset_tag', 'retired', 'available', false),
  ('vessel', 'occupied', 'emptied', false),
  ('vessel', 'occupied', 'void', true),
  ('vessel', 'emptied', 'void', true),
  ('vessel', 'emptied', 'occupied', true),
  ('box_plan', 'planned', 'packed', false),
  ('box_plan', 'packed', 'shipped', false),
  ('box_plan', 'planned', 'picked_up', false),
  ('allocation_session', 'draft', 'priced', false),
  ('allocation_session', 'priced', 'done', false),
  ('allocation_session', 'draft', 'cancelled', false),
  ('allocation_session', 'priced', 'cancelled', false),
  ('allocation_session', 'done', 'cancelled', false),
  ('settlement', 'draft', 'paid', false),
  ('shipment', 'draft', 'held', false),
  ('shipment', 'draft', 'label_bought', false),
  ('shipment', 'held', 'label_bought', false),
  ('shipment', 'label_bought', 'shipped', false),
  ('shipment', 'draft', 'cancelled', false),
  ('shipment', 'held', 'cancelled', false),
  ('shipment', 'label_bought', 'cancelled', false),
  ('shipment', 'shipped', 'cancelled', false),
  ('payment', 'pending', 'approved', false),
  ('payment', 'pending', 'declined', false),
  ('payment', 'pending', 'cancelled', false),
  ('payment', 'pending', 'indeterminate', false),
  ('payment', 'pending', 'error', false),
  ('payment', 'indeterminate', 'approved', false),
  ('payment', 'indeterminate', 'declined', false),
  ('payment', 'indeterminate', 'cancelled', false),
  ('payment', 'approved', 'voided', true),
  ('payment', 'approved', 'refunded', true),
  ('register_order', 'open', 'paid', false),
  ('register_order', 'open', 'void', false),
  ('print_job', 'queued', 'printing', false),
  ('print_job', 'printing', 'done', false),
  ('print_job', 'printing', 'failed', false),
  ('print_job', 'failed', 'queued', false)
), pruned as (
  delete from app.state_transitions t
  where not exists (
    select 1 from generated g
    where g.entity = t.entity and g.from_state = t.from_state and g.to_state = t.to_state
  )
)
insert into app.state_transitions (entity, from_state, to_state, manager)
select entity, from_state, to_state, manager from generated
on conflict (entity, from_state, to_state) do update set manager = excluded.manager;
