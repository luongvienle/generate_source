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
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
