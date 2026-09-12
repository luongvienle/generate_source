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
