import { describe, expect, it } from 'vitest';
import {
  extensionFor,
  imageMediaTypeList,
  isAudioMediaType,
  isImageMediaType,
  mintAudioSegmentKey,
  mintImageKey,
  mintMergedAudioKey,
  type ImageMediaType,
} from '../src/keys';

/**
 * Keys are the one thing the writer and the reader must agree on exactly, so
 * they are pinned here rather than left to whatever the implementation happens
 * to produce.
 */
describe('mintImageKey', () => {
  const base = {
    lessonId: '11111111-1111-1111-1111-111111111111',
    blockReferenceId: 'fig1',
    imageId: '22222222-2222-2222-2222-222222222222',
    contentType: 'image/png' as ImageMediaType,
  };

  it('places lesson, block and image in the path, with the type as extension', () => {
    expect(mintImageKey(base)).toBe(
      'lessons/11111111-1111-1111-1111-111111111111/fig1/22222222-2222-2222-2222-222222222222.png',
    );
  });

  it('gives two images of the same figure distinct keys', () => {
    const other = { ...base, imageId: '33333333-3333-3333-3333-333333333333' };
    expect(mintImageKey(other)).not.toBe(mintImageKey(base));
  });

  it('never collides across lessons that share a blockReferenceId', () => {
    // Every lesson numbers its own figures, so `fig1` is not unique on its own.
    const other = { ...base, lessonId: '44444444-4444-4444-4444-444444444444' };
    expect(mintImageKey(other)).not.toBe(mintImageKey(base));
  });

  it('never collides across figures within one lesson', () => {
    expect(mintImageKey({ ...base, blockReferenceId: 'fig2' })).not.toBe(mintImageKey(base));
  });

  it('follows the content type, not the filename', () => {
    expect(mintImageKey({ ...base, contentType: 'image/svg+xml' })).toMatch(/\.svg$/u);
    expect(mintImageKey({ ...base, contentType: 'image/jpeg' })).toMatch(/\.jpg$/u);
    expect(mintImageKey({ ...base, contentType: 'image/webp' })).toMatch(/\.webp$/u);
  });
});

describe('the accepted type list', () => {
  it('is exactly FR-IMG-02: PNG, JPEG, WebP, SVG', () => {
    expect([...imageMediaTypeList].sort()).toEqual([
      'image/jpeg',
      'image/png',
      'image/svg+xml',
      'image/webp',
    ]);
  });

  it('gives every accepted type an extension', () => {
    for (const type of imageMediaTypeList) {
      expect(extensionFor(type)).toMatch(/^[a-z]+$/u);
    }
  });

  it('rejects a type that is not on the list', () => {
    expect(isImageMediaType('image/gif')).toBe(false);
    expect(isImageMediaType('application/pdf')).toBe(false);
    expect(isImageMediaType('image/png')).toBe(true);
  });
});

describe('audio keys (P5)', () => {
  const lessonId = '11111111-1111-4111-8111-111111111111';

  it('mints a segment key from the segment row id, so reuse can copy a URL', () => {
    const key = mintAudioSegmentKey({ lessonId, audioSegmentId: 'seg-a' });
    expect(key).toBe(`lessons/${lessonId}/audio/segments/seg-a.mp3`);
  });

  /**
   * FR-AUDIO-01 reuses an unchanged segment by copying the previous row's URL.
   * That only works if the same segment id always mints the same key.
   */
  it('is stable across runs for the same segment id', () => {
    expect(mintAudioSegmentKey({ lessonId, audioSegmentId: 'seg-a' })).toBe(
      mintAudioSegmentKey({ lessonId, audioSegmentId: 'seg-a' }),
    );
  });

  it('separates segments of different lessons', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(mintAudioSegmentKey({ lessonId, audioSegmentId: 'seg-a' })).not.toBe(
      mintAudioSegmentKey({ lessonId: other, audioSegmentId: 'seg-a' }),
    );
  });

  /**
   * The opposite property for the merged file: a regeneration must NOT overwrite
   * the object a presigned URL is currently serving.
   */
  it('mints a DIFFERENT merged key for each run of the same lesson', () => {
    const first = mintMergedAudioKey({ lessonId, generationJobId: 'job-1' });
    const second = mintMergedAudioKey({ lessonId, generationJobId: 'job-2' });

    expect(first).toBe(`lessons/${lessonId}/audio/merged/job-1.mp3`);
    expect(first).not.toBe(second);
  });

  it('accepts audio/mpeg and refuses anything else', () => {
    expect(isAudioMediaType('audio/mpeg')).toBe(true);
    expect(isAudioMediaType('audio/wav')).toBe(false);
    expect(isAudioMediaType('image/png')).toBe(false);
  });
});
