import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintImageKey } from '../src/keys';
import { S3ObjectStorage, s3ConfigFromEnv } from '../src/s3-object-storage';

/**
 * Runs against the MinIO service from docker-compose.yml, the same way the
 * database suites run against a real Postgres.
 */
loadEnv({ path: ['../../.env', '.env'] });

const config = s3ConfigFromEnv();
const storage = new S3ObjectStorage(config);

const keyFor = (contentType: Parameters<typeof mintImageKey>[0]['contentType']) =>
  mintImageKey({
    lessonId: randomUUID(),
    blockReferenceId: 'fig1',
    imageId: randomUUID(),
    contentType,
  });

// A one-pixel PNG. Real bytes, so content-type sniffing downstream has
// something honest to look at.
const pngBytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('S3ObjectStorage', () => {
  beforeAll(async () => {
    await storage.ensureBucket();
  });

  it('creates the bucket idempotently', async () => {
    // Second call must not throw, and must not depend on the first's result.
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    await expect(new S3ObjectStorage(config).ensureBucket()).resolves.toBeUndefined();
  });

  it('round-trips an object byte-identically', async () => {
    const key = keyFor('image/png');
    await storage.put(key, pngBytes, 'image/png');

    const read = await storage.get(key);
    expect(Buffer.from(read).equals(Buffer.from(pngBytes))).toBe(true);
  });

  it('serves a presigned URL, preserving the stored content type', async () => {
    const key = keyFor('image/png');
    await storage.put(key, pngBytes, 'image/png');

    const url = await storage.presignGet(key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(pngBytes))).toBe(true);
  });

  it('signs SVG with its own content type, not a generic one', async () => {
    const key = keyFor('image/svg+xml');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await storage.put(key, Uint8Array.from(svg), 'image/svg+xml');

    const response = await fetch(await storage.presignGet(key));
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('expires the URL at the requested horizon', async () => {
    const key = keyFor('image/png');
    await storage.put(key, pngBytes, 'image/png');

    const url = new URL(await storage.presignGet(key, 600));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  });

  /**
   * The assertion that keeps S3_ENDPOINT and S3_PUBLIC_ENDPOINT from being
   * collapsed into one variable.
   *
   * Locally both hold the same value, so signing against the wrong one is
   * invisible. Here the divergence is constructed on purpose: sign for a host
   * the browser will not use, then request the object at the host it will.
   * That is exactly the production failure, and it must be a rejection.
   */
  it('rejects a URL signed for a different host than the one requested', async () => {
    const key = keyFor('image/png');
    await storage.put(key, pngBytes, 'image/png');

    const internal = 'http://internal-minio:9000';
    const divergent = new S3ObjectStorage({ ...config, publicEndpoint: internal });

    const signedForInternal = await divergent.presignGet(key);
    expect(signedForInternal.startsWith(internal)).toBe(true);

    // Same path and signature, requested at the endpoint a browser can reach.
    const asABrowserWouldFetchIt = signedForInternal.replace(internal, config.endpoint);
    const response = await fetch(asABrowserWouldFetchIt);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('SignatureDoesNotMatch');
  });
});
