import { DISCOUNT_CODE_PATTERN, VND_AMOUNT_PATTERN } from '@knowledge-explorer/shared';

/**
 * Discount-code arithmetic and normalization (specs/p8a-commerce/spec.md,
 * "Discount codes").
 */

const HUNDRED = BigInt(100);
const HALF = BigInt(50);

/**
 * `round_half_up(listPrice × (100 − percentOff) / 100)`, in whole VND.
 *
 * INTEGER ARITHMETIC, NEVER FLOATS. `Number` is exact only to 2^53 and
 * `0.67 * 150` is not 100.5 in IEEE 754; money that is off by one dong on some
 * inputs and not others is the defect this avoids. `Decimal(12,2)` holds at most
 * ten integer digits, which `BigInt` carries without loss.
 *
 * 100% yields `"0"`, and that order still goes through the provider and the
 * webhook: FR-COM-03 has no exception for free.
 */
export function applyPercentDiscount(listPriceAmount: string, percentOff: number): string {
  if (!VND_AMOUNT_PATTERN.test(listPriceAmount)) {
    throw new RangeError(`listPriceAmount must be whole VND digits, got "${listPriceAmount}"`);
  }
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
    throw new RangeError(`percentOff must be an integer from 1 to 100, got ${percentOff}`);
  }

  const payableHundredths = BigInt(listPriceAmount) * (HUNDRED - BigInt(percentOff));
  return ((payableHundredths + HALF) / HUNDRED).toString();
}

/** Codes are stored uppercase and matched case-insensitively: `welcome10` finds `WELCOME10`. */
export function normalizeDiscountCode(input: string): string {
  return input.trim().toUpperCase();
}

/** Whether a normalized code has the shape a stored code can have. */
export function isWellFormedDiscountCode(normalized: string): boolean {
  return DISCOUNT_CODE_PATTERN.test(normalized);
}
