import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ActionForm } from "@/components/admin/action-form";
import { TimezoneSelect } from "@/components/admin/timezone-select";
import { Input, Label } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { formatCarrierAllowlist, type OrgSettings } from "@/lib/org-settings";
import { saveOrgSettings } from "./actions";

export default async function SettingsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: org, error } = await session.supabase
    .from("org")
    .select("name, slug, timezone, settings")
    .maybeSingle();
  if (error || !org) return <p className="text-destructive">{error?.message ?? "No org."}</p>;
  const s = org.settings as OrgSettings;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Plant-wide defaults. Prices (per-lb rates, Fast Pass, ribbing, storage) are on the{" "}
          <Link href="/admin/rate-cards" className="underline">
            rate cards
          </Link>
          , not here. Short name: <code>{org.slug}</code>
        </p>
      </section>

      <ActionForm
        action={saveOrgSettings}
        actionId={randomUUID()}
        submitLabel="Save settings"
        className="flex-col items-stretch gap-6"
      >
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-medium">Business</legend>
          <Label>
            Public pickup hours
            <Input name="pickup_hours" defaultValue={s.pickup_hours ?? ""} maxLength={500} />
          </Label>
          <Label>
            Public rates notice
            <Input
              name="rates_notice"
              defaultValue={s.rates_notice ?? s.receipt_footer}
              maxLength={500}
            />
          </Label>
          <Label>
            Name
            <Input name="name" defaultValue={org.name} required maxLength={120} />
          </Label>
          <Label>
            Time zone
            <TimezoneSelect name="timezone" defaultValue={org.timezone} />
          </Label>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-medium">Intake &amp; floor</legend>
          <Label>
            Cooler hold (hours)
            <Input
              name="hold_hours"
              type="number"
              min={1}
              max={720}
              step={1}
              defaultValue={s.hold_hours}
            />
          </Label>
          <Label>
            Estimated pickup (days after intake)
            <Input
              name="estimated_pickup_days"
              type="number"
              min={0}
              max={60}
              step={1}
              defaultValue={s.estimated_pickup_days}
            />
          </Label>
          <Label>
            Wave target (lb)
            <Input
              name="wave_target_lb"
              type="number"
              min={1}
              step="any"
              defaultValue={s.wave_target_lb}
            />
          </Label>
          <Label>
            Wave tolerance (± lb)
            <Input
              name="wave_tolerance_lb"
              type="number"
              min={0}
              step="any"
              defaultValue={s.wave_tolerance_lb}
            />
          </Label>
          <Label>
            Asset tag digits
            <Input value={s.scanner.tag_digits} readOnly aria-readonly className="bg-muted" />
            <input type="hidden" name="tag_digits" value={s.scanner.tag_digits} />
          </Label>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-medium">Register tax (exclusive)</legend>
          <Label>
            Tax rate (%)
            <Input
              name="tax_rate_pct"
              type="number"
              min={0}
              max={50}
              step="any"
              defaultValue={Math.round(s.tax.rate * 100_000) / 1000}
            />
          </Label>
          <Label>
            Tax cap per transaction ($, empty = no cap)
            <Input
              name="tax_cap_amount"
              type="number"
              min={0}
              step="0.01"
              defaultValue={s.tax.cap_amount ?? ""}
            />
          </Label>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-medium">Shipping</legend>
          <Label>
            Carriers (* = all, or e.g. usps, fedex)
            <Input
              name="carrier_allowlist"
              defaultValue={formatCarrierAllowlist(s.shipping.carrier_allowlist)}
              maxLength={400}
            />
          </Label>
          <Label>
            Buy labels up to (days before ship date)
            <Input
              name="buy_window_days"
              type="number"
              min={0}
              max={30}
              step={1}
              defaultValue={s.shipping.buy_window_days}
            />
          </Label>
        </fieldset>

        <fieldset className="grid gap-4">
          <legend className="mb-2 font-medium">Customers</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="status_page_enabled"
              defaultChecked={s.status_page_enabled}
              className="size-5"
            />
            Public status page (customers look up their order by phone)
          </label>
          <Label>
            Receipt footer
            <textarea
              name="receipt_footer"
              defaultValue={s.receipt_footer}
              maxLength={500}
              rows={3}
              className="rounded-md border border-input bg-background p-3 text-sm"
            />
          </Label>
        </fieldset>
      </ActionForm>
    </div>
  );
}
