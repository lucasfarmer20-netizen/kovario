export function variancePercent(actual: number, expected: number): number | null {
  return expected > 0 ? Math.round(((actual - expected) / expected) * 10000) / 100 : null;
}
