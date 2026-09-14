/**
 * Day boundaries in Asia/Ho_Chi_Minh, for the dates an owner picks: a manual
 * grant's `expiresOn`, a discount code's `startsOn` and `endsOn`
 * (specs/p8a-commerce/spec.md).
 *
 * A picked date means the whole of that day in Vietnam: it starts at
 * 00:00:00.000 and ends at 23:59:59.999, stored as a `timestamptz` instant.
 *
 * A FIXED +07:00 OFFSET, NOT A TIMEZONE DATABASE LOOKUP. Vietnam has used
 * UTC+07:00 with no daylight saving since 1975, so the offset is a constant and
 * `Intl` would add a runtime dependency on ICU data for no difference in result.
 * If that ever changes, this is the one file to change; calendar.spec.ts pins
 * both boundaries.
 */

const VIETNAM_OFFSET = '+07:00';
const VIETNAM_OFFSET_MILLISECONDS = 7 * 60 * 60 * 1000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real `YYYY-MM-DD` date — `2026-02-30` is refused, not rolled into March. */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const probe = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(probe.getTime()) &&
    probe.getUTCFullYear() === Number(year) &&
    probe.getUTCMonth() + 1 === Number(month) &&
    probe.getUTCDate() === Number(day)
  );
}

function assertCalendarDate(value: string): void {
  if (!isCalendarDate(value)) throw new RangeError(`not a YYYY-MM-DD calendar date: "${value}"`);
}

/** 00:00:00.000 on `date` in Asia/Ho_Chi_Minh. */
export function vietnamDayStart(date: string): Date {
  assertCalendarDate(date);
  return new Date(`${date}T00:00:00.000${VIETNAM_OFFSET}`);
}

/** 23:59:59.999 on `date` in Asia/Ho_Chi_Minh. */
export function vietnamDayEnd(date: string): Date {
  assertCalendarDate(date);
  return new Date(`${date}T23:59:59.999${VIETNAM_OFFSET}`);
}

/** Today's `YYYY-MM-DD` in Asia/Ho_Chi_Minh. */
export function vietnamToday(now: Date): string {
  return new Date(now.getTime() + VIETNAM_OFFSET_MILLISECONDS).toISOString().slice(0, 10);
}

/**
 * Whether `date` is a day that has already ended in Vietnam. Today is NOT before
 * today: a manual grant expiring at the end of today is allowed.
 */
export function isBeforeTodayInVietnam(date: string, now: Date): boolean {
  assertCalendarDate(date);
  // ISO calendar dates compare correctly as strings.
  return date < vietnamToday(now);
}
