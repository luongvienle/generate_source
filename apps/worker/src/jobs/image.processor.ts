import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@knowledge-explorer/database';
import type { GenerateImageJobData } from '@knowledge-explorer/shared';
import type { ImageGenerationProvider } from '@knowledge-explorer/ai';
import {
  isImageMediaType,
  mintImageKey,
  type ObjectStorage,
} from '@knowledge-explorer/storage';

/**
 * FR-IMG-01: turn one generate_image job into 2-4 candidate rows.
 *
 * ORDER MATTERS. Every object is written before any row is inserted, so a row
 * never points at bytes that are not there. The reverse — an object with no row
 * — is a harmless orphan that P10 reclaims. A provider call that throws writes
 * nothing at all.
 *
 * APPEND-ON-RETRY IS DELIBERATE. If the provider succeeds and a later object
 * write fails, the retry generates a fresh set and the block ends up with more
 * candidates than were asked for. That follows from the never-replace rule the
 * spec chose: duplicates are visible and harmless, whereas a destructive
 * replace could delete a candidate the admin had already picked. Do not "fix"
 * this into a replace.
 */
export function createImageProcessor(
  prisma: PrismaClient,
  provider: ImageGenerationProvider,
  storage: ObjectStorage,
): (job: Job) => Promise<unknown> {
  return async (job: Job) => {
    const data = job.data as GenerateImageJobData;

    const images = await provider.generate({
      promptText: data.composedPrompt,
      candidateCount: data.candidateCount,
    });

    const rows = [];
    for (const image of images) {
      if (!isImageMediaType(image.contentType)) {
        // A provider handing back something unstorable is a bug worth failing
        // on, not something to coerce into a key with the wrong extension.
        throw new Error(`Provider returned an unsupported content type: ${image.contentType}`);
      }

      const imageId = randomUUID();
      const key = mintImageKey({
        lessonId: data.lessonId,
        blockReferenceId: data.blockReferenceId,
        imageId,
        contentType: image.contentType,
      });

      await storage.put(key, image.bytes, image.contentType);

      rows.push({
        id: imageId,
        lessonId: data.lessonId,
        blockReferenceId: data.blockReferenceId,
        imageFileUrl: key,
        // §8 makes both NOT NULL; a candidate has neither until it is chosen.
        captionText: '',
        alternativeText: '',
        imageSource: 'ai_generated',
        // NFR-08: the stored prompt is the composed one, version marker and all.
        imagePromptText: data.composedPrompt,
        imageModelName: image.modelName,
        imageProviderName: image.providerName,
        isSelected: false,
        // §8 makes created_by_user_id nullable. Coercing an absent value to
        // null keeps a payload without an author from failing the whole job
        // three times with an opaque uuid-syntax error from Postgres.
        createdByUserId: data.createdByUserId || null,
        // figure_number stays NULL: §6.1 numbers figures during block
        // extraction "and nowhere else".
      });
    }

    await prisma.lessonImage.createMany({ data: rows });

    return { candidatesCreated: rows.length };
  };
}
