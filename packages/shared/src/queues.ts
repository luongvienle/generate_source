import type { JobType } from './enums';

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
 * Its shared shape now lives in `queueDefinitions` at the foot of this file —
 * see the note there for what was extracted at P5 and what deliberately was not.
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
 * Its shared shape now lives in `queueDefinitions` at the foot of this file.
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

/**
 * The audio queue (P5): the FOURTH producer, and the closest sibling of image.
 */
export const AUDIO_QUEUE_NAME = 'audio-synthesis';

export const audioJobNames = {
  generate: 'generate',
} as const;

export type AudioJobName = (typeof audioJobNames)[keyof typeof audioJobNames];

/**
 * What a generate_audio job carries.
 *
 * THE VOICE TRAVELS WITH THE JOB. FR-AUDIO-03 gives a course one configured
 * voice, and it is resolved once at enqueue rather than re-read in the worker,
 * so a retry — or an owner changing the course voice mid-run — cannot produce a
 * lesson synthesized half in one voice and half in another. The segments are
 * read from the stored narration script, which the worker re-reads for the
 * reason P4 records: a script is unbounded where a voice identifier is small.
 */
export interface GenerateAudioJobData {
  readonly generationJobId: string;
  readonly lessonId: string;
  readonly voiceIdentifier: string;
  readonly voiceProviderName: string;
  readonly createdByUserId: string;
}

/**
 * NFR-03 bounds concurrency, and P5 is where that bites hardest: a narration run
 * is a handful of calls for a whole lesson, but an audio run is ONE PAID CALL PER
 * SEGMENT. Four in flight keeps a forty-block lesson moving without turning a
 * single admin click into forty simultaneous requests against a rate limit.
 */
export const AUDIO_SEGMENT_CONCURRENCY = 4;

/**
 * Whole-run ceiling on segments, refused at precondition time.
 *
 * Also the memory bound on the merge, which holds every segment's decoded PCM at
 * once: 200 segments of ten seconds at 24 kHz mono is under 100 MB, which is why
 * capping the run is the answer rather than streaming the concatenation.
 */
export const AUDIO_RUN_MAX_SEGMENTS = 200;

/**
 * The four queues as data — the extraction the two notes above used to promise.
 *
 * WHAT WAS EXTRACTED, AND WHY ONLY THIS. P3's note predicted a shared shape at
 * the third queue; P4's deferred it again and named P5's audio queue as the
 * moment. P5 is that moment, and this is the whole of it: the parts that must
 * not drift between a producer in apps/api and a consumer in apps/worker — the
 * queue name, its environment override, the job-id prefix, how long finished
 * jobs are retained, and which §8.1 job_type an id falls back to.
 *
 * WHAT WAS NOT, and deliberately. The producers keep their own classes. They
 * still differ in more than their names — import carries two job names, a
 * Redis-cached dry-run result and no id prefix; image composes its prompt at
 * enqueue; narration and audio each hold a database-level in-flight lock, and
 * audio resolves a voice. A factory over four shapes that disagree would be
 * parameterised until it was longer than the four siblings it replaced. What
 * they share is construction and job options, and `BaseJobQueue` in
 * apps/api/src/jobs owns exactly that.
 *
 * ORDER IS LOAD-BEARING FOR CONSUMERS. The import queue's prefix is the empty
 * string, because P1 minted unprefixed ids and screens it shipped still hold
 * them — and `'anything'.startsWith('')` is always true. Anything resolving an
 * id must try the non-empty prefixes first and fall through to the empty one
 * last; `prefixedQueueDefinitions` and `unprefixedQueueDefinition` below exist
 * so no caller has to remember that.
 */
export type QueueKey = 'import' | 'image' | 'narration' | 'audio';

export interface QueueDefinition {
  readonly key: QueueKey;
  /** The default BullMQ queue name. */
  readonly name: string;
  /** Environment variable that overrides `name`, so a test can isolate a queue. */
  readonly envVar: string;
  /** Prepended to a BullMQ id to disambiguate it across queues. `''` for import. */
  readonly idPrefix: string;
  /** How long a finished job is retained, so a late subscriber still sees its terminal event. */
  readonly retentionSeconds: number;
  /** The §8.1 job_type to report when no generation_jobs row is found. */
  readonly fallbackJobType: JobType;
}

export const queueDefinitions: Readonly<Record<QueueKey, QueueDefinition>> = {
  import: {
    key: 'import',
    name: IMPORT_QUEUE_NAME,
    envVar: 'IMPORT_QUEUE_NAME',
    // Unprefixed, permanently: P1's screens hold ids in this format.
    idPrefix: '',
    // FR-IMP-02: a dry run's result lives in Redis for this long, and the job
    // must outlive it or the result outlives the job that explains it.
    retentionSeconds: DRY_RUN_RESULT_TTL_SECONDS,
    fallbackJobType: 'import_course_outline',
  },
  image: {
    key: 'image',
    name: IMAGE_QUEUE_NAME,
    envVar: 'IMAGE_QUEUE_NAME',
    idPrefix: 'image:',
    retentionSeconds: 3_600,
    fallbackJobType: 'generate_image',
  },
  narration: {
    key: 'narration',
    name: NARRATION_QUEUE_NAME,
    envVar: 'NARRATION_QUEUE_NAME',
    idPrefix: 'script:',
    retentionSeconds: 3_600,
    fallbackJobType: 'generate_narration_script',
  },
  audio: {
    key: 'audio',
    name: AUDIO_QUEUE_NAME,
    envVar: 'AUDIO_QUEUE_NAME',
    idPrefix: 'audio:',
    retentionSeconds: 3_600,
    fallbackJobType: 'generate_audio',
  },
} as const;

/** Every definition that qualifies its ids. Try these FIRST when resolving an id. */
export const prefixedQueueDefinitions: readonly QueueDefinition[] = Object.values(
  queueDefinitions,
).filter((definition) => definition.idPrefix !== '');

/**
 * The one definition whose ids carry no prefix, and therefore the fallback.
 *
 * Exactly one queue may be unprefixed; a second would make an unprefixed id
 * ambiguous with no way to tell. Asserted in test/queues.spec.ts.
 */
export const unprefixedQueueDefinition: QueueDefinition = queueDefinitions.import;
