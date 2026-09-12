import { errorCodes } from '@knowledge-explorer/shared';
import { isImageMediaType, type ImageMediaType } from './keys';

/**
 * FR-IMG-02: accept PNG, JPEG, WebP and SVG, at most 5 MB.
 *
 * The type is decided by the bytes themselves. A declared Content-Type and a
 * filename are both attacker-controlled and neither is consulted anywhere here.
 *
 * Lives beside the code that writes bytes rather than in apps/api, so "anything
 * that reached storage was validated" is a property of one module instead of a
 * rule every caller has to remember. P5 and P8 write media too.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type UploadRejection =
  | typeof errorCodes.IMAGE_TYPE_UNSUPPORTED
  | typeof errorCodes.IMAGE_TOO_LARGE;

export type UploadCheck =
  | { readonly ok: true; readonly contentType: ImageMediaType }
  | { readonly ok: false; readonly errorCode: UploadRejection };

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

/** 89 50 4E 47 0D 0A 1A 0A */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** FF D8 FF — SOI plus the first marker. */
const JPEG = [0xff, 0xd8, 0xff];
/** "RIFF" at 0 and "WEBP" at 8; the four bytes between are the file size. */
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * SVG is XML, so there is no magic number — the root element is the signature.
 *
 * Everything XML allows before that root is skipped explicitly: a BOM,
 * whitespace, the XML declaration, a DOCTYPE and any number of comments. A
 * document whose first element is anything but <svg> is not an SVG, which is
 * what stops an arbitrary XML payload from being stored as one.
 */
const looksLikeSvg = (bytes: Uint8Array): boolean => {
  // Only the head can matter, and decoding a 5 MB buffer to find "<svg" is waste.
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('utf8');
  let rest = head.replace(/^﻿/u, '').trimStart();

  for (;;) {
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end === -1) return false;
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end === -1) return false;
      rest = rest.slice(end + 3).trimStart();
      continue;
    }
    if (rest.startsWith('<!DOCTYPE') || rest.startsWith('<!doctype')) {
      const end = rest.indexOf('>');
      if (end === -1) return false;
      rest = rest.slice(end + 1).trimStart();
      continue;
    }
    break;
  }

  return /^<svg[\s>]/iu.test(rest);
};

/** The sniffed type, or undefined when the bytes are none of the four. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return undefined;
}

/**
 * Size first, then type: an oversize buffer is refused without being decoded,
 * and the caller's interceptor should have refused it earlier still.
 */
export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, errorCode: errorCodes.IMAGE_TOO_LARGE };
  }

  const contentType = sniffImageType(bytes);
  if (!contentType || !isImageMediaType(contentType)) {
    return { ok: false, errorCode: errorCodes.IMAGE_TYPE_UNSUPPORTED };
  }

  return { ok: true, contentType };
}
