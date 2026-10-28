import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { stripeWebhookPath } from "@/lib/payment-terminals";
import { saveStripeTerminal } from "./actions";

type Site = { id: string; name: string };
type StripeConfig = {
  stripe_reader_id?: string;
  stripe_location_id?: string;
  webhook_secret_ref?: string;
};

const PROVIDER_LABEL: Record<string, string> = {
  manual: "Manual (cash / check / external)",
  dejavoo_spin: "Dejavoo SPIn",
  stripe_terminal: "Stripe Terminal",
};

function StripeFields({
  sites,
  name = "",
  siteId = null,
  config = {},
  secretRef = "",
  isActive = true,
}: {
  sites: Site[];
  name?: string;
  siteId?: string | null;
  config?: StripeConfig;
  secretRef?: string | null;
  isActive?: boolean;
}) {
  return (
    <>
      <Label>
        Name
        <Input name="name" defaultValue={name} required maxLength={80} />
      </Label>
      <Label>
        Site
        <Select name="site_id" defaultValue={siteId ?? ""}>
          <option value="">No site</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Reader id
        <Input
          name="reader_id"
          defaultValue={config.stripe_reader_id ?? ""}
          required
          placeholder="tmr_…"
          pattern="tmr_[A-Za-z0-9]+"
          className="w-48"
        />
      </Label>
      <Label>
        Location
        <Input
          name="location_id"
          defaultValue={config.stripe_location_id ?? ""}
          placeholder="tml_…"
          pattern="tml_[A-Za-z0-9]+"
          className="w-48"
        />
      </Label>
      <Label>
        Restricted key (Vault secret name)
        <Input
          name="secret_ref"
          defaultValue={secretRef ?? ""}
          required
          maxLength={200}
          placeholder="stripe_rk:front"
          autoComplete="off"
          className="w-56"
        />
      </Label>
      <Label>
        Webhook signing secret (Vault secret name)
        <Input
          name="webhook_secret_ref"
          defaultValue={config.webhook_secret_ref ?? ""}
          maxLength={200}
          placeholder="stripe_whsec:front"
          autoComplete="off"
          className="w-56"
        />
      </Label>
      <Label>
        Active
        <input name="is_active" type="checkbox" defaultChecked={isActive} />
      </Label>
    </>
  );
}

export default async function PaymentTerminalsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [terminals, sites] = await Promise.all([
    session.supabase
      .from("payment_terminal")
      .select("id, name, provider, site_id, config, secret_ref, is_active")
      .order("name"),
    session.supabase.from("site").select("id, name").order("name"),
  ]);
  const siteList = sites.data ?? [];

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Payment terminals</h1>
        <p className="text-sm text-muted-foreground">
          Stripe Terminal readers are driven by the server: the register sends the payment to the
          reader and waits for the customer. Each reader needs its <strong>reader id</strong>{" "}
          (tmr_…) and the <strong>name</strong> of the Vault secret holding your Stripe{" "}
          <strong>restricted key</strong> (rk_live_…) — never paste the key itself here. The key
          needs write access to PaymentIntents, Refunds, Terminal readers and connection tokens. The
          location (tml_…) scopes connection tokens. To reconcile payments the register could not
          confirm, add a Stripe webhook for the events <code>payment_intent.succeeded</code>,{" "}
          <code>payment_intent.payment_failed</code> and <code>payment_intent.canceled</code>{" "}
          pointing at the reader&apos;s webhook URL below, and store its signing secret in Vault.
        </p>
        <ActionForm action={saveStripeTerminal} actionId={randomUUID()} submitLabel="Add reader">
          <StripeFields sites={siteList} />
        </ActionForm>
      </section>

      {terminals.error || sites.error ? (
        <p className="text-destructive">{(terminals.error ?? sites.error)?.message}</p>
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {(terminals.data ?? []).map((t) => (
          <li key={t.id} className="flex flex-col gap-2 py-3">
            <p className="text-sm">
              <span className="font-medium">{t.name}</span> ·{" "}
              {PROVIDER_LABEL[t.provider] ?? t.provider}
              {t.is_active ? null : " · inactive"}
            </p>
            {t.provider === "stripe_terminal" ? (
              <>
                <ActionForm action={saveStripeTerminal} actionId={randomUUID()} submitLabel="Save">
                  <input type="hidden" name="terminal_id" value={t.id} />
                  <StripeFields
                    sites={siteList}
                    name={t.name}
                    siteId={t.site_id}
                    config={(t.config ?? {}) as StripeConfig}
                    secretRef={t.secret_ref}
                    isActive={t.is_active}
                  />
                </ActionForm>
                <p className="text-xs text-muted-foreground">
                  Webhook URL: <code>{stripeWebhookPath(t.id)}</code> on this site&apos;s address
                </p>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
