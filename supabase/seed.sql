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

-- WP-05 station gallery fixture: a real master intake, not a parser-only acceptance.
insert into public.customer(id, org_id, name, phone)
values ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
        'Station Demo', '+19075550101') on conflict (id) do nothing;
insert into public.intake(org_id, number, customer_id, site_id, tote_count, state)
select '00000000-0000-4000-8000-000000000001', 'INT-0001',
       '00000000-0000-4000-8000-000000000101', id, 1, 'holding'
from public.site where org_id = '00000000-0000-4000-8000-000000000001' and name = 'Main'
on conflict (org_id, number) do nothing;
-- Its tote tag (an intake past draft has its X-of-Y tags); QR text from the generated
-- app.qr_tote (packages/rules qr.ts).
insert into public.tote_tag (org_id, intake_id, tote_no, of_count, qr)
select i.org_id, i.id, 1, 1, app.qr_tote(i.number, 1)
from public.intake i
where i.org_id = '00000000-0000-4000-8000-000000000001' and i.number = 'INT-0001'
on conflict (intake_id, tote_no) do nothing;
