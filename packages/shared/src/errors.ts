/**
 * Machine-readable error codes. FR-AUTH-02 requires every 403 to carry one, so
 * clients branch on a stable code rather than parsing prose.
 */
export const errorCodes = {
  /** No session, or the session does not resolve to an active user. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Authenticated, but the endpoint requires a role the caller does not hold. */
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  /** The endpoint declared no required role, so it denies everyone. */
  FORBIDDEN_NO_POLICY: 'FORBIDDEN_NO_POLICY',
  /** Rule R-01: only admin_owner may write to a published course. */
  FORBIDDEN_COURSE_PUBLISHED: 'FORBIDDEN_COURSE_PUBLISHED',
  /** Rule R-02: an admin may only write where assigned, or where unassigned. */
  FORBIDDEN_NOT_ASSIGNED: 'FORBIDDEN_NOT_ASSIGNED',
  /** The account exists but is_active is false. */
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  /** The request set a field only admin_owner may write, such as assignedAdminId. */
  FORBIDDEN_OWNER_ONLY_FIELD: 'FORBIDDEN_OWNER_ONLY_FIELD',
  /** FR-IMP-03: the payload's schemaVersion is not the version the server ships. */
  IMPORT_SCHEMA_VERSION_MISMATCH: 'IMPORT_SCHEMA_VERSION_MISMATCH',
  /** FR-IMP-01: the payload failed §9.1 validation; every error carries a JSON path. */
  IMPORT_PAYLOAD_INVALID: 'IMPORT_PAYLOAD_INVALID',
  /** FR-EDIT-04: the structure payload does not describe this course's rows exactly. */
  STRUCTURE_MISMATCH: 'STRUCTURE_MISMATCH',
  /** No job with this id is known to Redis or generation_jobs. */
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  /** FR-EDIT-01: the lesson markdown failed §5.3 validation; every error carries a position. */
  LESSON_CONTENT_INVALID: 'LESSON_CONTENT_INVALID',
  /** The draft moved on since the editor loaded it; another admin saved first. */
  LESSON_CONTENT_CONFLICT: 'LESSON_CONTENT_CONFLICT',
  /** FR-IMG-02: the uploaded bytes are not PNG, JPEG, WebP or SVG. */
  IMAGE_TYPE_UNSUPPORTED: 'IMAGE_TYPE_UNSUPPORTED',
  /** FR-IMG-02: the upload exceeds the 5 MB ceiling. */
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  /** §6.2: the blockReferenceId names no figure block in the stored block list. */
  IMAGE_BLOCK_NOT_FOUND: 'IMAGE_BLOCK_NOT_FOUND',
  /** No lesson_images row with this id. */
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
