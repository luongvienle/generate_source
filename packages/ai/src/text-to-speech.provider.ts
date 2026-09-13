/**
 * Speech synthesis behind an interface (§11's `TextToSpeechProvider`).
 *
 * The provider turns ONE segment's text into ONE audio file and reports what it
 * cost. It knows nothing about blocks, segments, offsets, merging or checksums —
 * those belong to the worker, which is what lets the fake be deterministic and
 * the real one be swapped without any caller changing.
 *
 * §6.4 chose per-segment synthesis so that an admin editing one block pays for
 * one segment rather than a whole lesson. That choice is why this interface is
 * singular: nothing here takes a list, and nothing here knows a lesson exists.
 */
export interface SynthesisRequest {
  /** One narration segment's text, already approved by an admin (§5.5). */
  readonly text: string;
  /** The course's configured voice (FR-AUDIO-03), resolved by the caller at enqueue. */
  readonly voiceIdentifier: string;
  /** The course's `languageCode`. Adapters that cannot use it ignore it. */
  readonly languageCode: string;
}

export interface SynthesisResult {
  readonly bytes: Uint8Array;
  /** Always `audio/mpeg` in P5 — see AUDIO_CONTENT_TYPE. */
  readonly contentType: string;
  /**
   * Echoed back rather than assumed, so a row records the voice that ACTUALLY
   * answered. FR-AUDIO-03 stores it precisely so a voice change is detectable.
   */
  readonly voiceIdentifier: string;
  readonly providerName: string;
  readonly modelName: string;
  /**
   * §6.4 asks for `total_character_count` per lesson audio and NFR-05 for TTS
   * character counts per lesson; nothing but the provider knows what it billed.
   *
   * Note the asymmetry with P4's token counts: a speech endpoint returns audio
   * bytes and no usage metadata, so an adapter derives this from the input it
   * sent. That is a property of the request, not an estimate — recorded here so
   * a reader does not look for a usage field that no provider returns.
   */
  readonly characterCount: number;
}

export interface TextToSpeechProvider {
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;

  /**
   * The most characters this provider accepts in one call.
   *
   * Declared rather than discovered: a segment over the limit fails the whole
   * run at PRECONDITION time with the offending blockId, instead of on attempt
   * three of a job that has already paid for everything before it.
   */
  readonly maxInputCharacters: number;
}

/** Injection token. A Symbol cannot collide with another provider's token. */
export const TEXT_TO_SPEECH_PROVIDER = Symbol('TextToSpeechProvider');

/**
 * The container P5 requests from every provider, decided once here rather than
 * per adapter.
 *
 * MP3 is asked for, but the merge never stream-copies it: every segment is
 * decoded to PCM, concatenated and encoded once, because MP3's per-file encoder
 * delay and end padding would otherwise accumulate at every boundary and drift
 * the offsets P7's highlight sync depends on. See apps/worker/src/audio/ffmpeg.ts.
 */
export const AUDIO_CONTENT_TYPE = 'audio/mpeg';

/**
 * FR-AUDIO-03: the voice a course narrates in, with the install default.
 *
 * NULL on the course means "use the install default", which is why §8's two
 * columns are nullable — "use the default" and "leave it alone" are different
 * requests and a PATCH must express both.
 *
 * Here rather than in apps/api since P6. The publish worker re-checks §6.5
 * staleness before writing the published track, and audio is stale when the
 * course's configured voice has moved on — so the worker needs this exact
 * resolution, and apps/worker never imports apps/api. The API's private copy was
 * a duplicate of `DEFAULT_OPENAI_VOICE` and is now this function.
 */
export function resolveCourseVoice(
  course: { voiceIdentifier: string | null; voiceProviderName: string | null },
  env: NodeJS.ProcessEnv = process.env,
): { voiceIdentifier: string; voiceProviderName: string } {
  return {
    voiceIdentifier: course.voiceIdentifier ?? env['TTS_DEFAULT_VOICE'] ?? DEFAULT_VOICE_IDENTIFIER,
    voiceProviderName: course.voiceProviderName ?? DEFAULT_VOICE_PROVIDER,
  };
}

/** Kept beside the resolver so the two cannot drift; mirrors packages/ai's OpenAI default. */
export const DEFAULT_VOICE_IDENTIFIER = 'alloy';
export const DEFAULT_VOICE_PROVIDER = 'openai';
