/**
 * Where an ElevenLabs request goes, decided in one place.
 *
 * `ELEVENLABS_BASE_URL` is scenario's own variable, not the vendor's: the
 * ElevenLabs SDK reads no base-URL variable at all (checked against
 * `@elevenlabs/elevenlabs-js` 2.64.0), it takes a `baseUrl` constructor option.
 * Point it at a LangWatch AI Gateway and the signed-URL mint is checked against
 * the virtual key's budget and session cap and billed as one spend record, with
 * `apiKey` then carrying that virtual key. Leave it unset and every request goes
 * to ElevenLabs exactly as before.
 *
 * The conversation websocket the signed URL names still belongs to ElevenLabs,
 * so the media stream runs client to vendor and nothing about latency or the
 * wire protocol changes.
 *
 * **The variable covers the hosted ConvAI adapter only.** A LangWatch gateway
 * fronts one ElevenLabs REST route,
 * `GET /v1/convai/conversation/get-signed-url`, and answers `404 page not
 * found` for `/v1/speech-to-text` and `/v1/text-to-speech/{voiceId}` (measured
 * against gateway.langwatch.ai). So the speech-to-text and text-to-speech
 * leaves take an explicit `baseUrl` option and do not read the environment: a
 * variable set for the ConvAI demos would otherwise break every composed
 * ElevenLabs voice in the same process.
 */

/** The variable the hosted ConvAI adapter reads. Named once so it cannot drift. */
export const ELEVENLABS_BASE_URL_ENV = "ELEVENLABS_BASE_URL";

/** The key the hosted ConvAI adapter presents, when it is not the vendor's. */
export const ELEVENLABS_CONVAI_API_KEY_ENV = "ELEVENLABS_CONVAI_API_KEY";

/**
 * The base URL for a surface the gateway fronts: explicit value, else
 * `ELEVENLABS_BASE_URL`.
 */
export function resolveElevenLabsBaseUrl(explicit?: string): string | undefined {
  return normalizeElevenLabsBaseUrl(
    explicit ?? process.env[ELEVENLABS_BASE_URL_ENV],
  );
}

/**
 * The key the hosted ConvAI adapter presents: explicit value, else
 * `ELEVENLABS_CONVAI_API_KEY`, else `ELEVENLABS_API_KEY`.
 *
 * Two variables because a gateway and the vendor want different credentials
 * and one process runs both. `ELEVENLABS_BASE_URL` moves the ConvAI mint to a
 * gateway, which authenticates a LangWatch virtual key, while speech-to-text
 * and text-to-speech keep going to ElevenLabs, which authenticates an
 * ElevenLabs key. A single variable would have to be both.
 * `ELEVENLABS_CONVAI_API_KEY` is what pairs with `ELEVENLABS_BASE_URL`; unset,
 * the adapter falls back to `ELEVENLABS_API_KEY` and behaves exactly as before.
 */
export function resolveElevenLabsConvAIApiKey(explicit?: string): string {
  return (
    explicit ??
    process.env[ELEVENLABS_CONVAI_API_KEY_ENV] ??
    process.env.ELEVENLABS_API_KEY ??
    ""
  );
}

/**
 * Checks a base URL where the mistake is still readable.
 *
 * The one people make is including `/v1`. `OPENAI_BASE_URL` conventionally
 * does, and the ElevenLabs SDK appends `/v1` itself, so a base URL that carries
 * it produces `/v1/v1/convai/...` and a 404 that names no cause. An empty value
 * means unset, which leaves the SDK on its own default.
 */
export function normalizeElevenLabsBaseUrl(
  raw?: string,
): string | undefined {
  const trimmed = raw?.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`ElevenLabs baseUrl is not a URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // `new URL` accepts schemes the SDK cannot make a REST request over, so
    // parsing alone is not a check.
    throw new Error(`ElevenLabs baseUrl must be http or https: ${trimmed}`);
  }
  if (parsed.pathname.endsWith("/v1")) {
    throw new Error(
      `ElevenLabs baseUrl must not include /v1 (${trimmed}). ` +
        `The SDK appends it, so this would request /v1/v1/convai/... and 404.`,
    );
  }
  return trimmed;
}
