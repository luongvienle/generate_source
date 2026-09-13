export interface TreeLesson {
  id: string;
  lessonOrder: number;
  title: string;
  contentStatus: string;
  assignedAdminId: string | null;
  /** FR-LRN-01: readable without entitlement, and the course's shop window. */
  isFreePreview: boolean;
}

export interface TreeChapter {
  id: string;
  chapterOrder: number;
  title: string;
  description: string | null;
  assignedAdminId: string | null;
  lessons: TreeLesson[];
}

export interface CourseTree {
  id: string;
  slug: string;
  title: string;
  publicationStatus: string;
  hasUnpublishedChanges: boolean;
  chapters: TreeChapter[];
}

export interface AdminSummary {
  id: string;
  email: string;
  name: string | null;
  userRole: string;
  isActive: boolean;
}

/** The body of PATCH /courses/:courseId/structure: the complete intended order. */
export const toStructurePayload = (chapters: TreeChapter[]) => ({
  chapters: chapters.map((chapter) => ({
    chapterId: chapter.id,
    lessonIds: chapter.lessons.map((lesson) => lesson.id),
  })),
});
