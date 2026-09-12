import type { BlockList } from '@knowledge-explorer/content';

/** The response of GET and PUT /admin/lessons/:lessonId/content. */
export interface LessonContentView {
  lessonId: string;
  markdown: string;
  blockList: BlockList;
  draftContentChecksum: string | null;
  /** Serialized over JSON, so a string here rather than a Date. */
  draftUpdatedAt: string | null;
  lastEditedByUserId: string | null;
  contentStatus: string;
  /**
   * Whether this caller's write would be accepted, computed server-side from the
   * same facts R-01 and R-02 use. Display only — the PUT refuses independently.
   */
  canEdit: boolean;
  readOnlyReason: string | null;
}

/** One §5.3 validation failure, as the 422 body carries it. */
export interface LessonContentError {
  message: string;
  line: number;
  column: number;
}

export const lessonContentPath = (lessonId: string): string =>
  `/admin/lessons/${lessonId}/content`;
