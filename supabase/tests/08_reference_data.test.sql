-- Reference data the app needs to run lives in migrations, never in seed.sql: hosted
-- deploys (`supabase db push`, docs/11-DEPLOY.md) never run seed files. CI runs this file
-- right after `supabase db reset --no-seed`, so an empty or partial lookup table fails
-- before merge. Add a table here whenever a migration introduces platform reference data.
-- (Per-org reference data — species, rate cards — is created by onboarding, not here.)
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(5);

select set_eq(
  $$ select kind from app.sequence_prefix $$,
  array['intake', 'storage_intake', 'storage_pickup_batch', 'wave', 'charge',
        'allocation_session', 'settlement', 'box_plan', 'shipment', 'payment', 'audit_batch',
        'register_order'],
  'app.sequence_prefix has every document kind (docs/01-ARCHITECTURE.md §3; REG- is WP-16''s S7 cash ref)'
);

select set_eq(
  $$ select entity from app.state_entity $$,
  array['intake', 'storage_intake', 'storage_pickup_batch', 'storage_box', 'wave', 'asset_tag',
        'vessel', 'box_plan', 'allocation_session', 'settlement', 'shipment', 'payment',
        'register_order', 'print_job'],
  'app.state_entity registers every guarded table'
);

select isnt_empty(
  $$ select 1 from app.state_transitions $$,
  'app.state_transitions is filled by migration'
);

select is_empty(
  $$ select entity from app.state_entity except select entity from app.state_transitions $$,
  'every guarded entity has at least one allowed transition'
);

select is_empty(
  $$ select entity from app.state_transitions except select entity from app.state_entity $$,
  'every transition belongs to a registered entity'
);

select * from finish();
rollback;
