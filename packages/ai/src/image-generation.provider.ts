/**
 * Illustration candidates, behind an interface (§11).
 *
 * The provider turns a prompt into bytes. It touches no database, no queue and
 * no object storage — those belong to the worker that calls it, which is what
 * lets the fake be a pure function and the real one be swapped without any
 * caller changing.
 */
export interface ImageGenerationRequest {
  /**
   * The FULLY COMPOSED prompt, version marker and all. Composition is
   * image-prompt.ts's job, so a provider cannot silently apply house style of
   * its own and NFR-08's stored prompt is exactly what was sent.
   */
  readonly promptText: string;
  readonly candidateCount: number;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Stored per candidate by §6.2, so a row can always name what made it. */
  readonly modelName: string;
  readonly providerName: string;
}

export interface ImageGenerationProvider {
  generate(request: ImageGenerationRequest): Promise<readonly GeneratedImage[]>;
}

/** Injection token. A Symbol cannot collide with another provider's token. */
export const IMAGE_GENERATION_PROVIDER = Symbol('ImageGenerationProvider');

/** FR-IMG-01: "The request produces 2 to 4 candidates." */
export const MIN_CANDIDATE_COUNT = 2;
export const MAX_CANDIDATE_COUNT = 4;
export const DEFAULT_CANDIDATE_COUNT = 4;
