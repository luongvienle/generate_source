import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { checkUpload, type UploadCheck } from './upload-safety';
import type { ImageMediaType } from './keys';

/**
 * FR-IMG-02 accepts SVG, and SVG is a script-bearing document format.
 *
 * The spec's rule is sanitize-on-upload: the CLEANED bytes are what gets
 * stored, so there is no path by which the original can be served and no
 * downstream renderer has to remember a rule.
 *
 * DOMPurify over jsdom rather than a hand-rolled allowlist. Writing a novel
 * sanitizer for a format designed to be extensible is how holes ship; this is
 * the one place the project prefers a well-trodden dependency to local code.
 * Both dependencies are server-only and must not leave this package —
 * packages/shared and packages/content are reachable from the browser.
 */
const purify = createDOMPurify(new JSDOM('').window);

export function sanitizeSvg(bytes: Uint8Array): Uint8Array {
  const source = Buffer.from(bytes).toString('utf8');

  const clean = purify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Parse as SVG rather than HTML, so the <svg> root survives as the root
    // rather than being treated as an element inside a document body.
    PARSER_MEDIA_TYPE: 'image/svg+xml',
  });

  return Uint8Array.from(Buffer.from(clean, 'utf8'));
}

export type PreparedUpload =
  | { readonly ok: true; readonly contentType: ImageMediaType; readonly bytes: Uint8Array }
  | Extract<UploadCheck, { ok: false }>;

/**
 * The one call an uploader makes: validate the bytes, then return the bytes
 * that are safe to store — identical for raster formats, sanitized for SVG.
 */
export function prepareUpload(bytes: Uint8Array): PreparedUpload {
  const checked = checkUpload(bytes);
  if (!checked.ok) return checked;

  const safe = checked.contentType === 'image/svg+xml' ? sanitizeSvg(bytes) : bytes;
  return { ok: true, contentType: checked.contentType, bytes: safe };
}
