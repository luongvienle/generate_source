import { describe, expect, it } from 'vitest';
import {
  AUDIO_QUEUE_NAME,
  DRY_RUN_RESULT_TTL_SECONDS,
  IMAGE_QUEUE_NAME,
  IMPORT_QUEUE_NAME,
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  NARRATION_QUEUE_NAME,
  prefixedQueueDefinitions,
  queueDefinitions,
  unprefixedQueueDefinition,
  type QueueKey,
} from '../src/queues';

/**
 * The registry extracted at P5. These assertions exist because the values are
 * a contract between apps/api and apps/worker, and because one of them — the
 * empty import prefix — silently breaks id resolution if it is ever duplicated.
 */
describe('queueDefinitions', () => {
  it('declares the four queues P1 through P5 built', () => {
    expect(Object.keys(queueDefinitions).sort()).toEqual(
      (['audio', 'image', 'import', 'narration'] satisfies QueueKey[]).sort(),
    );
  });

  it('keeps each queue name as its own exported constant', () => {
    expect(queueDefinitions.import.name).toBe(IMPORT_QUEUE_NAME);
    expect(queueDefinitions.image.name).toBe(IMAGE_QUEUE_NAME);
    expect(queueDefinitions.narration.name).toBe(NARRATION_QUEUE_NAME);
    expect(queueDefinitions.audio.name).toBe(AUDIO_QUEUE_NAME);
  });

  it('qualifies every id prefix except import, which P1 shipped unprefixed', () => {
    expect(queueDefinitions.import.idPrefix).toBe('');
    expect(queueDefinitions.image.idPrefix).toBe('image:');
    expect(queueDefinitions.narration.idPrefix).toBe('script:');
    expect(queueDefinitions.audio.idPrefix).toBe('audio:');
  });

  /**
   * The one that bites. `'anything'.startsWith('')` is true, so a second
   * unprefixed queue would make an unprefixed id ambiguous with no way to tell
   * — and a consumer that checked prefixes in registry order would resolve
   * EVERY id to whichever unprefixed queue it reached first.
   */
  it('has exactly one unprefixed queue, and it is import', () => {
    const unprefixed = Object.values(queueDefinitions).filter((d) => d.idPrefix === '');
    expect(unprefixed).toHaveLength(1);
    expect(unprefixedQueueDefinition.key).toBe('import');
  });

  it('excludes the unprefixed queue from the prefixed list, so resolution order is safe', () => {
    expect(prefixedQueueDefinitions).toHaveLength(3);
    expect(prefixedQueueDefinitions.every((d) => d.idPrefix !== '')).toBe(true);
    expect(prefixedQueueDefinitions.map((d) => d.key).sort()).toEqual(['audio', 'image', 'narration']);
  });

  it('never gives two queues the same id prefix', () => {
    const prefixes = prefixedQueueDefinitions.map((d) => d.idPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('maps each queue to a distinct §8.1 job_type', () => {
    const types = Object.values(queueDefinitions).map((d) => d.fallbackJobType);
    expect(new Set(types).size).toBe(types.length);
    expect(queueDefinitions.audio.fallbackJobType).toBe('generate_audio');
  });

  it('retains import for the dry-run TTL, since its result outlives the job', () => {
    expect(queueDefinitions.import.retentionSeconds).toBe(DRY_RUN_RESULT_TTL_SECONDS);
  });

  it('keeps NFR-03 attempts and backoff shared rather than per queue', () => {
    expect(JOB_MAX_ATTEMPTS).toBe(3);
    expect(JOB_BACKOFF_DELAY_MS).toBeGreaterThan(0);
  });
});
