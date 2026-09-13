import { LessonBody } from '@knowledge-explorer/content/render';
import { toFigureImages, type LessonReadView } from '../lib/reader-types';
import { LessonClient } from './lesson-client';

/**
 * The lesson body, rendered by the SHARED renderer.
 *
 * `LessonBody` is the same component `apps/admin-web`'s preview pane uses, which
 * is how FR-EDIT-01's "renders exactly what the learner will see" stays true by
 * construction rather than by discipline. P7 writes no learner-only renderer
 * and changes nothing in `packages/content`.
 *
 * Rendered on the SERVER: it is pure markup with no interactivity, so none of
 * the markdown pipeline reaches the browser bundle. `LessonClient` below is the
 * interactive layer — player and progress — and it finds blocks through the
 * `data-block-id` attribute this markup already emits, which is exactly why the
 * renderer emits it and why it stays free of click handling.
 */
export function LessonReader({
  lesson,
  isSignedIn,
  initialProgress,
}: {
  lesson: LessonReadView;
  isSignedIn: boolean;
  initialProgress: { completed: boolean; scrollPercentage: number; audioPositionMs: number } | null;
}) {
  return (
    <>
      <article className="prose prose-neutral mt-6 max-w-none" data-testid="lesson-body">
        <LessonBody blocks={lesson.blocks} images={toFigureImages(lesson.figureImages)} />
      </article>

      <LessonClient lesson={lesson} isSignedIn={isSignedIn} initialProgress={initialProgress} />
    </>
  );
}
