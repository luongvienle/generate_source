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

/**
 * The image generation queue (P3): the second producer on the substrate P1
 * built, and the first one that spends money per job.
 *
 * A sibling of the import queue rather than a generalised factory. Two
 * instances is not enough evidence for an abstraction; P5's audio queue is the
 * third, and the shared shape will be obvious then. What genuinely must not
 * drift — attempts, backoff, queue names — already lives in this file.
 */
export const IMAGE_QUEUE_NAME = 'image-generation';

export const imageJobNames = {
  generate: 'generate',
} as const;

export type ImageJobName = (typeof imageJobNames)[keyof typeof imageJobNames];

/**
 * What a generate_image job carries.
 *
 * `generationJobId` is the generation_jobs row the API created, which
 * withJobLifecycle drives. The prompt travels FULLY COMPOSED: composition is
 * versioned (NFR-08) and happens once, at enqueue time, so a retry cannot
 * silently use a newer template than the one the admin saw.
 */
export interface GenerateImageJobData {
  readonly generationJobId: string;
  readonly lessonId: string;
  readonly blockReferenceId: string;
  readonly composedPrompt: string;
  readonly candidateCount: number;
  readonly createdByUserId: string;
}

/**
 * The narration script queue (P4): the THIRD producer on the substrate P1 built.
 *
 * The note on IMAGE_QUEUE_NAME above predicted the shared shape would be obvious
 * at the third queue and named P5's audio queue as that third. Narration arrived
 * first. The extraction was reconsidered here and DEFERRED AGAIN, deliberately:
 * the three producers differ in more than their names — import carries two job
 * names and a Redis-cached result, image retains nothing and qualifies its ids,
 * narration holds a database-level in-flight lock — and a factory over three
 * shapes that disagree would be parameterised until it was longer than the three
 * siblings it replaced. P5's audio queue is the fourth and the closest sibling of
 * image; that is the moment to extract, not this one.
 *
 * What genuinely must not drift — attempts, backoff, queue names, payload types —
 * already lives in this file, which is what the pattern is actually protecting.
 */
export const NARRATION_QUEUE_NAME = 'narration-script';

export const narrationJobNames = {
  generate: 'generate',
} as const;

export type NarrationJobName = (typeof narrationJobNames)[keyof typeof narrationJobNames];

/**
 * What a generate_narration_script job carries.
 *
 * Deliberately THIN. Unlike GenerateImageJobData, no prompt and no input travel
 * with the job: §6.3's input is the stored block list, which the worker re-reads
 * and re-checksums at the start of the run. A block list is unbounded where a
 * prompt string is small, and Redis is the wrong place for it. The consequence is
 * recorded in specs/p4-narration/spec.md — an edit landing mid-run yields a
 * script that is born stale, which is correct and which the tab shows.
 */
export interface GenerateNarrationScriptJobData {
  readonly generationJobId: string;
  readonly lessonId: string;
  readonly createdByUserId: string;
}

/**
 * §6.3 chunking (specs/p4-narration/spec.md).
 *
 * 25 sits in the middle of the reliability curve: comfortably within what a model
 * counts and orders correctly, while a rejected chunk re-spends 25 blocks rather
 * than half a lesson. MAX_TRIES is §6.3's "1 try + 2 retries" and is the one of
 * the three the product spec fixes.
 */
export const NARRATION_CHUNK_BLOCK_COUNT = 25;
export const NARRATION_CHUNK_MAX_TRIES = 3;

/**
 * Whole-run ceiling on provider calls, so a pathological lesson cannot fan the
 * per-chunk budget out into dozens of paid calls. Worst case is
 * 3 x chunkCount, so this binds only above 13 chunks — past roughly 325 blocks,
 * where refusing is the honest answer and §4.1 wants smaller lessons anyway.
 */
export const NARRATION_RUN_MAX_CALLS = 40;
