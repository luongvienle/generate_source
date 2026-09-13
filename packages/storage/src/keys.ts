/**
 * Object keys, minted in exactly one place.
 *
 * The writer (apps/worker, apps/api) and the reader (apps/api, presigning) must
 * agree byte for byte, so no caller concatenates a key by hand.
 *
 * `blockReferenceId` is in the path deliberately: FR-EDIT-02 makes a blockId
 * stable for the life of the block and never reissues a retired one, so a key
 * built from it can never be reused for a different figure.
 */

/** FR-IMG-02: the accepted upload formats, and what AI generation may return. */
export const imageMediaTypes = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
} as const;

export type ImageMediaType = keyof typeof imageMediaTypes;

export const imageMediaTypeList = Object.keys(imageMediaTypes) as readonly ImageMediaType[];

export function isImageMediaType(value: string): value is ImageMediaType {
  return Object.prototype.hasOwnProperty.call(imageMediaTypes, value);
}

/** The file extension for an accepted type. Total over ImageMediaType. */
export function extensionFor(contentType: ImageMediaType): string {
  return imageMediaTypes[contentType];
}

export interface ImageKeyParts {
  readonly lessonId: string;
  readonly blockReferenceId: string;
  readonly imageId: string;
  readonly contentType: ImageMediaType;
}

export function mintImageKey(parts: ImageKeyParts): string {
  const { lessonId, blockReferenceId, imageId, contentType } = parts;
  return `lessons/${lessonId}/${blockReferenceId}/${imageId}.${extensionFor(contentType)}`;
}

/**
 * Audio (P5). Two shapes, and the difference between them is load-bearing.
 *
 * A SEGMENT key is stable for the life of that segment's audio, because
 * FR-AUDIO-01 reuses unchanged segments across runs: run N+1 copies the previous
 * row's URL rather than re-synthesizing, so the object it points at must not move
 * or be overwritten. The id in the path is the audio_segments row's own id.
 *
 * A MERGED key is per RUN, qualified by the generation_jobs id. A regeneration
 * must not overwrite the bytes a presigned URL is currently serving — a learner
 * or an admin mid-listen would have the file change under them — so every run
 * writes a new object and the previous one is orphaned for P10 to reclaim, the
 * same rule P3 set for unselected image candidates.
 */
export const audioMediaTypes = {
  'audio/mpeg': 'mp3',
} as const;

export type AudioMediaType = keyof typeof audioMediaTypes;

export function isAudioMediaType(value: string): value is AudioMediaType {
  return Object.prototype.hasOwnProperty.call(audioMediaTypes, value);
}

export interface AudioSegmentKeyParts {
  readonly lessonId: string;
  readonly audioSegmentId: string;
}

export function mintAudioSegmentKey(parts: AudioSegmentKeyParts): string {
  return `lessons/${parts.lessonId}/audio/segments/${parts.audioSegmentId}.mp3`;
}

export interface MergedAudioKeyParts {
  readonly lessonId: string;
  readonly generationJobId: string;
}

export function mintMergedAudioKey(parts: MergedAudioKeyParts): string {
  return `lessons/${parts.lessonId}/audio/merged/${parts.generationJobId}.mp3`;
}
