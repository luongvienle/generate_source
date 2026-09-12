import { describe, expect, it } from 'vitest';
import { canSlugify, deriveCourseSlug, slugify } from '../src/slug';

describe('deriveCourseSlug', () => {
  it('derives the §9.1 example', () => {
    expect(deriveCourseSlug('japanese', 'N5')).toBe('japanese-n5');
  });

  it('is stable across repeated calls', () => {
    const once = deriveCourseSlug('japanese', 'N5');
    expect(deriveCourseSlug('japanese', 'N5')).toBe(once);
    expect(deriveCourseSlug('japanese', 'N5')).toBe(once);
  });

  it('takes no course title, so renaming a course never moves its URL', () => {
    // The signature is the guard: two arguments, neither of them the title.
    expect(deriveCourseSlug.length).toBe(2);
  });

  it('normalises case and surrounding whitespace in levelLabel', () => {
    for (const label of ['N5', 'n5', ' N5 ', '\tN5\n']) {
      expect(deriveCourseSlug('japanese', label)).toBe('japanese-n5');
    }
  });

  it('collapses internal punctuation to one hyphen, keeping separated labels distinct', () => {
    // "N 5" is not the same level label as "N5"; folding them together would
    // collide two courses onto one slug, which is worse than two similar slugs.
    for (const label of ['N-5', 'N 5', 'N.5', 'N__5']) {
      expect(deriveCourseSlug('japanese', label)).toBe('japanese-n-5');
    }
    expect(deriveCourseSlug('japanese', 'N5')).not.toBe(deriveCourseSlug('japanese', 'N 5'));
  });

  it('folds diacritics, including Vietnamese đ which NFKD leaves alone', () => {
    expect(deriveCourseSlug('tieng-viet', 'Sơ cấp')).toBe('tieng-viet-so-cap');
    expect(slugify('Đường')).toBe('duong');
  });

  it('refuses a component that yields no slug rather than emitting a dangling hyphen', () => {
    expect(() => deriveCourseSlug('japanese', '初級')).toThrow(/levelLabel/);
    expect(() => deriveCourseSlug('', 'N5')).toThrow(/categorySlug/);
  });
});

describe('slugify', () => {
  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  Data   Science!!  ')).toBe('data-science');
    expect(slugify('---a---b---')).toBe('a-b');
  });

  it('reports whether a value is usable, so callers can validate before deriving', () => {
    expect(canSlugify('N5')).toBe(true);
    expect(canSlugify('初級')).toBe(false);
    expect(canSlugify('   ')).toBe(false);
  });
});
