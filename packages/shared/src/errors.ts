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
  /** A narration run is already in flight for this lesson; the jobId travels with the 409. */
  SCRIPT_GENERATION_IN_FLIGHT: 'SCRIPT_GENERATION_IN_FLIGHT',
  /**
   * FR-SCRIPT-03 writes a figure's segment from its caption and alt text and from
   * nothing else, so an empty one is a paid call producing a paragraph that
   * describes nothing. The response lists the offending figures.
   */
  SCRIPT_FIGURES_INCOMPLETE: 'SCRIPT_FIGURES_INCOMPLETE',
  /** §6.3 takes the block list as input, and there is nothing to narrate. */
  SCRIPT_LESSON_EMPTY: 'SCRIPT_LESSON_EMPTY',
  /** The chunk count alone would exceed NARRATION_RUN_MAX_CALLS; refused before the first call. */
  SCRIPT_TOO_MANY_CHUNKS: 'SCRIPT_TOO_MANY_CHUNKS',
  /** No narration_scripts row for this lesson; nothing to edit or approve. */
  SCRIPT_NOT_FOUND: 'SCRIPT_NOT_FOUND',
  /** An edit named a blockId that is not in the stored script; the whole request is refused. */
  SCRIPT_SEGMENT_UNKNOWN: 'SCRIPT_SEGMENT_UNKNOWN',
  /** FR-SCRIPT-04: a stale, failed, generating or pending script cannot be approved. */
  SCRIPT_NOT_APPROVABLE: 'SCRIPT_NOT_APPROVABLE',
  /** The script moved on since the tab loaded it; another admin saved first. */
  SCRIPT_CONFLICT: 'SCRIPT_CONFLICT',
  /** No narration_scripts row for this lesson; there is nothing to voice (P5). */
  AUDIO_SCRIPT_NOT_FOUND: 'AUDIO_SCRIPT_NOT_FOUND',
  /**
   * §5.5 makes admin approval required before audio generation and names it as
   * the enforcement point for FR-SCRIPT-02. This is where that is enforced.
   */
  AUDIO_SCRIPT_NOT_APPROVED: 'AUDIO_SCRIPT_NOT_APPROVED',
  /**
   * The script's COMPUTED status is stale, failed, generating or pending.
   * Synthesizing it would buy audio FR-PUB-01 then refuses to publish.
   */
  AUDIO_SCRIPT_STALE: 'AUDIO_SCRIPT_STALE',
  /** An audio run is already in flight for this lesson; the jobId travels with the 409. */
  AUDIO_GENERATION_IN_FLIGHT: 'AUDIO_GENERATION_IN_FLIGHT',
  /** More segments than AUDIO_RUN_MAX_SEGMENTS; refused before the first paid call. */
  AUDIO_TOO_MANY_SEGMENTS: 'AUDIO_TOO_MANY_SEGMENTS',
  /**
   * A segment exceeds the provider's maxInputCharacters. Refused at precondition
   * time with the offending blockId, rather than on attempt three of a run that
   * has already paid for every segment before it.
   */
  AUDIO_SEGMENT_TOO_LONG: 'AUDIO_SEGMENT_TOO_LONG',
  /** FR-AUDIO-03: the course's voice is not one the selected provider accepts. */
  AUDIO_VOICE_NOT_CONFIGURED: 'AUDIO_VOICE_NOT_CONFIGURED',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
