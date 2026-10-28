import { randomUUID } from "node:crypto";
import { SPIN_DEFAULT_TIMEOUT_SECS } from "payments";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { secretNameField, stripeWebhookPath } from "@/lib/payment-terminals";
import { savePaymentTerminal, saveStripeTerminal } from "./actions";

type Site = { id: string; name: string };
type Terminal = {
  id: string;
  name: string;
  provider: string;
  site_id: string | null;
  config: unknown;
  secret_ref: string | null;
  is_active: boolean;
};

const str = (o: unknown, k: string): string => {
  const v = o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};

function SiteSelect({ sites, siteId }: { sites: Site[]; siteId?: string | null }) {
  return (
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
  );
}

/** A Vault secret name: the org prefix shown, the owner types the rest. */
function SecretNameInput({
  label,
  name,
  prefix,
  value,
  placeholder,
  required = false,
}: {
  label: string;
  name: string;
  prefix: string;
  value: string;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <Label>
      {label}
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {prefix}
        <Input
          name={name}
          defaultValue={value}
          placeholder={placeholder}
          required={required}
          maxLength={60}
          autoComplete="off"
          className="w-36"
        />
      </span>
    </Label>
  );
}

function TerminalFields({
  sites,
  secretPrefix,
  t,
}: {
  sites: Site[];
  secretPrefix: string;
  t?: Terminal;
}) {
  const secretName = t?.secret_ref?.startsWith(secretPrefix)
    ? t.secret_ref.slice(secretPrefix.length)
    : "";
  return (
    <>
      <input type="hidden" name="terminal_id" value={t?.id ?? ""} />
      <Label>
        Name
        <Input name="name" defaultValue={t?.name ?? ""} required maxLength={80} />
      </Label>
      <SiteSelect sites={sites} siteId={t?.site_id} />
      <Label>
        Endpoint host
        <Input
          name="endpoint"
          defaultValue={str(t?.config, "endpoint_url")}
          placeholder="spinpos.net"
          required
          maxLength={200}
        />
      </Label>
      <Label>
        TPN
        <Input
          name="tpn"
          defaultValue={str(t?.config, "tpn")}
          required
          maxLength={32}
          className="w-36"
        />
      </Label>
      <Label>
        Register id (optional)
        <Input
          name="register_id"
          defaultValue={str(t?.config, "register_id")}
          maxLength={40}
          className="w-32"
        />
      </Label>
      <Label>
        Timeout s
        <Input
          name="timeout_secs"
          type="number"
          min={30}
          max={180}
          step={1}
          defaultValue={str(t?.config, "timeout_secs")}
          placeholder={String(SPIN_DEFAULT_TIMEOUT_SECS)}
          className="w-24"
        />
      </Label>
      <SecretNameInput
        label="Secret ref"
        name="secret_name"
        prefix={secretPrefix}
        value={secretName}
        placeholder="front-counter"
        required
      />
      <Label>
        Active
        <input name="is_active" type="checkbox" defaultChecked={t?.is_active ?? true} />
      </Label>
    </>
  );
}

function StripeFields({
  sites,
  orgId,
  secretPrefix,
  t,
}: {
  sites: Site[];
  orgId: string;
  secretPrefix: string;
  t?: Terminal;
}) {
  return (
    <>
      <input type="hidden" name="terminal_id" value={t?.id ?? ""} />
      <Label>
        Name
        <Input name="name" defaultValue={t?.name ?? ""} required maxLength={80} />
      </Label>
      <SiteSelect sites={sites} siteId={t?.site_id} />
      <Label>
        Reader id
        <Input
          name="reader_id"
          defaultValue={str(t?.config, "stripe_reader_id")}
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
          defaultValue={str(t?.config, "stripe_location_id")}
          placeholder="tml_…"
          pattern="tml_[A-Za-z0-9]+"
          className="w-48"
        />
      </Label>
      <SecretNameInput
        label="Restricted key (Vault secret)"
        name="secret_name"
        prefix={secretPrefix}
        value={secretNameField(orgId, t?.secret_ref)}
        placeholder="stripe-rk"
        required
      />
      <SecretNameInput
        label="Webhook signing secret (Vault secret)"
        name="webhook_secret_name"
        prefix={secretPrefix}
        value={secretNameField(orgId, str(t?.config, "webhook_secret_ref"))}
        placeholder="stripe-whsec"
      />
      <Label>
        Active
        <input name="is_active" type="checkbox" defaultChecked={t?.is_active ?? true} />
      </Label>
    </>
  );
}

export default async function PaymentTerminalsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const isOwner = session.claims.appRole === "owner";
  const orgId = session.claims.orgId;
  const secretPrefix = `terminal:${orgId}:`;
  const [terminals, sites] = await Promise.all([
    session.supabase
      .from("payment_terminal")
      .select("id, name, provider, site_id, config, secret_ref, is_active")
      .order("name"),
    session.supabase.from("site").select("id, name").order("name"),
  ]);
  const siteList = sites.data ?? [];
  const siteName = (id: string | null) => siteList.find((s) => s.id === id)?.name ?? "No site";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Payment terminals</h1>
        <p className="text-sm text-muted-foreground">
          Card terminals for the register. Secrets (a Dejavoo Authkey, a Stripe restricted key) are
          never entered here: ops stores them in Vault under this organisation&apos;s secret names,{" "}
          <code>{secretPrefix}…</code>, and a terminal can only name its own organisation&apos;s
          secrets.
        </p>
        {isOwner ? null : <p className="text-sm">Only an owner adds or edits payment terminals.</p>}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Dejavoo SPIn</h2>
        <p className="text-sm text-muted-foreground">
          Each terminal has its own TPN (its own batch). The endpoint host is{" "}
          <code>dev.spinpos.net</code> for the sandbox and <code>spinpos.net</code> for live money.
          Leave Register id blank unless the processor gave you one — a wrong one fails every sale.
          See the Dejavoo provisioning runbook for the Authkey.
        </p>
        {isOwner ? (
          <ActionForm
            action={savePaymentTerminal}
            actionId={randomUUID()}
            submitLabel="Add terminal"
          >
            <TerminalFields sites={siteList} secretPrefix={secretPrefix} />
          </ActionForm>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Stripe Terminal</h2>
        <p className="text-sm text-muted-foreground">
          Readers are driven by the server: the register sends the payment to the reader and waits
          for the customer. Each reader needs its <strong>reader id</strong> (tmr_…) and the Vault
          secret holding your Stripe <strong>restricted key</strong> (rk_live_…), with write access
          to PaymentIntents, Refunds, Terminal readers and connection tokens. The location (tml_…)
          scopes connection tokens. To reconcile payments the register could not confirm, add a
          Stripe webhook for <code>payment_intent.succeeded</code>,{" "}
          <code>payment_intent.payment_failed</code> and <code>payment_intent.canceled</code> at the
          reader&apos;s webhook URL below, and store its signing secret in Vault.
        </p>
        {isOwner ? (
          <ActionForm action={saveStripeTerminal} actionId={randomUUID()} submitLabel="Add reader">
            <StripeFields sites={siteList} orgId={orgId} secretPrefix={secretPrefix} />
          </ActionForm>
        ) : null}
      </section>

      {terminals.error ? <p className="text-destructive">{terminals.error.message}</p> : null}

      <ul className="flex flex-col divide-y divide-border">
        {(terminals.data ?? []).map((t) => (
          <li key={t.id} className="flex flex-col gap-2 py-3">
            {isOwner && t.provider === "dejavoo_spin" ? (
              <ActionForm action={savePaymentTerminal} actionId={randomUUID()} submitLabel="Save">
                <TerminalFields sites={siteList} secretPrefix={secretPrefix} t={t} />
              </ActionForm>
            ) : isOwner && t.provider === "stripe_terminal" ? (
              <ActionForm action={saveStripeTerminal} actionId={randomUUID()} submitLabel="Save">
                <StripeFields sites={siteList} orgId={orgId} secretPrefix={secretPrefix} t={t} />
              </ActionForm>
            ) : (
              <p className="text-sm">
                <span className="font-medium">{t.name}</span> · {t.provider} · {siteName(t.site_id)}
                {t.provider === "dejavoo_spin"
                  ? ` · ${str(t.config, "endpoint_url")} · TPN ${str(t.config, "tpn")}`
                  : null}
                {t.provider === "stripe_terminal"
                  ? ` · reader ${str(t.config, "stripe_reader_id")}`
                  : null}
                {t.is_active ? null : " · inactive"}
              </p>
            )}
            {t.provider === "stripe_terminal" ? (
              <p className="text-xs text-muted-foreground">
                Webhook URL: <code>{stripeWebhookPath(t.id)}</code> on this site&apos;s address
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
