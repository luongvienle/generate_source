import { describe, expect, it } from 'vitest';
import { errorCodes } from '@knowledge-explorer/shared';
import { MAX_UPLOAD_BYTES, checkUpload, sniffImageType } from '../src/upload-safety';

/**
 * FR-IMG-02's accept list, decided from bytes alone. Every case here is a file
 * whose declared type and whose real type disagree, or could.
 */
const bytesOf = (...values: number[]) => Uint8Array.from(values);
const textOf = (value: string) => Uint8Array.from(Buffer.from(value, 'utf8'));

const png = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
const jpeg = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const webp = bytesOf(
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
);
const gif = textOf('GIF89a....');
const pdf = textOf('%PDF-1.7\n...');

describe('sniffImageType', () => {
  it('identifies each accepted type from its bytes', () => {
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(webp)).toBe('image/webp');
    expect(sniffImageType(textOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml',
    );
  });

  it('accepts SVG behind a BOM, an XML declaration, a DOCTYPE and comments', () => {
    const decorated =
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- exported by a drawing tool -->\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n' +
      '<!-- second comment -->\n' +
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(sniffImageType(textOf(decorated))).toBe('image/svg+xml');
  });

  it('refuses XML whose root element is not <svg>', () => {
    // The case that stops arbitrary XML being stored as an image.
    const notSvg = '<?xml version="1.0"?><catalog><item>x</item></catalog>';
    expect(sniffImageType(textOf(notSvg))).toBeUndefined();
  });

  it('refuses a type that is not on FR-IMG-02s list', () => {
    expect(sniffImageType(gif)).toBeUndefined();
    expect(sniffImageType(pdf)).toBeUndefined();
    expect(sniffImageType(bytesOf())).toBeUndefined();
  });

  it('refuses RIFF that is not WebP', () => {
    // RIFF also fronts WAV and AVI; the WEBP tag at offset 8 is what decides.
    const wav = bytesOf(
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    );
    expect(sniffImageType(wav)).toBeUndefined();
  });
});

describe('checkUpload', () => {
  it('accepts a valid image and reports its sniffed type', () => {
    expect(checkUpload(png)).toEqual({ ok: true, contentType: 'image/png' });
  });

  it('rejects a PDF regardless of what it was named', () => {
    // The "renamed .png" case: the filename never reaches this function.
    expect(checkUpload(pdf)).toEqual({
      ok: false,
      errorCode: errorCodes.IMAGE_TYPE_UNSUPPORTED,
    });
  });

  it('rejects a GIF, which FR-IMG-02 does not list', () => {
    expect(checkUpload(gif)).toEqual({
      ok: false,
      errorCode: errorCodes.IMAGE_TYPE_UNSUPPORTED,
    });
  });

  it('rejects a buffer over 5 MB before looking at its type', () => {
    const oversize = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    oversize.set(png, 0);
    expect(checkUpload(oversize)).toEqual({ ok: false, errorCode: errorCodes.IMAGE_TOO_LARGE });
  });

  it('accepts a buffer exactly at the ceiling', () => {
    const atLimit = new Uint8Array(MAX_UPLOAD_BYTES);
    atLimit.set(png, 0);
    expect(checkUpload(atLimit)).toEqual({ ok: true, contentType: 'image/png' });
  });
});
