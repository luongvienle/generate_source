/**
 * The versioned image prompt (NFR-08).
 *
 * `lesson_images` has an `image_prompt_text` column and no version column, and
 * P3 adds no migration. So the COMPOSED string is what gets stored, and it
 * carries the version at its head: a stored row identifies the template that
 * produced it from its own content, with nothing to join against.
 *
 * Changing the wording below REQUIRES incrementing the version. Existing rows
 * are never rewritten.
 */
export const IMAGE_PROMPT_VERSION = 'image/v1';

/**
 * The house illustration style.
 *
 * specs/p3-images/spec.md leaves this open: no one has chosen a visual
 * direction, and the spec declined to invent one. This is a deliberately
 * neutral default so implementation could proceed. Revising it is a one-line
 * change plus a version bump — nothing downstream depends on the wording.
 */
export const HOUSE_STYLE =
  'Clean, flat vector illustration with simple shapes, generous whitespace and a ' +
  'restrained palette. Instructional rather than decorative.';

/**
 * §5.4 exists because models are unreliable at text inside images — that is the
 * stated reason FR-IMG-02's manual upload is mandatory. So the template does not
 * ask for any.
 */
export const NO_TEXT_INSTRUCTION =
  'Render no text, letters, numerals, labels or captions inside the image. The ' +
  'caption is supplied separately by the author.';

export interface ImagePromptInput {
  /** What the admin typed. Passed through verbatim. */
  readonly adminPromptText: string;
  readonly lessonTitle: string;
  /** The course languageCode, so the subject matter is understood in context. */
  readonly languageCode: string;
}

export function composeImagePrompt(input: ImagePromptInput): string {
  return [
    `[${IMAGE_PROMPT_VERSION}]`,
    `Lesson: ${input.lessonTitle} (language: ${input.languageCode})`,
    `Subject: ${input.adminPromptText}`,
    `Style: ${HOUSE_STYLE}`,
    NO_TEXT_INSTRUCTION,
  ].join('\n');
}

/** Recovers the template version from a stored prompt, for NFR-08 auditing. */
export function promptVersionOf(composedPrompt: string): string | null {
  return /^\[([^\]]+)\]/u.exec(composedPrompt)?.[1] ?? null;
}
