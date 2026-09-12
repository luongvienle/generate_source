import { describe, expect, it } from 'vitest';
import {
  HOUSE_STYLE,
  IMAGE_PROMPT_VERSION,
  composeImagePrompt,
  promptVersionOf,
} from '../src/image-prompt';

/**
 * NFR-08: every prompt is versioned and the version is stored with the artifact.
 * `lesson_images` has no version column, so the composed string has to carry it.
 */
const input = {
  adminPromptText: 'Three hiragana characters being written stroke by stroke',
  lessonTitle: 'Writing あ, い and う',
  languageCode: 'ja',
};

describe('composeImagePrompt', () => {
  const composed = composeImagePrompt(input);

  it('passes the admin prompt through verbatim', () => {
    expect(composed).toContain(input.adminPromptText);
  });

  it('carries the lesson title and language code', () => {
    expect(composed).toContain('Writing あ, い and う');
    expect(composed).toContain('ja');
  });

  it('applies the house style', () => {
    expect(composed).toContain(HOUSE_STYLE);
  });

  it('asks for no text inside the image, which is why FR-IMG-02 exists', () => {
    expect(composed.toLowerCase()).toContain('render no text');
  });

  it('begins with the version, so a stored prompt identifies its own template', () => {
    expect(composed.startsWith(`[${IMAGE_PROMPT_VERSION}]`)).toBe(true);
    expect(promptVersionOf(composed)).toBe(IMAGE_PROMPT_VERSION);
  });

  it('is deterministic', () => {
    expect(composeImagePrompt(input)).toBe(composed);
  });

  it('reads back no version from a string that carries none', () => {
    expect(promptVersionOf('just a prompt')).toBeNull();
  });
});
