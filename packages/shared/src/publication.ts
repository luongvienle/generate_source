import { z } from 'zod';
import type { PublicationStatus } from './enums';
import { publicationStatuses } from './enums';

/**
 * The §4.2 editorial state machine for `courses.publication_status`, as data.
 *
 * Held here rather than as conditionals in six endpoints for the reason §3's
 * matrix is in roles.ts: an enforcement rule recorded twice drifts. Every
 * transition endpoint consults this table and none of them restates an edge.
 *
 * §4.2 draws ONE LINE:
 *
 *     draft → in_review → publishing → published → unpublished → archived
 *
 * That line is the admin-authored happy path, not an exhaustive edge list, and
 * three groups of edges below are not on it. Which group an edge belongs to is
 * recorded per entry, because "the spec says so" and "P6 decided so" are
 * different claims and a later reader is owed the difference.
 */

/** Why an edge exists — see the note above. `diagram` edges are §4.2's own. */
export type TransitionKind = 'diagram' | 'addition' | 'restore';

export interface PublicationTransition {
  readonly from: PublicationStatus;
  readonly to: PublicationStatus;
  readonly kind: TransitionKind;
  readonly reason: string;
}

export const publicationTransitions: readonly PublicationTransition[] = [
  // ── Group 1: on §4.2's diagram ──────────────────────────────────────────
  {
    from: 'draft',
    to: 'in_review',
    kind: 'diagram',
    reason: 'FR §9.3 submit-review: an admin hands a finished course to the owner',
  },
  {
    from: 'in_review',
    to: 'publishing',
    kind: 'diagram',
    reason: 'The owner accepts the review and starts the publish job',
  },
  {
    from: 'publishing',
    to: 'published',
    kind: 'diagram',
    reason: 'FR-PUB-02: the publish job succeeded',
  },
  {
    from: 'published',
    to: 'unpublished',
    kind: 'diagram',
    reason: 'FR-PUB-04: withdraw from the catalog, preserving grants and progress',
  },
  {
    from: 'unpublished',
    to: 'archived',
    kind: 'diagram',
    reason: '§4.2: terminal, hidden from admin lists',
  },

  // ── Group 2: additions this phase makes deliberately ────────────────────
  {
    from: 'in_review',
    to: 'draft',
    kind: 'addition',
    reason:
      'A review a reviewer cannot reject is not a review. Without this edge in_review ' +
      'is a state only a publish can leave, and an owner who finds a problem has ' +
      'nothing to do but publish anyway.',
  },
  {
    from: 'draft',
    to: 'publishing',
    kind: 'addition',
    reason:
      "§4.2's line is the admin-authored path. An owner authoring their own course has " +
      'nobody to hand it to, and §5.7 makes the checklist the gate rather than the review.',
  },
  {
    from: 'published',
    to: 'publishing',
    kind: 'addition',
    reason: "FR-PUB-03's publish-changes action on a course with unpublished edits",
  },
  {
    from: 'unpublished',
    to: 'publishing',
    kind: 'addition',
    reason:
      'FR-PUB-04 republish. The draft may have been edited while the course was ' +
      'withdrawn, so this runs the full checklist and the full job rather than ' +
      'flipping a status back.',
  },

  // ── Group 3: the restore edges out of `publishing` ──────────────────────
  //
  // `publishing` is a LOCK (R-01 treats it as `published`), so every way out of
  // it must be defined or a failed run strands the whole course and locks out
  // every admin. Success goes to `published` above; every failure returns the
  // course to the status it held going in, which travels in the job payload as
  // `previousStatus`.
  //
  // The load-bearing case is `publishing → published`: a re-publish of a LIVE
  // course that fails must leave it published. Sending it to `draft` would
  // silently withdraw content learners are reading — a failed job must never be
  // able to unpublish a course.
  {
    from: 'publishing',
    to: 'draft',
    kind: 'restore',
    reason: 'The run failed; the course was a draft before it started',
  },
  {
    from: 'publishing',
    to: 'in_review',
    kind: 'restore',
    reason: 'The run failed; the course was awaiting review before it started',
  },
  {
    from: 'publishing',
    to: 'unpublished',
    kind: 'restore',
    reason: 'The run failed; the course was withdrawn before it started',
  },
] as const;

const allowed = new Set(publicationTransitions.map((t) => `${t.from}→${t.to}`));

/**
 * Whether §4.2 permits this move.
 *
 * Deny-by-default, like `isAllowed`: an edge absent from the table is refused
 * rather than permitted, so a phase adding a state without adding its edges
 * fails closed.
 *
 * A no-op (`from === to`) is NOT a transition and is refused. Callers that want
 * idempotent behaviour must decide that for themselves; silently allowing it
 * here would let a second publish slip past the in-flight lock.
 */
export function canTransition(from: PublicationStatus, to: PublicationStatus): boolean {
  return allowed.has(`${from}→${to}`);
}

/** Every status reachable from `from`, for the 409 body and for the admin UI. */
export function allowedTransitionsFrom(from: PublicationStatus): readonly PublicationStatus[] {
  return publicationTransitions.filter((t) => t.from === from).map((t) => t.to);
}

/**
 * The §4.3 table-of-contents snapshot stored in
 * `published_course_structures.structure_payload`.
 *
 * §8 declares the column JSONB and describes no shape, so this schema IS the
 * contract between the publish job that writes it and P7's learner app that
 * reads it. Written and read through this schema by both sides, so P7 parses
 * what P6 wrote rather than a hand-copied interface.
 *
 * COURSE METADATA IS DELIBERATELY ABSENT. Title, slug, overview, prerequisites,
 * objectives and cover image stay on `courses`, which §9.4's GET /courses/:slug
 * reads directly. §4.3's stated reason for a separate table is that the snapshot
 * stays a few KB regardless of lesson count — not that it becomes the whole page
 * — and duplicating metadata here would let the two copies drift between
 * publishes.
 */
export const snapshotLessonSchema = z.strictObject({
  lessonId: z.uuid(),
  order: z.number().int(),
  title: z.string(),
  estimatedMinutes: z.number().int().nullable(),
  isFreePreview: z.boolean(),
  hasAudio: z.boolean(),
  /**
   * Seconds, copied verbatim from `lesson_audios.total_duration_seconds`.
   *
   * NOT milliseconds: the stored column is seconds, and converting here would
   * give the snapshot and its source two units that can disagree. Per-segment
   * millisecond offsets stay in `audio_segments`, where P7's highlight sync
   * reads them; they are not snapshot material.
   */
  audioDurationSeconds: z.number().int().nullable(),
  figureCount: z.number().int(),
});

export const snapshotChapterSchema = z.strictObject({
  chapterId: z.uuid(),
  order: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  lessons: z.array(snapshotLessonSchema),
});

export const structurePayloadSchema = z.strictObject({
  courseId: z.uuid(),
  publishedVersionNumber: z.number().int().positive(),
  chapters: z.array(snapshotChapterSchema),
  totalLessonCount: z.number().int(),
});

export type SnapshotLesson = z.infer<typeof snapshotLessonSchema>;
export type SnapshotChapter = z.infer<typeof snapshotChapterSchema>;
export type StructurePayload = z.infer<typeof structurePayloadSchema>;

export { publicationStatuses };
export type { PublicationStatus };
