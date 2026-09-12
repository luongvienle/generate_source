import { describe, expect, it } from 'vitest';
import { errorCodes } from '@knowledge-explorer/shared';
import { prepareUpload, sanitizeSvg } from '../src/sanitize-svg';
import { sniffImageType } from '../src/upload-safety';

const textOf = (value: string) => Uint8Array.from(Buffer.from(value, 'utf8'));
const stringOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

/**
 * The hostile fixture: every vector FR-IMG-02's accept list lets in, in one
 * file, alongside drawable content that must survive.
 */
const hostile = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="100" height="100" viewBox="0 0 100 100" onload="alert('onload')">
  <script>alert('script')</script>
  <rect x="10" y="10" width="50" height="50" fill="#336699" onclick="alert('onclick')"/>
  <circle cx="70" cy="70" r="20" fill="red"/>
  <a href="javascript:alert('href')"><text x="5" y="95">click</text></a>
  <foreignObject width="100" height="100">
    <body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://example.com"></iframe></body>
  </foreignObject>
  <image xlink:href="https://example.com/tracker.png" width="10" height="10"/>
</svg>`;

describe('sanitizeSvg', () => {
  const cleaned = stringOf(sanitizeSvg(textOf(hostile)));

  it('removes script elements', () => {
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain("alert('script')");
  });

  it('removes every event-handler attribute', () => {
    expect(cleaned).not.toContain('onload');
    expect(cleaned).not.toContain('onclick');
  });

  it('removes javascript: URLs', () => {
    expect(cleaned).not.toContain('javascript:');
  });

  it('removes foreignObject and the HTML it smuggles', () => {
    expect(cleaned).not.toContain('foreignObject');
    expect(cleaned).not.toContain('<iframe');
  });

  it('keeps the drawable content and the root element', () => {
    // Sanitizing must not silently hand back an empty picture.
    expect(cleaned).toContain('<svg');
    expect(cleaned).toContain('<rect');
    expect(cleaned).toContain('<circle');
    expect(cleaned).toContain('#336699');
  });

  it('returns bytes that still sniff as SVG', () => {
    // Storage records the sniffed type, so the cleaned bytes must keep it.
    expect(sniffImageType(sanitizeSvg(textOf(hostile)))).toBe('image/svg+xml');
  });

  it('is idempotent', () => {
    const once = sanitizeSvg(textOf(hostile));
    expect(stringOf(sanitizeSvg(once))).toBe(stringOf(once));
  });
});

describe('prepareUpload', () => {
  it('sanitizes SVG and reports the sanitized bytes, not the originals', () => {
    const prepared = prepareUpload(textOf(hostile));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.contentType).toBe('image/svg+xml');
    expect(stringOf(prepared.bytes)).not.toContain('<script');
    expect(prepared.bytes.byteLength).not.toBe(textOf(hostile).byteLength);
  });

  it('passes raster formats through byte-identically', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const prepared = prepareUpload(png);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(Buffer.from(prepared.bytes).equals(Buffer.from(png))).toBe(true);
  });

  it('refuses an unsupported type before sanitizing anything', () => {
    expect(prepareUpload(textOf('%PDF-1.7'))).toEqual({
      ok: false,
      errorCode: errorCodes.IMAGE_TYPE_UNSUPPORTED,
    });
  });
});
