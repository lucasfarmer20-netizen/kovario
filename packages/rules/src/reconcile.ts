export function variancePercent(actual: number, expected: number): number | null {
  return expected > 0 ? Math.round(((actual - expected) / expected) * 10000) / 100 : null;
}
export type ReconcileVessel = { weightLb: number; isExchange: boolean; assetTagId: string | null };
export type SendToBlastBlocker = "no_vessels" | "non_positive_weight" | "missing_tag";
/** Occupancy filtering belongs to the caller; exchange vessels still need weight. */
export function sendToBlastBlockers(vessels: readonly ReconcileVessel[]): SendToBlastBlocker[] {
  if (vessels.length === 0) return ["no_vessels"];
  const blockers: SendToBlastBlocker[] = [];
  if (vessels.some((v) => !Number.isFinite(v.weightLb) || v.weightLb <= 0))
    blockers.push("non_positive_weight");
  if (vessels.some((v) => !v.isExchange && !v.assetTagId)) blockers.push("missing_tag");
  return blockers;
}
