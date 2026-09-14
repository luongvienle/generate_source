import { CHECKOUT_TERM_CAP_MULTIPLIER } from '@knowledge-explorer/shared';

/**
 * §7.4's renewal arithmetic, and the only place it is written.
 *
 * The checkout quote's preview, the term cap and the webhook's grant extension
 * all call these, so the rule the learner is shown and the rule the webhook
 * applies cannot drift apart.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * MILLISECONDS_PER_DAY);

/**
 * §7.4, verbatim in behaviour:
 *
 *   "Stacking rule — renewal adds to the remaining term, it never overwrites it:
 *      const baseDate = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
 *      const newExpiresAt = addDays(baseDate, product.accessDurationDays);
 *    Renewing two months early yields fourteen months. Writing
 *    `now + accessDurationDays` silently destroys paid time."
 *
 * `currentExpiresAt === null` means there is no dated term to extend — a first
 * purchase. It does NOT mean a perpetual grant: a perpetual row has nothing to
 * stack onto, and callers refuse checkout (or leave the row alone) before they
 * get here.
 */
export function stackExpiry(
  currentExpiresAt: Date | null,
  now: Date,
  accessDurationDays: number,
): Date {
  const baseDate = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
  return addDays(baseDate, accessDurationDays);
}

/**
 * Whether stacking one more term would bank more than
 * `CHECKOUT_TERM_CAP_MULTIPLIER` terms ahead of today.
 *
 * Equivalent to `currentExpiresAt > now + accessDurationDays`: renewal opens
 * once one term or less remains. A first purchase (`null`) can never trip it.
 */
export function exceedsTermCap(
  currentExpiresAt: Date | null,
  now: Date,
  accessDurationDays: number,
): boolean {
  const ceiling = addDays(now, CHECKOUT_TERM_CAP_MULTIPLIER * accessDurationDays);
  return stackExpiry(currentExpiresAt, now, accessDurationDays) > ceiling;
}

/** The earliest moment a capped renewal becomes allowed, for the 409 and the confirm page. */
export function renewableFrom(currentExpiresAt: Date, accessDurationDays: number): Date {
  return addDays(currentExpiresAt, -accessDurationDays);
}
