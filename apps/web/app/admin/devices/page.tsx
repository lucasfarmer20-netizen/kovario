import { randomUUID } from "node:crypto";
import { Constants } from "db";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { createDevice } from "./actions";
import { PairButton } from "./pair-button";

function lastSeen(at: string | null): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(at).toLocaleString();
}

export default async function DevicesPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [{ data: devices, error }, { data: sites }] = await Promise.all([
    session.supabase
      .from("device")
      .select("id, name, station, site_id, paired_at, last_seen_at, is_active")
      .order("name"),
    session.supabase.from("site").select("id, name, is_default").order("name"),
  ]);
  const siteName = new Map((sites ?? []).map((s) => [s.id, s.name]));
  const defaultSite = sites?.find((s) => s.is_default)?.id ?? "";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Devices</h1>
        <p className="text-sm text-muted-foreground">
          Each station tablet is registered once, then paired by scanning its QR code. Paired
          tablets stay signed in as the device; operators identify with their PIN.
        </p>
        <ActionForm action={createDevice} actionId={randomUUID()} submitLabel="Add device">
          <Label>
            Name
            <Input name="name" required maxLength={80} placeholder="Intake 1" />
          </Label>
          <Label>
            Station
            <Select name="station" defaultValue="intake">
              {Constants.public.Enums.device_station.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Label>
          <Label>
            Site
            <Select name="site_id" defaultValue={defaultSite}>
              <option value="">—</option>
              {(sites ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Label>
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className="py-2">Name</th>
            <th>Station</th>
            <th>Site</th>
            <th>Paired</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(devices ?? []).map((d) => (
            <tr key={d.id} className="border-b border-border align-top">
              <td className="py-3 font-medium">{d.name}</td>
              <td className="py-3">{d.station}</td>
              <td className="py-3">{d.site_id ? siteName.get(d.site_id) : "—"}</td>
              <td className="py-3">
                {d.paired_at ? new Date(d.paired_at).toLocaleString() : "not yet"}
              </td>
              <td className="py-3">{lastSeen(d.last_seen_at)}</td>
              <td className="py-3">
                {d.is_active ? <PairButton deviceId={d.id} paired={!!d.paired_at} /> : "inactive"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
