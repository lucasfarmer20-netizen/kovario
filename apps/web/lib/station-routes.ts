import type { Database } from "db";

export type StationKind = Database["public"]["Enums"]["device_station"];

export const STATION_ROUTES = {
  intake: { href: "/intake", label: "Intake" },
  storage: { href: "/storage", label: "Cold storage" },
  wave: { href: "/wave", label: "Wave" },
  rollstock: { href: "/rollstock", label: "Rollstock" },
  reconcile: { href: "/reconcile", label: "Reconcile" },
  blast: { href: "/freezer/blast", label: "Blast freezer" },
  locate: { href: "/freezer/locate", label: "Holding freezer locate" },
  allocate: { href: "/allocate", label: "Counter allocation" },
  boxing: { href: "/boxing", label: "Boxing / will-call" },
  register: { href: "/register", label: "Register" },
  shipping: { href: "/shipping", label: "Shipping" },
} satisfies Record<StationKind, { href: string; label: string }>;
