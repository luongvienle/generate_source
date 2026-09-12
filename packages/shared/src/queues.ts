/**
 * BullMQ queue and job names, single-sourced so the producer in apps/api and the
 * consumer in apps/worker cannot drift apart.
 *
 * The queue is named for the work, not for a §8.1 job_type, because it carries
 * two kinds of job: a commit, which writes a generation_jobs row with
 * job_type = 'import_course_outline', and a dry run, which by FR-IMP-02 writes
 * no database row at all and therefore has no §8.1 job_type.
 */
export const IMPORT_QUEUE_NAME = 'curriculum-import';

export const importJobNames = {
  dryRun: 'dry-run',
  commit: 'commit',
} as const;

export type ImportJobName = (typeof importJobNames)[keyof typeof importJobNames];

/**
 * NFR-03: every background job retries with exponential backoff and stops after
 * three attempts. Held here so producer defaults and worker expectations agree.
 */
export const JOB_MAX_ATTEMPTS = 3;
export const JOB_BACKOFF_DELAY_MS = 1_000;

/** FR-IMP-02: a dry run's result lives only in Redis, for this long. */
export const DRY_RUN_RESULT_TTL_SECONDS = 3_600;

/** Where a dry run's ImportPlan is cached. */
export const dryRunResultKey = (jobId: string): string => `import:dryrun:${jobId}`;

/**
 * A Redis connection described as plain data.
 *
 * BullMQ 5 bundles ioredis 5 while apps/worker depends on ioredis 6, so handing
 * BullMQ one of our own client instances fails to typecheck. Passing options
 * instead lets BullMQ construct its own client and keeps the two versions from
 * having to agree.
 */
export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
}

export function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');

  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
  };
}
