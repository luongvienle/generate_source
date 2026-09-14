/**
 * P8a's commerce vocabulary (specs/p8a-commerce/spec.md), shared by apps/api and
 * both web apps so a screen branches on exactly the string the API sends.
 *
 * WARNING CODES ARE NOT ERROR CODES. A product save or a checkout quote carries
 * them and still succeeds; FR-COM-01 and FR-COM-02 both say "warns, without
 * blocking". Refusals live in errors.ts.
 */
export const commerceWarningCodes = {
  /** FR-COM-01: a bundle's price is not below the sum of its courses' single prices. */
  BUNDLE_PRICE_NOT_BELOW_SUM: 'BUNDLE_PRICE_NOT_BELOW_SUM',
  /**
   * A save left one or more published, paid courses with no active product
   * covering them — neither a single product nor their category's bundle — so
   * the course page shows "not for sale".
   */
  COURSE_NOT_FOR_SALE: 'COURSE_NOT_FOR_SALE',
  /**
   * FR-COM-02: the learner is buying a bundle that includes a course they already
   * hold an active grant for. "No refund of the overlap in v1" (§13).
   */
  BUNDLE_OVERLAPS_OWNED_COURSES: 'BUNDLE_OVERLAPS_OWNED_COURSES',
  /** The reverse of FR-COM-02: buying a single course an active bundle already covers. */
  COURSE_COVERED_BY_BUNDLE: 'COURSE_COVERED_BY_BUNDLE',
} as const;

export type CommerceWarningCode = (typeof commerceWarningCodes)[keyof typeof commerceWarningCodes];

/**
 * P8a sells in VND only. §8 defaults `currency_code` to 'VND' and names no other
 * currency; VND has no minor unit, so every amount is a whole number.
 */
export const SUPPORTED_CURRENCY_CODE = 'VND';

/**
 * Whole VND as a string of digits, at most `Decimal(12,2)`'s ten integer digits.
 * Money crosses the wire as a string, never as a JavaScript number.
 */
export const VND_AMOUNT_PATTERN = /^\d{1,10}$/;

/** Discount codes are stored uppercase and matched case-insensitively. */
export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;

/**
 * Checkout refuses a renewal whose stacked expiry would exceed
 * `now + CHECKOUT_TERM_CAP_MULTIPLIER × accessDurationDays` — so renewal opens
 * once one term or less remains. §7.4's own example (renewing two months early on
 * 365 days, yielding fourteen months) passes.
 */
export const CHECKOUT_TERM_CAP_MULTIPLIER = 2;

/** Orders of any status one learner may create in a trailing hour; `CHECKOUT_HOURLY_CAP` overrides. */
export const DEFAULT_CHECKOUT_HOURLY_CAP = 5;
