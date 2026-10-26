-- Schema `app` holds Kovario's SQL helpers (app.org_id(), enable_org_rls, next_seq, ...).
-- Never create objects in Supabase's managed `auth` schema (docs/01-ARCHITECTURE.md §3).
create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;
