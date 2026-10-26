/** Round half away from zero to `dp` decimals, absorbing binary float noise (0.6 × 0.85). */
export function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return (Math.sign(value) * Math.round(Math.abs(value) * f * (1 + Number.EPSILON))) / f;
}

export function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
