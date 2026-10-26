"use client";

import { kovarioClaims, type KovarioClaims } from "db";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { getDeviceClient } from "@/lib/supabase/device";

// Paired-device landing screen: proves the device session, heartbeat, operator PIN and
// manager PIN elevation end to end. WP-05 replaces it with the station shell.

type DeviceInfo = { name: string; station: string };
type Identify = {
  ok: boolean;
  reason?: string;
  member?: { id: string; display_name: string; role: string };
};
type Elevation = {
  ok: boolean;
  reason?: string;
  expires_at?: string;
  manager?: { display_name: string };
};

const HEARTBEAT_MS = 60_000;

const pinInput =
  "h-16 w-48 rounded-md border-2 border-input px-4 text-center font-mono text-3xl tracking-widest";
const bigButton = "h-16 min-w-40 rounded-md px-6 text-xl font-semibold disabled:opacity-50";

export function DeviceHome() {
  const [claims, setClaims] = useState<KovarioClaims | null | undefined>(undefined);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [operator, setOperator] = useState<string | null>(null);
  const [elevation, setElevation] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const client = getDeviceClient();
    let timer: ReturnType<typeof setInterval> | undefined;
    void client.auth.getClaims().then(async ({ data }) => {
      const parsed = kovarioClaims(data?.claims);
      const station = parsed?.appRole === "station" && parsed.deviceId ? parsed : null;
      setClaims(station);
      if (!station?.deviceId) return;
      const { data: row } = await client
        .from("device")
        .select("name, station")
        .eq("id", station.deviceId)
        .single();
      setDevice(row);
      await client.rpc("device_heartbeat");
      timer = setInterval(() => void client.rpc("device_heartbeat"), HEARTBEAT_MS);
    });
    return () => clearInterval(timer);
  }, []);

  async function identify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const pin = String(new FormData(form).get("pin") ?? "");
    form.reset();
    const { data, error } = await getDeviceClient().rpc("operator_identify", { p_pin: pin });
    const result = data as Identify | null;
    if (error || !result?.ok || !result.member) {
      setMessage(
        result?.reason === "locked"
          ? "Too many tries — wait a few minutes."
          : "PIN not recognised.",
      );
      return;
    }
    setOperator(`${result.member.display_name} (${result.member.role})`);
    setMessage(null);
  }

  async function elevate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const pin = String(new FormData(form).get("pin") ?? "");
    form.reset();
    const { data } = await getDeviceClient().functions.invoke<Elevation>("elevate", {
      body: { pin },
    });
    if (!data?.ok) {
      setMessage("Manager PIN not accepted.");
      return;
    }
    const until = data.expires_at ? new Date(data.expires_at).toLocaleTimeString() : "";
    setElevation(`Approved by ${data.manager?.display_name ?? "manager"} until ${until}`);
    setMessage(null);
  }

  async function unpair() {
    await getDeviceClient().auth.signOut({ scope: "local" });
    setClaims(null);
  }

  if (claims === undefined) return <p className="text-xl">Loading…</p>;
  if (claims === null) {
    return (
      <div className="flex flex-col items-center gap-4 text-xl">
        <p>This tablet is not paired.</p>
        <Link
          href="/pair"
          className={`${bigButton} flex items-center bg-primary text-primary-foreground`}
        >
          Pair this tablet
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-8 text-lg">
      <section>
        <h1 className="text-3xl font-semibold">{device?.name ?? "Station"}</h1>
        <p className="text-muted-foreground">Station: {device?.station ?? "…"} · paired</p>
      </section>

      <form onSubmit={identify} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-2 font-medium">
          Operator PIN
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            className={pinInput}
          />
        </label>
        <button type="submit" className={`${bigButton} bg-primary text-primary-foreground`}>
          Sign in operator
        </button>
      </form>
      <p className="text-2xl">Operator: {operator ?? "—"}</p>

      <form onSubmit={elevate} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-2 font-medium">
          Manager PIN
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            className={pinInput}
          />
        </label>
        <button type="submit" className={`${bigButton} border-2 border-border`}>
          Manager approve
        </button>
      </form>
      <p className="text-2xl">Manager: {elevation ?? "—"}</p>

      {message ? (
        <p role="alert" className="text-2xl text-destructive">
          {message}
        </p>
      ) : null}

      <button
        type="button"
        onClick={unpair}
        className={`${bigButton} self-start border-2 border-border`}
      >
        Unpair this tablet
      </button>
    </div>
  );
}
