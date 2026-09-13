import {
  AUDIO_CONTENT_TYPE,
  type SynthesisRequest,
  type SynthesisResult,
  type TextToSpeechProvider,
} from './text-to-speech.provider';

/**
 * OpenAI speech synthesis.
 *
 * Over `fetch` rather than the `openai` SDK, following P3's image adapter: the
 * only thing needed is one POST and a byte read, and NFR-03 already owns retry
 * and backoff at the job level, which is where a retry must be recorded anyway.
 * `packages/ai` depends on `@anthropic-ai/sdk` alone and does not gain a second
 * SDK here. (P5's spec claimed this package already carried the OpenAI SDK — it
 * does not, and never did; the conclusion was right for the wrong reason.)
 *
 * THE MODEL AND VOICE ARE PINNED, not defaulted at the call site.
 *
 * VERIFIED 2026-09-12 against developers.openai.com — the discipline §6.3
 * demands and P3 and P4 both follow:
 *   - models: `gpt-4o-mini-tts` (newest, supports speech control), `tts-1`,
 *     `tts-1-hd`;
 *   - voices for `gpt-4o-mini-tts`: alloy, ash, ballad, coral, echo, fable,
 *     nova, onyx, sage, shimmer, verse, marin, cedar — the documentation
 *     recommends `marin` or `cedar` for quality;
 *   - `input` is capped at 4096 characters, quoted as "The maximum length is
 *     4096 characters";
 *   - `response_format` accepts mp3 (default), opus, aac, flac, wav, pcm;
 *   - the response body is the audio file content, not JSON — which is why
 *     `characterCount` is derived from the input rather than read from a usage
 *     field that does not exist.
 *
 * PRICING WAS NOT VERIFIED in that pass and is not encoded here; it belongs to a
 * budget decision, not to this adapter, and §6.3's instruction to check it
 * applies to whoever sets `TTS_PROVIDER=openai` in a real deployment.
 *
 * `OPENAI_TTS_MODEL` and the course's configured voice override both without a
 * code change when that verification says something else.
 */
export const OPENAI_TTS_PROVIDER_NAME = 'openai';
export const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';

/** Documented cap on `input`, verified 2026-09-12. */
export const OPENAI_TTS_MAX_INPUT_CHARACTERS = 4_096;

/**
 * The default when a course has configured no voice and TTS_DEFAULT_VOICE is
 * unset. `alloy` rather than the documentation's preferred `marin`/`cedar`
 * because it is the long-standing identifier accepted by every listed model,
 * which makes it the safer fallback for an install that has not chosen.
 */
export const DEFAULT_OPENAI_VOICE = 'alloy';

/** Voices the verified documentation lists for `gpt-4o-mini-tts`. */
export const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

const SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';

export interface OpenAiTtsConfig {
  readonly apiKey: string;
  readonly model?: string;
  /** Overridable so the request and its parsing can be exercised against a local fixture server. */
  readonly endpoint?: string;
}

export class OpenAiTextToSpeechProvider implements TextToSpeechProvider {
  readonly maxInputCharacters = OPENAI_TTS_MAX_INPUT_CHARACTERS;

  private readonly model: string;
  private readonly endpoint: string;

  constructor(private readonly config: OpenAiTtsConfig) {
    this.model = config.model ?? DEFAULT_OPENAI_TTS_MODEL;
    this.endpoint = config.endpoint ?? SPEECH_ENDPOINT;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    /**
     * Checked HERE as well as at the API's precondition, and deliberately so:
     * the precondition refuses a run before it starts, but this is the last
     * point before a request that the endpoint would reject anyway. Throwing
     * without calling turns a wasted round trip into an immediate, named error.
     */
    if (request.text.length > this.maxInputCharacters) {
      throw new Error(
        `input of ${String(request.text.length)} characters exceeds OpenAI's documented maximum of ${String(this.maxInputCharacters)}`,
      );
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: request.text,
        voice: request.voiceIdentifier,
        // MP3 is the endpoint's default; naming it makes the container this
        // adapter promises explicit rather than inherited.
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      // The body carries the provider's reason; it lands in generation_jobs
      // .error_message and is what the audio tab shows the admin.
      throw new Error(`OpenAI speech synthesis failed (${String(response.status)}): ${await response.text()}`);
    }

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: AUDIO_CONTENT_TYPE,
      voiceIdentifier: request.voiceIdentifier,
      providerName: OPENAI_TTS_PROVIDER_NAME,
      modelName: this.model,
      // The endpoint returns audio, not JSON, so there is no usage field to
      // read. This is what was sent and therefore what was billed.
      characterCount: request.text.length,
    };
  }
}
