/**
 * FR-REQ-01's board payload, mirroring
 * `apps/api/src/public/topic-requests.service.ts`.
 *
 * There is no submitter field and there must never be one: the API does not
 * serialize identity on this surface, and a type that invited it would be the
 * first step to a page that renders it. `viewerHasVoted` and `viewerIsRequester`
 * describe the reader of the page, not the author of the request.
 */
export type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'duplicated';

export interface TopicRequestView {
  readonly id: string;
  readonly requestedTopicTitle: string;
  readonly requestDescription: string | null;
  readonly requestStatus: RequestStatus;
  readonly upvoteCount: number;
  readonly createdAt: string;
  readonly reviewerNote: string | null;
  readonly linkedCourse: { readonly slug: string; readonly title: string } | null;
  readonly viewerHasVoted: boolean;
  readonly viewerIsRequester: boolean;
}

export interface BoardGroup {
  readonly items: readonly TopicRequestView[];
  readonly total: number;
}

export interface BoardView {
  readonly open: BoardGroup & { readonly page: number; readonly pageSize: number };
  readonly built: BoardGroup;
  readonly closed: BoardGroup;
}

export interface MyRequestView extends TopicRequestView {
  readonly canWithdraw: boolean;
}

export interface MyRequestsView {
  readonly items: readonly MyRequestView[];
  readonly pendingCount: number;
  readonly pendingCap: number;
}
