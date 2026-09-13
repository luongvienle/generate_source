/**
 * §9.2's review queue, mirroring
 * `apps/api/src/topic-requests/topic-requests-admin.service.ts`.
 *
 * `requestedByEmail` is present here and absent from the learner app's
 * `BoardView` on purpose: §3 gives `reviewTopicRequests` to the owner alone, and
 * recognising one person filing five variations of a topic is what the field is
 * for. It must not travel any further than this screen.
 */
export type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'duplicated';

export interface QueueRowView {
  readonly id: string;
  readonly requestedTopicTitle: string;
  readonly requestDescription: string | null;
  readonly requestStatus: RequestStatus;
  readonly upvoteCount: number;
  readonly createdAt: string;
  readonly reviewerNote: string | null;
  readonly requestedByEmail: string;
  readonly linkedCourse: { readonly id: string; readonly slug: string; readonly title: string } | null;
  readonly duplicateOf: { readonly id: string; readonly requestedTopicTitle: string } | null;
}

export interface QueueView {
  readonly items: readonly QueueRowView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly courseOptions: readonly CourseOption[];
}

/** The four outcomes §9.2 allows, and what each one may carry. */
export interface ReviewBody {
  requestStatus: RequestStatus;
  reviewerNote?: string;
  linkedCourseId?: string;
  duplicateOfRequestId?: string;
}

export interface CourseOption {
  readonly id: string;
  readonly title: string;
  readonly levelLabel: string;
  readonly publicationStatus: string;
}
