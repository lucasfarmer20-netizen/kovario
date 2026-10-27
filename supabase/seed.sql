-- Local seed data, loaded by `supabase db reset` after migrations.
-- Demo org `demo-plant` (docs/01-ARCHITECTURE.md §8). Users are not seeded here (never
-- write auth.users by hand): `pnpm db:demo-owner` creates the demo owner through the
-- Auth admin API and adds the membership.
insert into public.org (id, slug, name, timezone)
values ('00000000-0000-4000-8000-000000000001', 'demo-plant', 'Demo Plant', 'America/Anchorage')
on conflict (slug) do nothing;

insert into public.site (org_id, name, is_default)
values
  ('00000000-0000-4000-8000-000000000001', 'Main', true),
  ('00000000-0000-4000-8000-000000000001', 'Lodge', false)
on conflict (org_id, name) do nothing;

-- Customers, intakes and the rest of demo-plant come only from `pnpm db:seed-demo`
-- (scripts/seed-demo-org.ts), which owns INT-0001…0009 — don't add domain rows here.
