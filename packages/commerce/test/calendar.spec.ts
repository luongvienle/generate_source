import { describe, expect, it } from 'vitest';
import {
  isBeforeTodayInVietnam,
  isCalendarDate,
  vietnamDayEnd,
  vietnamDayStart,
  vietnamToday,
} from '../src/calendar';

/**
 * Asia/Ho_Chi_Minh is UTC+07:00 with no daylight saving. These pin both day
 * boundaries so a change to the offset handling cannot shift a grant's expiry by
 * a day without failing here.
 */

describe('Vietnam day boundaries', () => {
  it('starts 2026-09-13 at 17:00 UTC the previous day', () => {
    expect(vietnamDayStart('2026-09-13').toISOString()).toBe('2026-09-12T17:00:00.000Z');
  });

  it('ends 2026-09-13 at 16:59:59.999 UTC the same day', () => {
    expect(vietnamDayEnd('2026-09-13').toISOString()).toBe('2026-09-13T16:59:59.999Z');
  });

  it('holds across a date that has DST elsewhere', () => {
    expect(vietnamDayEnd('2026-03-29').toISOString()).toBe('2026-03-29T16:59:59.999Z');
  });

  it.each(['2026-02-30', '2026-13-01', '13/09/2026', '2026-9-13', ''])(
    'refuses "%s"',
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
      expect(() => vietnamDayEnd(value)).toThrow(RangeError);
    },
  );

  it('accepts a leap day', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
  });
});

describe('today in Vietnam', () => {
  const lastMomentOfThe13th = new Date('2026-09-13T16:59:59.999Z');
  const firstMomentOfThe14th = new Date('2026-09-13T17:00:00.000Z');

  it('is still the 13th at 23:59 local', () => {
    expect(vietnamToday(lastMomentOfThe13th)).toBe('2026-09-13');
    expect(isBeforeTodayInVietnam('2026-09-13', lastMomentOfThe13th)).toBe(false);
    expect(isBeforeTodayInVietnam('2026-09-12', lastMomentOfThe13th)).toBe(true);
  });

  it('is the 14th at 00:00 local, while UTC still says the 13th', () => {
    expect(vietnamToday(firstMomentOfThe14th)).toBe('2026-09-14');
    expect(isBeforeTodayInVietnam('2026-09-13', firstMomentOfThe14th)).toBe(true);
    expect(isBeforeTodayInVietnam('2026-09-14', firstMomentOfThe14th)).toBe(false);
  });
});
