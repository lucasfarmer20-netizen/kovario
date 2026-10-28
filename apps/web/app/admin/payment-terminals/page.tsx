import { randomUUID } from "node:crypto";
import { SPIN_DEFAULT_TIMEOUT_SECS } from "payments";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { savePaymentTerminal } from "./actions";

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
      <Label>
        Site
        <Select name="site_id" defaultValue={t?.site_id ?? ""}>
          <option value="">No site</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Label>
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
      <Label>
        Secret ref
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {secretPrefix}
          <Input
            name="secret_name"
            defaultValue={secretName}
            placeholder="front-counter"
            required
            maxLength={60}
            className="w-36"
          />
        </span>
      </Label>
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
  const secretPrefix = `terminal:${session.claims.orgId}:`;
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
          Dejavoo SPIn card terminals for the register. Each terminal has its own TPN (its own
          batch). The endpoint host is <code>dev.spinpos.net</code> for the sandbox and{" "}
          <code>spinpos.net</code> for live money. Leave Register id blank unless the processor gave
          you one — a wrong one fails every sale. The Authkey is never entered here: ops stores it
          in Vault under the secret ref shown (see the Dejavoo provisioning runbook).
        </p>
        {isOwner ? (
          <ActionForm
            action={savePaymentTerminal}
            actionId={randomUUID()}
            submitLabel="Add terminal"
          >
            <TerminalFields sites={siteList} secretPrefix={secretPrefix} />
          </ActionForm>
        ) : (
          <p className="text-sm">Only an owner adds or edits payment terminals.</p>
        )}
      </section>

      {terminals.error ? <p className="text-destructive">{terminals.error.message}</p> : null}

      <ul className="flex flex-col divide-y divide-border">
        {(terminals.data ?? []).map((t) => (
          <li key={t.id} className="py-3">
            {isOwner && t.provider === "dejavoo_spin" ? (
              <ActionForm action={savePaymentTerminal} actionId={randomUUID()} submitLabel="Save">
                <TerminalFields sites={siteList} secretPrefix={secretPrefix} t={t} />
              </ActionForm>
            ) : (
              <p className="text-sm">
                <span className="font-medium">{t.name}</span> · {t.provider} · {siteName(t.site_id)}
                {t.provider === "dejavoo_spin"
                  ? ` · ${str(t.config, "endpoint_url")} · TPN ${str(t.config, "tpn")}`
                  : null}
                {t.is_active ? null : " · inactive"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
