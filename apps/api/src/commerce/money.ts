/**
 * `Decimal(12,2)` amounts as integer hundredths, so sums and comparisons never
 * pass through a JavaScript number.
 *
 * Prisma hands back `Decimal` objects whose `toString()` is a plain decimal
 * string ("200000", "199000.5"); this is the bridge from that to exact integer
 * arithmetic. P8a writes whole VND only, but rows seeded by earlier suites are
 * not guaranteed to be whole, and a price-check that threw on them would be worse
 * than one that summed them exactly.
 */

const HUNDRED = BigInt(100);
const DECIMAL_12_2 = /^(\d+)(?:\.(\d{1,2}))?$/;

export function toHundredths(amount: { toString(): string } | string): bigint {
  const text = typeof amount === 'string' ? amount : amount.toString();
  const match = DECIMAL_12_2.exec(text);
  if (!match) throw new RangeError(`not a non-negative Decimal(12,2) amount: "${text}"`);
  return BigInt(match[1]!) * HUNDRED + BigInt((match[2] ?? '').padEnd(2, '0'));
}

export function fromHundredths(value: bigint): string {
  const whole = value / HUNDRED;
  const fraction = value % HUNDRED;
  return fraction === BigInt(0) ? whole.toString() : `${whole}.${fraction.toString().padStart(2, '0')}`;
}
