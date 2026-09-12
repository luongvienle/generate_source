/**
 * Private object storage, behind an interface (§11).
 *
 * §11 names "private object storage with CDN" as infrastructure but assigns it
 * to no package, so this workspace is a deliberate sixth where §11's layout
 * lists five — see specs/p3-images/spec.md. It exists because both `apps/api`
 * and `apps/worker` need it and neither may import the other, and because the
 * AWS SDK must stay out of anything `apps/admin-web` can reach.
 */
export interface ObjectStorage {
  /** Stores bytes under `key`. `contentType` is persisted as object metadata. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;

  get(key: string): Promise<Uint8Array>;

  /**
   * A short-lived URL the browser can fetch directly.
   *
   * Signed against the PUBLIC endpoint, which is not always the endpoint used
   * for reads and writes — see S3ObjectStorage.
   */
  presignGet(key: string, expiresInSeconds?: number): Promise<string>;
}

/** Injection token. A Symbol cannot collide with another provider's token. */
export const OBJECT_STORAGE = Symbol('ObjectStorage');

/**
 * NFR-02 caps signed media URLs at 15 minutes. 10 is comfortably inside it and
 * still long enough that an admin reading a drawer does not watch images expire.
 */
export const PRESIGN_EXPIRY_SECONDS = 600;
