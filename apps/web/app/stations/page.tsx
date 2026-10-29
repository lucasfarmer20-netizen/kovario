import Link from "next/link";
import type { ReactNode } from "react";
import { Constants } from "db";
import { requireStaff } from "@/lib/auth";
import { type StationKind, STATION_ROUTES } from "@/lib/station-routes";

const tile =
  "flex min-h-28 min-w-14 flex-col justify-center gap-2 rounded-xl border border-border bg-card p-6 text-xl font-semibold hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring";
const grid = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

function StationTile({ kind, children }: { kind: StationKind; children: ReactNode }) {
  const primary = (
    <Link href={STATION_ROUTES[kind].href} className={tile}>
      {children}
    </Link>
  );
  if (kind !== "storage") return primary;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-2">
      {primary}
      <Link
        href="/storage/queue"
        className="inline-flex min-h-14 min-w-14 items-center justify-center rounded-lg border border-border bg-secondary px-4 text-lg font-semibold hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        Storage queue
      </Link>
    </div>
  );
}

export default async function StationsPage() {
  const { supabase, claims } = await requireStaff();
  const [{ data: devices, error: deviceError }, { data: sites, error: siteError }] =
    await Promise.all([
      supabase
        .from("device")
        .select("id, name, station, site_id")
        .eq("is_active", true)
        .order("name"),
      supabase.from("site").select("id, name").order("name"),
    ]);
  const groups = [
    ...(sites ?? []).map((site) => ({
      ...site,
      devices: (devices ?? []).filter((device) => device.site_id === site.id),
    })),
    {
      id: "no-site",
      name: "No site",
      devices: (devices ?? []).filter(
        (device) => !device.site_id || !(sites ?? []).some((site) => site.id === device.site_id),
      ),
    },
  ].filter((group) => group.devices.length > 0);

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-8 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Stations</h1>
        <Link href="/admin" className="flex min-h-14 min-w-14 items-center px-4 underline">
          Admin
        </Link>
      </header>
      {!claims ? (
        <p>
          Your account is not a member of an active organisation. Ask a manager to invite you, or{" "}
          <Link href="/onboarding" className="underline">
            set up a new plant
          </Link>
          .
        </p>
      ) : null}
      {deviceError || siteError ? (
        <p role="alert">
          Configured stations could not be loaded. Try refreshing, or use All stations below.
        </p>
      ) : null}
      {groups.map((group) => (
        <section key={group.id} aria-label={group.name} className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">{group.name}</h2>
          <div className={grid}>
            {group.devices.map((device) => (
              <StationTile key={device.id} kind={device.station}>
                <span>{device.name}</span>
                <span className="text-base font-normal text-muted-foreground">
                  {STATION_ROUTES[device.station].label}
                </span>
              </StationTile>
            ))}
          </div>
        </section>
      ))}
      <section aria-label="All stations" className="flex flex-col gap-4">
        <h2 className="text-2xl font-semibold">All stations</h2>
        <p>
          Create devices in{" "}
          <Link href="/admin/devices" className="inline-flex min-h-14 items-center underline">
            Admin → Devices
          </Link>{" "}
          to get per-site station tiles.
        </p>
        <div className={grid}>
          {Constants.public.Enums.device_station.map((kind) => (
            <StationTile key={kind} kind={kind}>
              {STATION_ROUTES[kind].label}
            </StationTile>
          ))}
        </div>
      </section>
    </main>
  );
}
