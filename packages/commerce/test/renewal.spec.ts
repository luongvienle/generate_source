import { describe, expect, it } from 'vitest';
import { exceedsTermCap, renewableFrom, stackExpiry } from '../src/renewal';

/**
 * §7.4's stacking rule. Pure: no database, no clock but the one passed in.
 *
 * §7.4 asks for this file by name: "This requires a dedicated unit test for the
 * early-renewal case."
 */

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-13T12:00:00.000Z');
const daysFromNow = (days: number) => new Date(now.getTime() + days * DAY);

describe('§7.4 stackExpiry', () => {
  it('renewing two months early adds a full term to the remaining time — fourteen months, not twelve', () => {
    const currentExpiresAt = daysFromNow(60);

    const renewed = stackExpiry(currentExpiresAt, now, 365);

    expect(renewed).toEqual(daysFromNow(425));
    // The bug §7.4 names: overwriting with now + accessDurationDays destroys the
    // 60 days the learner already paid for.
    expect(renewed).not.toEqual(daysFromNow(365));
  });

  it('stacks an expired grant from now, not from its old expiry', () => {
    expect(stackExpiry(daysFromNow(-10), now, 365)).toEqual(daysFromNow(365));
  });

  it('starts a first purchase from now', () => {
    expect(stackExpiry(null, now, 365)).toEqual(daysFromNow(365));
  });

  it('treats an expiry of exactly now as elapsed', () => {
    expect(stackExpiry(new Date(now), now, 30)).toEqual(daysFromNow(30));
  });

  it('does not mutate the dates it is given', () => {
    const currentExpiresAt = daysFromNow(60);
    const before = currentExpiresAt.getTime();
    stackExpiry(currentExpiresAt, now, 365);
    expect(currentExpiresAt.getTime()).toBe(before);
  });
});

describe('exceedsTermCap', () => {
  it('allows a renewal that lands exactly on now + 2 × duration', () => {
    expect(exceedsTermCap(daysFromNow(365), now, 365)).toBe(false);
  });

  it('refuses one millisecond past it', () => {
    expect(exceedsTermCap(new Date(daysFromNow(365).getTime() + 1), now, 365)).toBe(true);
  });

  it("passes §7.4's own example, renewing two months early", () => {
    expect(exceedsTermCap(daysFromNow(60), now, 365)).toBe(false);
  });

  it('never trips on a first purchase or a lapsed grant', () => {
    expect(exceedsTermCap(null, now, 365)).toBe(false);
    expect(exceedsTermCap(daysFromNow(-400), now, 365)).toBe(false);
  });
});

describe('renewableFrom', () => {
  it('is one term before the current expiry', () => {
    expect(renewableFrom(daysFromNow(425), 365)).toEqual(daysFromNow(60));
  });

  it('is exactly the point at which the cap stops refusing', () => {
    const currentExpiresAt = daysFromNow(425);
    const opensAt = renewableFrom(currentExpiresAt, 365);
    expect(exceedsTermCap(currentExpiresAt, opensAt, 365)).toBe(false);
    expect(exceedsTermCap(currentExpiresAt, new Date(opensAt.getTime() - 1), 365)).toBe(true);
  });
});
