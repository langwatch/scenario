/**
 * Brokered realtime voice sessions.
 *
 * A voice gateway can broker a realtime session instead of relaying it: the
 * client presents a virtual key, the gateway checks the budget and mints the
 * vendor's own short-lived session credential, and the media socket then runs
 * client to vendor directly. Audio never crosses the gateway, so latency is
 * unchanged, and the session still lands on one spend record.
 *
 * Two vendors reach a broker differently, which is why only OpenAI needs this
 * module:
 *
 * - ElevenLabs mints through its own REST path, so pointing the official SDK
 *   at the gateway's base URL is the whole change (see `baseUrl` on
 *   {@link ElevenLabsAgentAdapterOptions}).
 * - OpenAI Realtime dials a websocket with a bearer token and has no mint step
 *   of its own, so the caller performs the mint, dials with the credential it
 *   returns, and reports what the socket measured when the session ends.
 *
 * Brokering is opt-in. With no broker configured every adapter connects
 * straight to its vendor exactly as before.
 */

/** Where to mint, and the key to mint with. */
export interface VoiceBrokerConfig {
  /** Gateway base URL, without a trailing slash. */
  baseUrl: string;
  /** The virtual key the gateway authenticates and bills. */
  apiKey: string;
}

/** A minted session: the vendor credential, and the id the gateway bills. */
export interface BrokeredRealtimeSession {
  /** The vendor's own short-lived credential, used as the socket's bearer. */
  clientSecret: string;
  /**
   * The gateway's id for this session, or "" when it did not name one. Usage
   * is reported against it, so an empty id means the session cannot be
   * closed by report and settles on the gateway's own grace instead.
   */
  sessionId: string;
}

/** Token counts a realtime socket reported, in the vendor's own shape. */
export type RealtimeUsage = Record<string, unknown>;

const MINT_PATH = "/v1/realtime/client_secrets";
const USAGE_PATH = (sessionId: string) =>
  `/v1/realtime/sessions/${encodeURIComponent(sessionId)}/usage`;

/** The gateway names the session it billed on this response header. */
const SESSION_ID_HEADER = "x-langwatch-session-id";

/**
 * Resolves broker configuration, or null when brokering is off.
 *
 * The base URL is what turns brokering on; there is no separate flag, because
 * a broker with no address is not a configuration anyone meant. The key falls
 * back to `OPENAI_API_KEY` because a gateway user already puts their virtual
 * key there.
 *
 * `OPENAI_REALTIME_API_KEY` is deliberately NOT consulted. That variable
 * exists to hold a direct provider key, so reading it here would mint with a
 * credential the gateway does not issue and cannot bill.
 */
export function resolveVoiceBroker(
  explicit?: Partial<VoiceBrokerConfig>,
): VoiceBrokerConfig | null {
  const baseUrl =
    explicit?.baseUrl ?? process.env.LANGWATCH_VOICE_BROKER_URL ?? "";
  if (!baseUrl) return null;
  const apiKey =
    explicit?.apiKey ??
    process.env.LANGWATCH_VOICE_BROKER_KEY ??
    process.env.OPENAI_API_KEY ??
    "";
  if (!apiKey) {
    throw new Error(
      "voice broker: a base URL is set but no key. Set " +
        "LANGWATCH_VOICE_BROKER_KEY (or OPENAI_API_KEY) to the virtual key " +
        "the gateway should bill.",
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

/**
 * Mints an OpenAI realtime session through the gateway.
 *
 * The body is OpenAI's own, so the gateway forwards it as written apart from
 * resolving the model against the key's allowlist. What comes back is
 * OpenAI's ephemeral client secret, which authenticates a server-side
 * websocket as a bearer token.
 */
export async function mintOpenAIRealtimeSession(
  broker: VoiceBrokerConfig,
  params: { model: string; expiresAfterSeconds?: number; fetchImpl?: typeof fetch },
): Promise<BrokeredRealtimeSession> {
  const doFetch = params.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    session: { type: "realtime", model: params.model },
  };
  if (params.expiresAfterSeconds !== undefined) {
    body.expires_after = {
      anchor: "created_at",
      seconds: params.expiresAfterSeconds,
    };
  }

  const response = await doFetch(`${broker.baseUrl}${MINT_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${broker.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    // The gateway's own message is the useful one: it names a budget, a
    // session cap or a missing provider far more precisely than a status.
    throw new Error(
      `voice broker: mint failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("voice broker: mint returned a body that is not JSON");
  }

  const clientSecret = readClientSecret(parsed);
  if (!clientSecret) {
    throw new Error("voice broker: mint returned no client secret");
  }
  return {
    clientSecret,
    sessionId:
      response.headers.get(SESSION_ID_HEADER) ?? readEchoedSessionId(parsed),
  };
}

/**
 * Reports what the socket measured, closing the session's spend record.
 *
 * OpenAI reports usage over the socket, in `response.done`, and that socket
 * runs client to vendor, so this is the only path by which those numbers
 * reach the gateway. A session that never reports is not lost: the gateway
 * settles it as cost-unknown once its grace expires.
 *
 * Never throws. A failed report costs accuracy on one session, and raising
 * here would fail a test whose subject is the agent, not the billing.
 */
export async function reportOpenAIRealtimeUsage(
  broker: VoiceBrokerConfig,
  params: {
    sessionId: string;
    usage: RealtimeUsage;
    fetchImpl?: typeof fetch;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  if (!params.sessionId) return;
  const doFetch = params.fetchImpl ?? fetch;
  try {
    await doFetch(`${broker.baseUrl}${USAGE_PATH(params.sessionId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${broker.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ usage: params.usage }),
    });
  } catch (error) {
    params.onError?.(error);
  }
}

/**
 * The credential, wherever the mint put it.
 *
 * OpenAI returns `{ value }` at the top level today and has previously
 * nested it under `client_secret`, so both are read rather than pinning the
 * adapter to one release's shape.
 */
function readClientSecret(body: Record<string, unknown>): string {
  if (typeof body.value === "string" && body.value) return body.value;
  const nested = body.client_secret;
  if (
    nested &&
    typeof nested === "object" &&
    typeof (nested as Record<string, unknown>).value === "string"
  ) {
    return (nested as Record<string, unknown>).value as string;
  }
  return "";
}

/** The session id the gateway echoes into the body, for clients that read it there. */
function readEchoedSessionId(body: Record<string, unknown>): string {
  const langwatch = body.langwatch;
  if (
    langwatch &&
    typeof langwatch === "object" &&
    typeof (langwatch as Record<string, unknown>).session_id === "string"
  ) {
    return (langwatch as Record<string, unknown>).session_id as string;
  }
  return "";
}
