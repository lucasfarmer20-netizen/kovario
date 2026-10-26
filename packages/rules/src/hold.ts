// Cooler hold (docs/04-BUSINESS-RULES.md §3): hold_until = intake_at + hold_hours. A
// guideline only — never a gate; the wave screen sorts `holding` intakes oldest first with
// an hours-in-cooler badge.

/** `org.settings.hold_hours` default. */
export const DEFAULT_HOLD_HOURS = 48;

const MS_PER_HOUR = 3_600_000;

function assertDate(name: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
}

export function holdUntil(intakeAt: Date, holdHours: number = DEFAULT_HOLD_HOURS): Date {
  assertDate("intakeAt", intakeAt);
  if (!Number.isFinite(holdHours) || holdHours < 0) {
    throw new RangeError("holdHours must be finite and >= 0");
  }
  return new Date(intakeAt.getTime() + holdHours * MS_PER_HOUR);
}

/** Whole hours since intake for the badge (0 if `now` is before `intakeAt`). */
export function hoursInCooler(intakeAt: Date, now: Date): number {
  assertDate("intakeAt", intakeAt);
  assertDate("now", now);
  return Math.max(0, Math.floor((now.getTime() - intakeAt.getTime()) / MS_PER_HOUR));
}

/** Comparator for the wave list: oldest intake first. */
export function oldestInCoolerFirst(a: { intakeAt: Date }, b: { intakeAt: Date }): number {
  return a.intakeAt.getTime() - b.intakeAt.getTime();
}
