/** FIFO prefix nearest the target band; advisory, never a processing gate. */
export function suggestWave<T extends { id: string; intake_at: string; total_incoming_lb: number }>(
  queue: readonly T[],
  target = 4000,
  tolerance = 250,
): T[] {
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(tolerance) || tolerance < 0)
    throw new RangeError("Invalid wave target or tolerance");
  const ordered = [...queue].sort(
    (a, b) => Date.parse(a.intake_at) - Date.parse(b.intake_at) || a.id.localeCompare(b.id),
  );
  const selected: T[] = [];
  let total = 0;
  for (const item of ordered) {
    if (total >= target - tolerance) break;
    const next = total + item.total_incoming_lb;
    if (
      selected.length &&
      next > target + tolerance &&
      Math.abs(total - target) <= Math.abs(next - target)
    )
      break;
    selected.push(item);
    total = next;
  }
  return selected;
}
