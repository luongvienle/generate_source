/** §5.7's seven items, as the API returns them. Ids match ChecklistItemId. */
export interface ChecklistItemView {
  id: string;
  /** §5.7's bullet, verbatim. */
  requirement: string;
  passed: boolean;
  reason: string;
  offenders: string[];
}

export interface PublishChecklistView {
  courseId: string;
  passed: boolean;
  items: ChecklistItemView[];
}

/** §4.2's current state plus every edge leaving it. */
export interface PublicationStatusView {
  courseId: string;
  publicationStatus: string;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  publishedVersionNumber: number | null;
  allowedTransitions: string[];
}

/** What the owner sees on the publish button, given §4.2 and FR-PUB-03. */
export function publishLabel(status: PublicationStatusView): string {
  if (status.publicationStatus === 'published') return 'Publish changes';
  if (status.publicationStatus === 'unpublished') return 'Republish';
  return 'Publish';
}

/**
 * Human wording for §4.2's members.
 *
 * Presentation only. Every one of these is enforced server-side by the
 * transition table; R-01 is explicit that hiding a control is never the
 * enforcement.
 */
export const statusLabels: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  publishing: 'Publishing…',
  published: 'Published',
  unpublished: 'Unpublished',
  archived: 'Archived',
};
