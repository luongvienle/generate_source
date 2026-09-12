/** Mirrors JobSnapshot from apps/api. The two apps share no code, only this shape. */
export interface JobSnapshot {
  jobId: string;
  jobType: string;
  jobStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  result: unknown;
  /**
   * Interior progress, for a job that reports it. P4's narration run is several
   * provider calls, and `{ done, total }` counts VALIDATED chunks — a retry never
   * moves it backwards. Absent on jobs that report none.
   */
  progress?: { done: number; total: number } | null;
}

export interface ImportPlanCounts {
  chaptersCreated: number;
  chaptersUpdated: number;
  chaptersUnchanged: number;
  chaptersDeleted: number;
  lessonsCreated: number;
  lessonsUpdated: number;
  lessonsUnchanged: number;
  lessonsDeleted: number;
  conflicts: number;
}

export interface ImportConflict {
  kind: string;
  title: string;
  reason: string;
  lessonId?: string;
  chapterId?: string;
}

export interface ImportPlanResult {
  category: { action: string; slug: string; displayName: string };
  course: { action: string; slug: string; isPublished: boolean };
  counts: ImportPlanCounts;
  conflicts: ImportConflict[];
}

export const isTerminal = (status: JobSnapshot['jobStatus']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'unknown';
