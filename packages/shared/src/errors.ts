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
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
