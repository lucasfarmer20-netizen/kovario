# Dejavoo SPIn terminal provisioning (ops)

How to put a Dejavoo card terminal behind Filletry's register (`dejavoo_spin` provider,
`docs/05-PAYMENTS.md §4`). This is ops work: nothing here is code, and **the terminal is live
money** — every test is a small amount that you void.

## 1. What you need from the processor (iPOSPays / Dejavoo)

| Item | Where it goes |
|---|---|
| **TPN** (one per physical terminal) | Admin → Payment terminals → TPN |
| **Authkey** for that TPN | Supabase Vault only (§3) — never in Filletry's UI, a ticket, chat or email |
| **Register id**, only if the processor assigned one | Admin → Payment terminals → Register id. Leave blank otherwise: an empty or placeholder RegisterId fails every call with StatusCode **2003 "Register not found"** |
| SPIn host | `dev.spinpos.net` (sandbox) or `spinpos.net` (production) |

Multi-terminal = one TPN per terminal; each TPN is its own batch. Batching is automatic on the
host side — there is no settle button in Filletry.

## 2. On the device

1. **SPIn enabled** on the terminal, with the same TPN (and Register id, if one is used) and the
   same host (sandbox vs production) as the Filletry terminal record. A mismatch shows as a
   config error (StatusCode 1009 / 1017 / 2002–2005) on the first sale.
2. **Cash disabled via S.T.E.A.M**, so every transaction defaults to card. Cash is recorded in
   Filletry's register (manual tender), never on the terminal.
3. The terminal's own receipt printing is suppressed by every request (`PrintReceipt: No`);
   Filletry prints its own receipt from the stored payment (DECISION-13). Nothing to change on
   the device for that.

## 3. Store the Authkey in Vault

Filletry reads the Authkey from Supabase Vault by the terminal's **secret ref**, which is always
`terminal:<org id>:<name>` (the org id is shown in Admin → Payment terminals next to the field;
a ref for another org is refused). In the Supabase dashboard → SQL editor of the right project
(staging or production), as an operator:

```sql
-- new terminal
select vault.create_secret('<paste the Authkey here>', 'terminal:<org id>:front-counter',
                           'Dejavoo Authkey, TPN <tpn>');

-- rotate the key of an existing terminal
select vault.update_secret(
  (select id from vault.secrets where name = 'terminal:<org id>:front-counter'),
  '<new Authkey>');
```

Clear the SQL editor afterwards. Never paste the key anywhere else; Filletry never logs it (the
adapter scrubs `Authkey`, `AccountNumber`, `Pan`, `FullCardNumber` and card numbers from every
stored payload).

## 4. Create the terminal in Filletry

An **owner** opens **Admin → Payment terminals** and adds:

- **Name** (what the cashier picks at the register) and **Site**;
- **Endpoint host**: `dev.spinpos.net` or `spinpos.net` (stored as `https://<host>`);
- **TPN**; **Register id** only if assigned (§1);
- **Timeout s**: how long the terminal waits for the customer (SPInProxyTimeout), 30–180,
  blank = 120. Filletry waits that plus 30 s for the HTTP answer;
- **Secret ref**: the `<name>` part of the Vault secret from §3.

Uncheck **Active** to take a terminal out of service: the register refuses new sales on it, but
its existing payments can still be status-checked, voided and refunded. Keep its Vault secret
until the last of them is settled.

## 5. First live test (required before the terminal takes customers)

Run the **manual live test checklist** in `docs/wp/WP-17.md` on every new terminal (and after a
TPN, host or Authkey change): a $1.00 sale, a Cancel, a decline if the processor provides a test
card, and a **void** of every approved test sale the same day.

## 6. Reading failures

| Cashier sees | StatusCode class | What to do |
|---|---|---|
| "Terminal setup problem (…)" | config_error `1009 1017 1019 1020 1024 2002 2003 2004 2005 2101` | Check TPN / Register id / host on device and in Filletry; check the Vault secret name; then call the processor |
| "The terminal rejected the request (…)" | bad_request `1002 1003 1004 1007 1008 1013 1016 2006 2102 2201` (and lookup errors on a sale) | A Filletry bug: file an issue with the payment number (the stored, scrubbed payload has the details) |
| "Could not reach the terminal … Nothing was charged" | network (refused / DNS) | Check the venue's internet; retry |
| "… checking status" / payment **indeterminate** | indeterminate `1000 1005 1006 1030 1999 2001 2007 2008 2010 2011 2110`, a timeout, 5xx | Never re-charge. Press **Check status**; if still unknown, a manager looks the sale up in the iPOSPays portal by its reference and marks the payment |
| "Declined: <bank reason>" | 1015, or 1012 with a host code ≠ 00 | Customer uses another card |
