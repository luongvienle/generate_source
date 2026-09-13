import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import type { PrismaClient } from '@knowledge-explorer/database';
import { markUnpublishedChangesForLesson } from '@knowledge-explorer/database';
import {
  AUDIO_RUN_MAX_SEGMENTS,
  AUDIO_SEGMENT_CONCURRENCY,
  errorCodes,
  type GenerateAudioJobData,
} from '@knowledge-explorer/shared';
import { readScriptSegments } from '@knowledge-explorer/content';
import type { TextToSpeechProvider } from '@knowledge-explorer/ai';
import {
  mintAudioSegmentKey,
  mintMergedAudioKey,
  type ObjectStorage,
} from '@knowledge-explorer/storage';
import { mergeSegments } from '../audio/ffmpeg';

/**
 * FR-AUDIO-01: turn one generate_audio job into a merged lesson audio with
 * per-block offsets.
 *
 * THE WRITE IS ALL OR NOTHING, exactly as P4's narration run is, so an admin
 * meets one mental model rather than two. Bytes are held for the whole run and
 * the database is touched once, in a single transaction, only after every
 * segment is in hand and the merge has succeeded. A failed run sets
 * audio_status = 'failed' and leaves the merged URL, both checksums, the
 * duration, the character count and every audio_segments row untouched — so the
 * previous audio keeps playing and a `failed` row still serves it.
 *
 * The spend on the segments that did succeed is lost. That is the price of the
 * guarantee, and it is the one place P5 is more expensive than the alternative:
 * a partial set would have to be marked unservable and every reader taught about
 * it. See specs/p5-audio/spec.md for the rejected alternatives.
 *
 * WHAT THROWS AND WHAT DOES NOT, following P4:
 *   - a precondition that no longer holds throws UnrecoverableError, so BullMQ
 *     does not retry it and withJobLifecycle records the row failed on this
 *     attempt;
 *   - a provider or storage transport error propagates as an ordinary Error, so
 *     NFR-03's three attempts with exponential backoff apply.
 */
export function createAudioProcessor(
  prisma: PrismaClient,
  provider: TextToSpeechProvider,
  storage: ObjectStorage,
): (job: Job) => Promise<unknown> {
  return async (job: Job) => {
    const data = job.data as GenerateAudioJobData;
    const { lessonId, voiceIdentifier, voiceProviderName } = data;

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    /**
     * Clears the in-flight lock. Called on every terminal path INCLUDING a
     * transport failure on the last attempt — otherwise three timeouts would
     * leave audio_status = 'generating' forever and the lesson could never be
     * regenerated from the UI.
     */
    const markFailed = async (): Promise<void> => {
      await prisma.lessonAudio.updateMany({
        where: { lessonId },
        data: { audioStatus: 'failed' },
      });
    };

    try {
      /**
       * The course's language, for providers that can use it. OpenAI's speech
       * endpoint infers language from the text and takes no parameter for it, so
       * its adapter ignores this — but the port declares it, and passing a real
       * value costs one join and keeps the next adapter from receiving a lie.
       */
      const lesson = await prisma.lesson.findFirst({
        where: { id: lessonId, deletedAt: null },
        select: { chapter: { select: { course: { select: { languageCode: true } } } } },
      });
      if (!lesson) throw new UnrecoverableError(`lesson ${lessonId} no longer exists`);
      const languageCode = lesson.chapter.course.languageCode;

      const script = await prisma.narrationScript.findUnique({
        where: { lessonId },
        select: { scriptSegments: true, scriptChecksum: true, reviewedAt: true },
      });
      if (!script) throw new UnrecoverableError(errorCodes.AUDIO_SCRIPT_NOT_FOUND);

      // Re-checked here, not only at enqueue: a run that sat in the queue while
      // an admin withdrew approval must not spend anything.
      if (script.reviewedAt === null) {
        throw new UnrecoverableError(errorCodes.AUDIO_SCRIPT_NOT_APPROVED);
      }

      const segments = readScriptSegments(script.scriptSegments).segments;
      if (segments.length === 0) throw new UnrecoverableError(errorCodes.AUDIO_SCRIPT_NOT_FOUND);
      if (segments.length > AUDIO_RUN_MAX_SEGMENTS) {
        throw new UnrecoverableError(errorCodes.AUDIO_TOO_MANY_SEGMENTS);
      }

      const tooLong = segments.find(
        (segment) => segment.narrationText.length > provider.maxInputCharacters,
      );
      if (tooLong) {
        throw new UnrecoverableError(`${errorCodes.AUDIO_SEGMENT_TOO_LONG}: ${tooLong.blockId}`);
      }

      /**
       * THE REUSE PASS (FR-AUDIO-01's second bullet).
       *
       * A previous segment is reusable when its stored source_segment_checksum
       * still equals the script segment's checksum AND the row's voice matches
       * the voice this run was enqueued with. The voice clause is why a voice
       * change re-synthesizes everything: the text is unchanged but the audio is
       * not the audio anyone asked for.
       *
       * `source_segment_checksum` exists because §8 gave audio_segments nothing
       * linking a stored file to the text it voices — P5 added the column, and
       * without it this pass could not be written at all.
       */
      const previous = await prisma.lessonAudio.findFirst({
        where: { lessonId },
        include: { segments: true },
      });
      const reusable = new Map(
        previous?.voiceIdentifier === voiceIdentifier
          ? previous.segments
              .filter((row) => row.segmentAudioFileUrl !== null)
              .map((row) => [row.blockReferenceId, row])
          : [],
      );

      const plan = segments.map((segment) => {
        const candidate = reusable.get(segment.blockId);
        return candidate && candidate.sourceSegmentChecksum === segment.segmentChecksum
          ? { segment, reuse: candidate }
          : { segment, reuse: undefined };
      });

      const reusedCount = plan.filter((entry) => entry.reuse !== undefined).length;
      // Reused segments are done the moment the plan is made: a regeneration of
      // two segments in a forty-segment lesson shows 38/40 at once rather than
      // pretending to work.
      let done = reusedCount;
      await job.updateProgress({ done, total: segments.length });

      /**
       * Synthesis, bounded by NFR-03. Every call is paid, so the pool is small
       * and the results are indexed by position rather than pushed, keeping
       * playback order independent of completion order.
       */
      const bytes = new Array<Uint8Array>(plan.length);
      const keys = new Array<string>(plan.length);
      const checksums = new Array<string>(plan.length);
      let characterCount = 0;

      const toSynthesize = plan
        .map((entry, index) => ({ ...entry, index }))
        .filter((entry) => entry.reuse === undefined);

      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(AUDIO_SEGMENT_CONCURRENCY, Math.max(toSynthesize.length, 1)) },
        async () => {
          for (;;) {
            const next = cursor;
            cursor += 1;
            const entry = toSynthesize[next];
            if (!entry) return;

            const result = await provider.synthesize({
              text: entry.segment.narrationText,
              voiceIdentifier,
              languageCode,
            });

            const audioSegmentId = randomUUID();
            const key = mintAudioSegmentKey({ lessonId, audioSegmentId });
            await storage.put(key, result.bytes, result.contentType);

            bytes[entry.index] = result.bytes;
            keys[entry.index] = key;
            checksums[entry.index] = entry.segment.segmentChecksum;

            done += 1;
            await job.updateProgress({ done, total: segments.length });
          }
        },
      );
      await Promise.all(workers);

      // Reused segments are fetched once here, like any other segment: the merge
      // needs their bytes, but no provider call and no re-upload.
      for (const [index, entry] of plan.entries()) {
        if (!entry.reuse) continue;
        keys[index] = entry.reuse.segmentAudioFileUrl!;
        checksums[index] = entry.reuse.sourceSegmentChecksum;
        bytes[index] = await storage.get(entry.reuse.segmentAudioFileUrl!);
      }

      /**
       * §6.4's merge. Decodes every segment to PCM, concatenates and encodes
       * once — never a stream copy, which would drift the offsets. See
       * src/audio/ffmpeg.ts for the measurements behind that.
       */
      const merged = await mergeSegments(bytes);

      const mergedKey = mintMergedAudioKey({ lessonId, generationJobId: data.generationJobId });
      // Every object is written before any row, so a row never points at bytes
      // that are not there. The reverse — an object with no row — is a harmless
      // orphan that P10 reclaims, the rule P3 set for image candidates.
      await storage.put(mergedKey, merged.bytes, 'audio/mpeg');

      /**
       * §6.4 and NFR-05: the character count of the WHOLE script, not of the
       * segments this run happened to pay for. The column is singular and the row
       * is upserted every run, so it cannot track per-run billing; pretending
       * otherwise would make the number quietly wrong rather than merely coarse.
       * Per-run attribution belongs to generation_jobs and is P10's to present.
       */
      characterCount = segments.reduce(
        (total, segment) => total + segment.narrationText.length,
        0,
      );

      /**
       * ONE ROW PER LESSON. A voice change replaces the voice in place rather
       * than accumulating a second row, so UNIQUE (lesson_id, voice_identifier)
       * is satisfied trivially and never fires. §13 puts multiple voices per
       * course out of scope, and one row means every reader in P6, P7 and P8
       * needs no tie-break rule — a rule each of them could get wrong silently.
       */
      const completed = {
        voiceIdentifier,
        voiceProviderName,
        mergedAudioFileUrl: mergedKey,
        totalDurationSeconds: Math.round(merged.totalDurationMs / 1000),
        totalCharacterCount: characterCount,
        sourceScriptChecksum: script.scriptChecksum,
        audioStatus: 'ready',
      };

      await prisma.$transaction(async (tx) => {
        const row = previous
          ? await tx.lessonAudio.update({
              where: { id: previous.id },
              data: completed,
              select: { id: true },
            })
          : await tx.lessonAudio.create({
              data: { lessonId, ...completed },
              select: { id: true },
            });

        await tx.audioSegment.deleteMany({ where: { lessonAudioId: row.id } });
        await tx.audioSegment.createMany({
          data: plan.map((entry, index) => ({
            lessonAudioId: row.id,
            blockReferenceId: entry.segment.blockId,
            // P4 stored segmentOrder rather than deriving it from array
            // position precisely so this does not depend on JSON array ordering
            // surviving a round trip through Prisma's Json type.
            segmentOrder: entry.segment.segmentOrder,
            startMillisecond: merged.boundaries[index]!.startMillisecond,
            endMillisecond: merged.boundaries[index]!.endMillisecond,
            segmentAudioFileUrl: keys[index]!,
            sourceSegmentChecksum: checksums[index]!,
          })),
        });

        // FR-PUB-03 (P6): a completed run replaces what a listener hears, so a
        // published course now differs from the state its owner published.
        await markUnpublishedChangesForLesson(tx, lessonId);
      });

      return {
        segmentCount: segments.length,
        synthesized: segments.length - reusedCount,
        reused: reusedCount,
        totalDurationMs: merged.totalDurationMs,
        totalCharacterCount: characterCount,
      };
    } catch (error) {
      // A transport error on the last attempt is still terminal for the lesson:
      // without this the lock would survive every retry and wedge it.
      if (isFinalAttempt || error instanceof UnrecoverableError) await markFailed();
      throw error;
    }
  };
}
