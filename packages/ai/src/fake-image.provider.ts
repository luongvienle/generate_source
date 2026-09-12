import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type {
  GeneratedImage,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from './image-generation.provider';

/**
 * The default provider: real PNGs, no network, no cost, byte-stable.
 *
 * CI runs against this, which is what makes the image suites deterministic and
 * lets a contributor with no API key run everything. It emits genuinely valid
 * PNGs rather than placeholder bytes, because the browser suite displays them
 * and an `<img>` with an undecodable source would pass a DOM assertion while
 * showing a broken icon.
 *
 * Determinism is the contract: the same prompt and index always produce the
 * same bytes, and two indexes of one request always differ.
 */

export const FAKE_PROVIDER_NAME = 'fake';
export const FAKE_MODEL_NAME = 'fake-deterministic-v1';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
};

/** A solid-colour PNG. Small, valid, and different for every colour. */
function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline, then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = rgb[0];
      raw[pixel + 1] = rgb[1];
      raw[pixel + 2] = rgb[2];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Fixed level, so the compressed bytes are reproducible run to run.
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export class FakeImageProvider implements ImageGenerationProvider {
  async generate(request: ImageGenerationRequest): Promise<readonly GeneratedImage[]> {
    return Array.from({ length: request.candidateCount }, (_, index): GeneratedImage => {
      const digest = createHash('sha256').update(`${request.promptText}#${index}`).digest();
      const rgb: [number, number, number] = [
        digest[0] as number,
        digest[1] as number,
        digest[2] as number,
      ];

      return {
        bytes: Uint8Array.from(solidPng(64, rgb)),
        contentType: 'image/png',
        modelName: FAKE_MODEL_NAME,
        providerName: FAKE_PROVIDER_NAME,
      };
    });
  }
}
