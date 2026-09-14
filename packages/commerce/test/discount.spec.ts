import { describe, expect, it } from 'vitest';
import {
  applyPercentDiscount,
  isWellFormedDiscountCode,
  normalizeDiscountCode,
} from '../src/discount';

describe('applyPercentDiscount', () => {
  it.each([
    ['200000', 10, '180000'],
    ['200000', 1, '198000'],
    ['200000', 100, '0'],
    // 150 × 67 / 100 = 100.5 → half up → 101. A float would say 100.49999…
    ['150', 33, '101'],
    // 1 × 50 / 100 = 0.5 → 1.
    ['1', 50, '1'],
    // 99999 × 67 / 100 = 66999.33 → 66999.
    ['99999', 33, '66999'],
    ['0', 50, '0'],
    // Decimal(12,2)'s largest whole amount survives without loss.
    ['9999999999', 1, '9899999999'],
  ])('%s VND at %i%% is %s VND', (list, percent, expected) => {
    expect(applyPercentDiscount(list, percent)).toBe(expected);
  });

  it.each(['1500.50', '-1', '', '12345678901', '1e5'])('refuses a list price of "%s"', (list) => {
    expect(() => applyPercentDiscount(list, 10)).toThrow(RangeError);
  });

  it.each([0, 101, 10.5, Number.NaN])('refuses %s percent', (percent) => {
    expect(() => applyPercentDiscount('1000', percent)).toThrow(RangeError);
  });
});

describe('normalizeDiscountCode', () => {
  it('trims and uppercases, so welcome10 finds WELCOME10', () => {
    expect(normalizeDiscountCode('  welcome10 ')).toBe('WELCOME10');
  });

  it.each([
    ['WELCOME10', true],
    ['SUMMER-2026', true],
    ['AB', false],
    ['A'.repeat(33), false],
    ['HELLO WORLD', false],
    ['GIẢM10', false],
  ])('%s is well formed: %s', (code, expected) => {
    expect(isWellFormedDiscountCode(normalizeDiscountCode(code))).toBe(expected);
  });
});
