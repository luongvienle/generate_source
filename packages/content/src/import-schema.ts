import { z } from 'zod';
import { errorCodes, type ErrorCode } from '@knowledge-explorer/shared';
import { canSlugify } from './slug';

/**
 * The §9.1 curriculum import payload.
 *
 * FR-IMP-01 requires a strict schema: an unknown key is an error, never ignored,
 * so a typo in a pasted template is caught rather than silently dropped.
 *
 * docs/import-schema.json is GENERATED from this module and docs/owner-prompt-template.md
 * declares the same version; schema-parity.spec.ts fails if any of the three drift.
 */

/** Bumped whenever the payload shape changes. FR-IMP-03 versions the template alongside it. */
export const SCHEMA_VERSION = '1.0.0';

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words joined by single hyphens');

const titleSchema = z.string().min(1);
const orderSchema = z.int().positive();
const stringListSchema = z.array(z.string().min(1)).default([]);

export const importCategorySchema = z.strictObject({
  slug: slugSchema,
  displayName: titleSchema,
});

export const importLessonSchema = z.strictObject({
  lessonOrder: orderSchema,
  title: titleSchema,
  learningObjective: z.string().min(1).optional(),
  keyPoints: stringListSchema,
  estimatedMinutes: orderSchema.optional(),
});

export const importChapterSchema = z.strictObject({
  chapterOrder: orderSchema,
  title: titleSchema,
  description: z.string().min(1).optional(),
  lessons: z.array(importLessonSchema).min(1),
});

export const importCourseSchema = z.strictObject({
  levelLabel: titleSchema,
  levelOrder: orderSchema,
  title: titleSchema,
  overviewSummary: z.string().min(1).optional(),
  prerequisites: stringListSchema,
  learningObjectives: stringListSchema,
  estimatedTotalMinutes: orderSchema.optional(),
  // §8 defaults courses.language_code to 'vi'.
  languageCode: z.string().min(2).default('vi'),
});

export const importPayloadSchema = z.strictObject({
  schemaVersion: z.string().min(1),
  category: importCategorySchema,
  course: importCourseSchema,
  chapters: z.array(importChapterSchema).min(1),
});

export type ImportPayload = z.infer<typeof importPayloadSchema>;
export type ImportChapter = z.infer<typeof importChapterSchema>;
export type ImportLesson = z.infer<typeof importLessonSchema>;

export interface ValidationIssue {
  /** Dotted-and-bracketed path, e.g. chapters[0].lessons[2].title. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly payload: ImportPayload }
  | { readonly ok: false; readonly errorCode: ErrorCode; readonly issues: readonly ValidationIssue[] };

function toJsonPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out === '' ? '(root)' : out;
}

/**
 * Rules the shape alone cannot express, all collected in one pass so the owner
 * sees every semantic error at once (FR-IMP-01), not one per round trip:
 *
 * - ordering uniqueness, which §8 enforces with idx_chapters_order and
 *   idx_lessons_order — caught here so the owner gets a JSON path rather than a
 *   constraint violation surfacing from the worker;
 * - that levelLabel yields a slug, since courses.slug is NOT NULL UNIQUE and is
 *   derived from it.
 */
function checkSemantics(payload: ImportPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!canSlugify(payload.course.levelLabel)) {
    issues.push({
      path: 'course.levelLabel',
      message:
        `"${payload.course.levelLabel}" contains no letters or digits that survive ` +
        'slugification, and the course URL is derived from it. Use a label with ' +
        'Latin letters or digits, such as "N5".',
    });
  }

  const seenChapterOrders = new Map<number, number>();
  payload.chapters.forEach((chapter, index) => {
    const first = seenChapterOrders.get(chapter.chapterOrder);
    if (first === undefined) {
      seenChapterOrders.set(chapter.chapterOrder, index);
      return;
    }
    issues.push({
      path: `chapters[${index}].chapterOrder`,
      message: `duplicate chapterOrder ${chapter.chapterOrder}; already used by chapters[${first}]`,
    });
  });

  payload.chapters.forEach((chapter, chapterIndex) => {
    const seenLessonOrders = new Map<number, number>();
    chapter.lessons.forEach((lesson, lessonIndex) => {
      const first = seenLessonOrders.get(lesson.lessonOrder);
      if (first === undefined) {
        seenLessonOrders.set(lesson.lessonOrder, lessonIndex);
        return;
      }
      issues.push({
        path: `chapters[${chapterIndex}].lessons[${lessonIndex}].lessonOrder`,
        message: `duplicate lessonOrder ${lesson.lessonOrder} within this chapter; already used by lessons[${first}]`,
      });
    });
  });

  return issues;
}

/**
 * One ValidationIssue per zod issue, except for a strict-object violation:
 * zod reports every unrecognized key of one object as a single issue with an
 * empty path, which would surface to the owner as "(root)". FR-IMP-01 wants a
 * JSON path per error, so each offending key is expanded into its own issue.
 */
function toIssues(issue: z.core.$ZodIssue): ValidationIssue[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: toJsonPath([...issue.path, key]),
      message: `unrecognized key "${key}"; §9.1 defines no such member`,
    }));
  }
  return [{ path: toJsonPath(issue.path), message: issue.message }];
}

function describeVersion(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'no schemaVersion';
  return JSON.stringify(value) ?? String(value);
}

/**
 * Validates a payload against §9.1, reporting EVERY error with its JSON path
 * (FR-IMP-01) rather than stopping at the first.
 *
 * The version gate runs before field validation on purpose: an owner who pasted
 * a stale template gets one sentence naming both versions instead of a list of
 * field errors that does not name the real cause (FR-IMP-03).
 */
export function validateImportPayload(input: unknown): ValidationResult {
  const declared = (input as { schemaVersion?: unknown } | null | undefined)?.schemaVersion;
  if (declared !== SCHEMA_VERSION) {
    return {
      ok: false,
      errorCode: errorCodes.IMPORT_SCHEMA_VERSION_MISMATCH,
      issues: [
        {
          path: 'schemaVersion',
          message:
            `payload declares ${describeVersion(declared)}, but this server accepts ` +
            `"${SCHEMA_VERSION}". Download the current prompt template and regenerate.`,
        },
      ],
    };
  }

  const parsed = importPayloadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: errorCodes.IMPORT_PAYLOAD_INVALID,
      issues: parsed.error.issues.flatMap(toIssues),
    };
  }

  const semantic = checkSemantics(parsed.data);
  if (semantic.length > 0) {
    return { ok: false, errorCode: errorCodes.IMPORT_PAYLOAD_INVALID, issues: semantic };
  }

  return { ok: true, payload: parsed.data };
}

/** The JSON Schema served by GET /api/admin/import-schema and committed to docs/. */
export function buildJsonSchema(): unknown {
  return z.toJSONSchema(importPayloadSchema, { io: 'input' });
}
