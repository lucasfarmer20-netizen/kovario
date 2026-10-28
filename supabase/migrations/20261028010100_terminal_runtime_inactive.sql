-- WP-17: a deactivated terminal still serves its existing payments. Unchecking Active on
-- Admin → Payment terminals retires a terminal for NEW sales — payment_begin refuses an
-- inactive terminal ('choose an active card terminal') — but its indeterminate payments must
-- still be reconciled (Status) and its approved payments voided / refunded. Those operations
-- resolve the terminal through payment_terminal_runtime, so it no longer filters on is_active;
-- it stays org-scoped and service-role only (grants unchanged by create or replace).

create or replace function public.payment_terminal_runtime(p_terminal_id uuid, p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t public.payment_terminal;
  v_secret text := '';
begin
  select * into v_t from public.payment_terminal
  where id = p_terminal_id and org_id = p_org_id;
  if not found then
    raise exception 'payment terminal not found' using errcode = 'P0002';
  end if;
  if v_t.secret_ref is not null then
    select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = v_t.secret_ref limit 1;
    if v_secret is null then
      raise exception 'terminal % has no Vault secret named %', v_t.name, v_t.secret_ref using errcode = 'P0002';
    end if;
  end if;
  return jsonb_build_object('id', v_t.id, 'name', v_t.name, 'provider', v_t.provider,
                            'config', v_t.config, 'secret', v_secret, 'is_active', v_t.is_active);
end;
$$;
