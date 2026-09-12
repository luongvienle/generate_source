import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PRESIGN_EXPIRY_SECONDS, type ObjectStorage } from './object-storage';

/**
 * MinIO under Docker Compose; any S3-compatible store in production.
 *
 * TWO CLIENTS, DELIBERATELY. An S3 signature covers the host, so a URL signed
 * against the endpoint `apps/api` talks to is rejected by the browser when the
 * browser reaches the store on a different hostname. Reads and writes go
 * through `client`; presigning goes through `signer`, which is configured with
 * the public endpoint and is never used to make a request.
 *
 * Locally the two endpoints hold the same value, because the API and worker run
 * on the host rather than inside Compose. That makes a wrong-client bug
 * invisible in development and in CI, which is why the suite constructs the
 * divergence on purpose rather than trusting the environment to expose it.
 */
export interface S3StorageConfig {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageConfig {
  const endpoint = required(env, 'S3_ENDPOINT');
  return {
    endpoint,
    // Falling back to the internal endpoint keeps a single-host deployment from
    // needing both, without letting the distinction be forgotten where it matters.
    publicEndpoint: env['S3_PUBLIC_ENDPOINT'] ?? endpoint,
    region: env['S3_REGION'] ?? 'us-east-1',
    bucket: required(env, 'S3_BUCKET'),
    accessKeyId: required(env, 'S3_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'S3_SECRET_ACCESS_KEY'),
  };
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;
  /** Memoized so concurrent first writes do not each issue a CreateBucket. */
  private bucketReady?: Promise<void>;

  constructor(config: S3StorageConfig) {
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    // forcePathStyle: MinIO serves buckets as a path segment, not a subdomain.
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials,
      forcePathStyle: true,
    });
    this.signer = new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      credentials,
      forcePathStyle: true,
    });
    this.bucket = config.bucket;
  }

  /**
   * Creates the bucket if it is absent, once per process.
   *
   * The bucket is created through the S3 API rather than by a Compose init
   * container: a one-shot container makes `docker compose up -d --wait` exit 1
   * even when it succeeds, and GitHub Actions service containers cannot express
   * one at all. Doing it here works identically in both. A bucket created this
   * way has no public policy, and nothing here ever sets one — §11 requires it
   * to stay private.
   */
  async ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        try {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        } catch (error) {
          // A concurrent creator won the race; anything else is real.
          const name = error instanceof Error ? error.name : '';
          if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
        }
      }
    })();
    return this.bucketReady;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`Object has no body: ${key}`);
    return response.Body.transformToByteArray();
  }

  async presignGet(
    key: string,
    expiresInSeconds: number = PRESIGN_EXPIRY_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}
