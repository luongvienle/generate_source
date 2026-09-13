import { describe, expect, it } from 'vitest';
import { publicationStatuses, type PublicationStatus } from '../src/enums';
import {
  allowedTransitionsFrom,
  canTransition,
  publicationTransitions,
  structurePayloadSchema,
} from '../src/publication';

/**
 * §4.2 as data. These assertions are the only thing keeping the table honest —
 * six endpoints read it and none of them restates an edge.
 */

describe('§4.2 transition table shape', () => {
  it('classifies every edge as diagram, addition or restore', () => {
    for (const transition of publicationTransitions) {
      expect(['diagram', 'addition', 'restore'], `${transition.from}→${transition.to}`).toContain(
        transition.kind,
      );
    }
  });

  it('gives every edge a reason', () => {
    for (const transition of publicationTransitions) {
      expect(transition.reason.length, `${transition.from}→${transition.to}`).toBeGreaterThan(0);
    }
  });

  it('declares no edge twice', () => {
    const keys = publicationTransitions.map((t) => `${t.from}→${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('mentions every §8.1 publication status somewhere', () => {
    const mentioned = new Set(publicationTransitions.flatMap((t) => [t.from, t.to]));
    for (const status of publicationStatuses) {
      expect(mentioned.has(status), status).toBe(true);
    }
  });

  it('carries §4.2 own five edges as `diagram`', () => {
    const diagram = publicationTransitions
      .filter((t) => t.kind === 'diagram')
      .map((t) => `${t.from}→${t.to}`);
    expect(diagram).toEqual([
      'draft→in_review',
      'in_review→publishing',
      'publishing→published',
      'published→unpublished',
      'unpublished→archived',
    ]);
  });
});

describe('canTransition', () => {
  it('allows every §4.2 diagram edge', () => {
    expect(canTransition('draft', 'in_review')).toBe(true);
    expect(canTransition('in_review', 'publishing')).toBe(true);
    expect(canTransition('publishing', 'published')).toBe(true);
    expect(canTransition('published', 'unpublished')).toBe(true);
    expect(canTransition('unpublished', 'archived')).toBe(true);
  });

  it('allows the four edges P6 adds deliberately', () => {
    expect(canTransition('in_review', 'draft')).toBe(true);
    expect(canTransition('draft', 'publishing')).toBe(true);
    expect(canTransition('published', 'publishing')).toBe(true);
    expect(canTransition('unpublished', 'publishing')).toBe(true);
  });

  it('allows a failed run to restore any status it could have come from', () => {
    expect(canTransition('publishing', 'draft')).toBe(true);
    expect(canTransition('publishing', 'in_review')).toBe(true);
    expect(canTransition('publishing', 'unpublished')).toBe(true);
    // ...and `published`, which is the success edge and the one that matters:
    // a failed re-publish of a live course must not withdraw it.
    expect(canTransition('publishing', 'published')).toBe(true);
  });

  it('refuses to reach `published` except through `publishing`', () => {
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('in_review', 'published')).toBe(false);
    expect(canTransition('unpublished', 'published')).toBe(false);
  });

  it('refuses to archive anything that is not unpublished', () => {
    expect(canTransition('draft', 'archived')).toBe(false);
    expect(canTransition('in_review', 'archived')).toBe(false);
    expect(canTransition('published', 'archived')).toBe(false);
    expect(canTransition('publishing', 'archived')).toBe(false);
  });

  it('makes `archived` terminal', () => {
    for (const status of publicationStatuses) {
      expect(canTransition('archived', status), `archived→${status}`).toBe(false);
    }
  });

  it('refuses a published course back to draft', () => {
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('published', 'in_review')).toBe(false);
  });

  it('refuses a no-op, so a second publish cannot slip past the in-flight lock', () => {
    for (const status of publicationStatuses) {
      expect(canTransition(status, status), `${status}→${status}`).toBe(false);
    }
  });

  it('denies by default for a status outside §8.1', () => {
    expect(canTransition('nonsense' as PublicationStatus, 'published')).toBe(false);
  });
});

describe('allowedTransitionsFrom', () => {
  it('lists what a 409 should offer the caller', () => {
    expect(allowedTransitionsFrom('draft')).toEqual(['in_review', 'publishing']);
    expect(allowedTransitionsFrom('archived')).toEqual([]);
  });
});

describe('structurePayloadSchema', () => {
  const payload = {
    courseId: '3f1a0c8e-1f0e-4c3a-9a3b-2c6f5d4e7b81',
    publishedVersionNumber: 1,
    totalLessonCount: 1,
    chapters: [
      {
        chapterId: '5c2b1d9f-2a1b-4d5e-8f7a-3b6c9d0e1f22',
        order: 1,
        title: 'Hiragana',
        description: null,
        lessons: [
          {
            lessonId: '7e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c13',
            order: 1,
            title: 'The A-row',
            estimatedMinutes: 12,
            isFreePreview: true,
            hasAudio: true,
            audioDurationSeconds: 184,
            figureCount: 3,
          },
        ],
      },
    ],
  };

  it('accepts a well-formed snapshot', () => {
    expect(structurePayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects course metadata, which belongs on `courses` and not in the snapshot', () => {
    const withTitle = { ...payload, title: 'N5' };
    expect(structurePayloadSchema.safeParse(withTitle).success).toBe(false);
  });

  it('rejects a millisecond duration smuggled in as a float', () => {
    const lesson = { ...payload.chapters[0]!.lessons[0]!, audioDurationSeconds: 184.32 };
    const bad = {
      ...payload,
      chapters: [{ ...payload.chapters[0]!, lessons: [lesson] }],
    };
    expect(structurePayloadSchema.safeParse(bad).success).toBe(false);
  });

  it('requires a positive version number', () => {
    expect(structurePayloadSchema.safeParse({ ...payload, publishedVersionNumber: 0 }).success).toBe(
      false,
    );
  });
});
