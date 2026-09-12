/**
 * Course slug derivation.
 *
 * `courses.slug` is TEXT NOT NULL UNIQUE in §8, but §9.1's payload carries no
 * slug. specs/p1-curriculum/spec.md derives it from (categorySlug, levelLabel) —
 * exactly the pair FR-IMP-01 names as the idempotency key — so re-import always
 * resolves to the same course, global uniqueness follows from categories.slug
 * being unique, and renaming the course title never breaks a learner URL.
 */

/** Vietnamese đ/Đ does not decompose under NFKD; languageCode defaults to 'vi'. */
const NON_DECOMPOSING = new Map<string, string>([
  ['đ', 'd'],
  ['Đ', 'd'],
]);

export function slugify(value: string): string {
  let folded = '';
  for (const character of value) {
    folded += NON_DECOMPOSING.get(character) ?? character;
  }

  return folded
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Whether a value yields a usable slug component at all. */
export function canSlugify(value: string): boolean {
  return slugify(value).length > 0;
}

/**
 * Throws rather than writing a malformed value into a NOT NULL UNIQUE column.
 * Import validation calls canSlugify first, so an owner sees a JSON-path error
 * on course.levelLabel instead of this exception.
 */
export function deriveCourseSlug(categorySlug: string, levelLabel: string): string {
  const category = slugify(categorySlug);
  const level = slugify(levelLabel);

  if (category.length === 0) throw new Error(`categorySlug "${categorySlug}" yields no slug`);
  if (level.length === 0) throw new Error(`levelLabel "${levelLabel}" yields no slug`);

  return `${category}-${level}`;
}
