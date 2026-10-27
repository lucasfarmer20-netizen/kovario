// Parcels and addresses: the shipping-side rules the route handlers and the /shipping screen
// share (docs/07-INTEGRATIONS.md §4). Cold chain: a ship box's gross weight is its fish weight
// plus its box size's packaging and dry ice weight (`box_size.dims.packaging_lb`,
// `dims.dry_ice_lb`), so the carrier is never quoted the fish alone.
import type { Address, Parcel } from "./types.ts";

/** `box_size.dims` (inches, lb). Every key is optional in the catalogue. */
export type BoxSizeDims = {
  length_in?: number;
  width_in?: number;
  height_in?: number;
  packaging_lb?: number;
  dry_ice_lb?: number;
};

/** Blocker code when a parcel cannot be quoted (no box size dims, no weight). */
export const BLOCKER_PARCEL_INCOMPLETE = "parcel_incomplete";

const round2 = (n: number) => Math.round(n * 100) / 100;

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function nonNegative(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The parcel for one ship box: catalogue dims, gross weight = fish + packaging + dry ice.
 * Null when the box size has no full L×W×H or the box has no weight.
 */
export function boxParcel(box: { weight_lb: number; dims: BoxSizeDims | null }): Parcel | null {
  const d = box.dims ?? {};
  if (!positive(d.length_in) || !positive(d.width_in) || !positive(d.height_in)) return null;
  if (!positive(box.weight_lb)) return null;
  const dryIce = nonNegative(d.dry_ice_lb);
  return {
    length_in: d.length_in,
    width_in: d.width_in,
    height_in: d.height_in,
    weight_lb: round2(box.weight_lb + nonNegative(d.packaging_lb) + dryIce),
    dry_ice_lb: round2(dryIce),
  };
}

/** A walk-in parcel as entered at the shipping desk (gross weight, already packed). */
export function walkinParcel(p: {
  length_in: number;
  width_in: number;
  height_in: number;
  weight_lb: number;
  dry_ice_lb?: number;
}): Parcel | null {
  if (![p.length_in, p.width_in, p.height_in, p.weight_lb].every(positive)) return null;
  return {
    length_in: p.length_in,
    width_in: p.width_in,
    height_in: p.height_in,
    weight_lb: round2(p.weight_lb),
    dry_ice_lb: round2(nonNegative(p.dry_ice_lb)),
  };
}

export const ADDRESS_REQUIRED = ["name", "street1", "city", "state", "zip", "country"] as const;

/** Trimmed copy with empty optionals dropped and the country upper-cased (default US). */
export function cleanAddress(a: Partial<Address>): Address {
  const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: Address = {
    name: t(a.name),
    street1: t(a.street1),
    city: t(a.city),
    state: t(a.state).toUpperCase(),
    zip: t(a.zip),
    country: (t(a.country) || "US").toUpperCase(),
  };
  for (const k of ["company", "street2", "phone", "email"] as const) {
    if (t(a[k])) out[k] = t(a[k]);
  }
  return out;
}

/** Required fields that are blank. Empty = complete enough to send to the carrier. */
export function addressGaps(a: Partial<Address> | null | undefined): string[] {
  const clean = cleanAddress(a ?? {});
  return ADDRESS_REQUIRED.filter((k) => clean[k] === "");
}

/** One line for lists: "Pat Party, 12 Dock Rd, Kenai AK 99611". */
export function addressLine(a: Partial<Address> | null | undefined): string {
  if (!a) return "";
  const c = cleanAddress(a);
  const place = [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(" ");
  return [c.name, c.street1, c.street2, place].filter(Boolean).join(", ");
}
