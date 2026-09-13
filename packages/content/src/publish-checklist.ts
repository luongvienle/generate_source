import { computeAudioStatus, computeScriptStatus } from './narration';

/**
 * FR-PUB-01, the publish checklist, as a PURE function over already-loaded rows.
 *
 * §5.7 lists seven conditions and then an eighth bullet about the response
 * shape — "the checklist endpoint returns each item with pass or fail and a
 * human-readable reason". That eighth bullet is this module's return type, not
 * an eighth condition, and nothing here adds a condition of its own.
 *
 * WHY IT LIVES IN packages/content AND TAKES PLAIN DATA. Two callers need the
 * identical verdict and cannot share code any other way: apps/api serves it on
 * GET, and apps/worker re-checks it before writing the published track, and the
 * two apps never import each other. Taking loaded rows rather than a database
 * client also means a whole course is evaluated from one batch of queries — the
 * per-lesson staleness services would be N+1 across forty lessons.
 *
 * THE INPUT IS ALREADY FILTERED. Soft-deleted chapters and lessons are excluded
 * by the loader, because §4.3 keeps them in the previous snapshot but out of the
 * next one; this module never sees a `deleted_at`.
 */

export interface ChecklistImage {
  readonly blockReferenceId: string;
  readonly isSelected: boolean;
  readonly captionText: string;
  readonly alternativeText: string;
}

export interface ChecklistLesson {
  readonly lessonId: string;
  readonly title: string;
  readonly contentStatus: string;
  readonly draftContentMarkdown: string | null;
  readonly draftContentChecksum: string | null;
  /** Figure blocks from the stored draft block list, in document order. */
  readonly figureBlocks: readonly { readonly blockId: string; readonly figureNumber: number | null }[];
  readonly images: readonly ChecklistImage[];
  readonly script: {
    readonly scriptStatus: string;
    readonly sourceContentChecksum: string;
    readonly scriptChecksum: string;
  } | null;
  readonly audio: {
    readonly audioStatus: string;
    readonly sourceScriptChecksum: string;
    readonly voiceIdentifier: string;
  } | null;
}

export interface ChecklistChapter {
  readonly chapterId: string;
  readonly title: string;
  readonly lessons: readonly ChecklistLesson[];
}

export interface ChecklistInput {
  readonly courseId: string;
  readonly categoryId: string | null;
  readonly coverImageUrl: string | null;
  readonly pricingType: string;
  /** FR-AUDIO-03's resolved voice, for the audio staleness link. */
  readonly configuredVoiceIdentifier: string;
  /** §5.7 item 7: active products referencing this course or its category. */
  readonly activeProductCount: number;
  readonly chapters: readonly ChecklistChapter[];
}

export const checklistItemIds = [
  'lesson_content_present',
  'no_empty_lesson',
  'figures_illustrated',
  'artifacts_fresh',
  'structure_minimums',
  'category_and_cover',
  'active_product_for_paid',
] as const;

export type ChecklistItemId = (typeof checklistItemIds)[number];

export interface ChecklistItem {
  readonly id: ChecklistItemId;
  /** §5.7's bullet, verbatim — this is how a reader checks the code against the spec. */
  readonly requirement: string;
  readonly passed: boolean;
  /** Human-readable, per §5.7's eighth bullet. */
  readonly reason: string;
  /**
   * The rows that made it fail, named.
   *
   * A checklist that says "some lesson is empty" for a forty-lesson course is a
   * worse tool than no checklist, so a failing item always says which.
   */
  readonly offenders: readonly string[];
}

export interface PublishChecklist {
  readonly courseId: string;
  readonly passed: boolean;
  readonly items: readonly ChecklistItem[];
}

/** Caps an offender list so one broken course cannot return a megabyte of names. */
const MAX_OFFENDERS = 25;

/**
 * "1 lesson has" / "2 lessons have".
 *
 * A reason is read by a person deciding what to fix next, so it has to be a
 * sentence rather than a template that says "1 artifact are stale".
 */
const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

function item(
  id: ChecklistItemId,
  requirement: string,
  offenders: readonly string[],
  pass: string,
  fail: (count: number) => string,
): ChecklistItem {
  const passed = offenders.length === 0;
  return {
    id,
    requirement,
    passed,
    reason: passed ? pass : fail(offenders.length),
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

const allLessons = (input: ChecklistInput): readonly ChecklistLesson[] =>
  input.chapters.flatMap((chapter) => chapter.lessons);

export function evaluatePublishChecklist(input: ChecklistInput): PublishChecklist {
  const lessons = allLessons(input);
  const items: ChecklistItem[] = [
    item(
      'lesson_content_present',
      'Every non-deleted lesson has non-empty draft content.',
      lessons
        .filter((lesson) => (lesson.draftContentMarkdown ?? '').trim() === '')
        .map((lesson) => lesson.title),
      'Every lesson has draft content.',
      (n) => `${plural(n, 'lesson')} still ${n === 1 ? 'has' : 'have'} no draft content.`,
    ),
    item(
      'no_empty_lesson',
      'No lesson is in contentStatus = empty.',
      lessons.filter((lesson) => lesson.contentStatus === 'empty').map((lesson) => lesson.title),
      'No lesson is still marked empty.',
      (n) => `${plural(n, 'lesson')} ${n === 1 ? 'is' : 'are'} still marked empty.`,
    ),
    item(
      'figures_illustrated',
      'Every figure block has a selected image with caption and alt text.',
      unillustratedFigures(lessons),
      'Every figure has a selected image with caption and alt text.',
      (n) =>
        `${plural(n, 'figure')} ${n === 1 ? 'has' : 'have'} no selected image, caption or alt text.`,
    ),
    item(
      'artifacts_fresh',
      'No narration script or audio is stale or failed.',
      staleOrFailedArtifacts(lessons, input.configuredVoiceIdentifier),
      'No narration script or audio is stale or failed.',
      (n) =>
        `${plural(n, 'artifact')} ${n === 1 ? 'is' : 'are'} stale or failed and must be regenerated.`,
    ),
    item(
      'structure_minimums',
      'The course has at least 3 chapters and every chapter has at least 2 lessons.',
      structureShortfalls(input),
      'The course has at least 3 chapters, each with at least 2 lessons.',
      () => structureShortfalls(input).join('; '),
    ),
    item(
      'category_and_cover',
      'The course has a category and a cover image.',
      [
        ...(input.categoryId === null ? ['category'] : []),
        ...((input.coverImageUrl ?? '').trim() === '' ? ['cover image'] : []),
      ],
      'The course has a category and a cover image.',
      () =>
        `Missing: ${[
          ...(input.categoryId === null ? ['category'] : []),
          ...((input.coverImageUrl ?? '').trim() === '' ? ['cover image'] : []),
        ].join(' and ')}.`,
    ),
    item(
      'active_product_for_paid',
      'If pricingType = paid, at least one active product references this course or its category.',
      input.pricingType === 'paid' && input.activeProductCount === 0 ? ['no active product'] : [],
      input.pricingType === 'paid'
        ? 'An active product references this course.'
        : 'The course is free, so no product is required.',
      () =>
        'This course is paid but no active product references it or its category. ' +
        'Create one before publishing.',
    ),
  ];

  return { courseId: input.courseId, passed: items.every((i) => i.passed), items };
}

/** A figure block with no selected image, or one missing its caption or alt text. */
function unillustratedFigures(lessons: readonly ChecklistLesson[]): readonly string[] {
  const offenders: string[] = [];
  for (const lesson of lessons) {
    for (const figure of lesson.figureBlocks) {
      const selected = lesson.images.find(
        (image) => image.blockReferenceId === figure.blockId && image.isSelected,
      );
      const label = `${lesson.title} — figure ${figure.figureNumber ?? '?'}`;
      if (!selected) {
        offenders.push(`${label}: no image selected`);
      } else if (selected.captionText.trim() === '') {
        offenders.push(`${label}: no caption`);
      } else if (selected.alternativeText.trim() === '') {
        offenders.push(`${label}: no alt text`);
      }
    }
  }
  return offenders;
}

/**
 * §6.5 staleness, computed — never read from `script_status` or `audio_status`.
 *
 * A lesson with NO script and NO audio passes. §5.7 says "no narration script or
 * audio is stale or failed", which is a statement about artifacts that exist;
 * requiring every lesson to have narration would be a requirement FR-PUB-01 does
 * not make, and P6 does not add one.
 */
function staleOrFailedArtifacts(
  lessons: readonly ChecklistLesson[],
  configuredVoiceIdentifier: string,
): readonly string[] {
  const offenders: string[] = [];
  for (const lesson of lessons) {
    const scriptStatus = computeScriptStatus(
      lesson.script?.scriptStatus ?? null,
      lesson.script?.sourceContentChecksum ?? null,
      lesson.draftContentChecksum,
    );
    if (scriptStatus === 'stale' || scriptStatus === 'failed') {
      offenders.push(`${lesson.title}: narration script is ${scriptStatus}`);
    }

    if (lesson.audio) {
      const audioStatus = computeAudioStatus(
        lesson.audio,
        lesson.script?.scriptChecksum ?? null,
        configuredVoiceIdentifier,
      );
      if (audioStatus === 'stale' || audioStatus === 'failed') {
        offenders.push(`${lesson.title}: audio is ${audioStatus}`);
      }
    }
  }
  return offenders;
}

function structureShortfalls(input: ChecklistInput): readonly string[] {
  const shortfalls: string[] = [];
  if (input.chapters.length < 3) {
    shortfalls.push(`the course has ${input.chapters.length} of the 3 chapters required`);
  }
  for (const chapter of input.chapters) {
    if (chapter.lessons.length < 2) {
      shortfalls.push(`"${chapter.title}" has ${chapter.lessons.length} of the 2 lessons required`);
    }
  }
  return shortfalls;
}
