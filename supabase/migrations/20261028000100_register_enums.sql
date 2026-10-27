-- WP-16 enum values and numbering, in their own migration: a new enum value cannot be used
-- in the transaction that adds it.
--   payment_event 'paid_hook'      — what apply_paid_register_order did for the payment;
--   payment_event 'manual_resolve' — a manager marked an unresolved payment (docs/05 §2.4).
alter type public.payment_event_kind add value if not exists 'paid_hook';
alter type public.payment_event_kind add value if not exists 'manual_resolve';

do $$ begin
  create type public.register_order_kind as enum ('sale', 'refund');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_tender as enum ('card', 'cash', 'check', 'external', 'comp');
exception when duplicate_object then null; end $$;

-- REG-0001: the register order number is the payment ref of cash / non-terminal releases (S7).
insert into app.sequence_prefix (kind, prefix) values ('register_order', 'REG')
on conflict (kind) do update set prefix = excluded.prefix;
