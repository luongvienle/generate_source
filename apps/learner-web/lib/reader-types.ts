import type { Block, FigureImage, FigureImages } from '@knowledge-explorer/content';

/**
 * The `GET /lessons/:lessonId` response, mirroring
 * `apps/api/src/public/reader.service.ts`. Written out rather than imported:
 * §11 makes the API a separate deployable and no app imports another.
 */

export interface ReaderSegmentView {
  blockId: string;
  segmentOrder: number;
  startMillisecond: number;
  endMillisecond: number;
}

export interface ReaderAudioView {
  /** The `lesson_audios.id` the player mints a signed URL against. */
  mediaId: string;
  totalDurationSeconds: number | null;
  segments: ReaderSegmentView[];
}

export interface ReaderNeighbour {
  lessonId: string;
  title: string;
}

export interface LessonReadView {
  lessonId: string;
  title: string;
  courseSlug: string;
  courseTitle: string;
  chapterTitle: string;
  blocks: Block[];
  /** Keyed by blockId, already presigned — see FigureImage's contract. */
  figureImages: Record<string, FigureImage>;
  audio: ReaderAudioView | null;
  previous: ReaderNeighbour | null;
  next: ReaderNeighbour | null;
  isFreePreview: boolean;
}

/**
 * `LessonBody` takes a Map; the wire carries an object. One conversion, here,
 * so no component does it twice.
 */
export const toFigureImages = (figureImages: Record<string, FigureImage>): FigureImages =>
  new Map(Object.entries(figureImages));
