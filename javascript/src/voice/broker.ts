/**
 * Minting a realtime voice session, at OpenAI or at a gateway in front of it.
 *
 * `POST /v1/realtime/client_secrets` is OpenAI's own path. A LangWatch AI
 * Gateway mirrors it: it checks the virtual key's budget and its open-session
 * cap, mints OpenAI's ephemeral client secret, and opens one spend record for
 * the call. The media socket still runs client to vendor in both cases, so
 * latency and the wire protocol are unchanged.
 *
 * That symmetry is the whole design. The adapter reads `OPENAI_BASE_URL` and
 * `OPENAI_API_KEY`, the two variables scenario already reads for chat, and
 * mints at `${OPENAI_BASE_URL}/realtime/client_secrets`. Point those at OpenAI
 * and the mint happens at OpenAI with a provider key. Point them at a gateway
 * and the mint happens through the broker with a virtual key. There is no
 * third URL, no third key, and no branch on who is answering. Anyone already
 * routing chat through a gateway gets voice with no new configuration.
 *
 * ElevenLabs needs nothing from this module: it mints over its own REST path,
 * so its official SDK reaches a gateway through the `baseUrl` option the SDK
 * already exposes.
 */

import { Logger } from "../utils/logger";

const logger = new Logger("scenario.voice.broker");

/** Where the mint request goes, and the key it carries. */
export interface RealtimeMintEndpoint {
  /** OpenAI-compatible base URL, including `/v1`, without a trailing slash. */
  baseUrl: string;
  /** The key the endpoint authenticates: a provider key, or a virtual key. */
  apiKey: string;
}

/** The vendor's default, used when `OPENAI_BASE_URL` is unset. */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

const MINT_PATH = "/realtime/client_secrets";
const usagePath = (sessionId: string) =>
  `/realtime/sessions/${encodeURIComponent(sessionId)}/usage`;

/** A gateway names the session it opened on this response header. OpenAI does not. */
const SESSION_ID_HEADER = "x-langwatch-session-id";

/**
 * How long a usage report may take before it is abandoned.
 *
 * `disconnect()` awaits the report, so an unbounded request holds the socket
 * open and the test that owns it never finishes. A report is worth a few
 * seconds and never worth a hang: the session still settles on the gateway's
 * own grace if it never arrives.
 */
const USAGE_REPORT_TIMEOUT_MS = 5_000;

/**
 * How long a mint may take before it is abandoned.
 *
 * `connect()` waits for this before it opens the socket, so an unbounded
 * request leaves connection setup pending forever against a stalled endpoint.
 * Generous rather than tight: a mint is a real round trip to a vendor, and a
 * session refused for slowness costs a call that would have worked.
 */
const MINT_TIMEOUT_MS = 15_000;

/**
 * What a mint attempt produced.
 *
 * `sessionId` is empty unless a gateway answered, because only a gateway
 * carries {@link SESSION_ID_HEADER}. An empty id therefore means the vendor
 * minted the credential itself and there is no session to report usage to.
 */
export type RealtimeMintResult =
  | { minted: true; clientSecret: string; sessionId: string }
  | { minted: false; status: number };

/** Token counts a realtime socket reported, in the vendor's own shape. */
export type RealtimeUsage = Record<string, unknown>;

/**
 * Resolves where to mint, or null when there is no key to mint with.
 *
 * `OPENAI_REALTIME_API_KEY` is deliberately not consulted here. That variable
 * holds a direct provider key for the socket, and presenting it to a gateway
 * would offer a credential the gateway did not issue and cannot bill. It stays
 * what it already was: the fallback for dialing the vendor directly.
 */
export function resolveRealtimeMintEndpoint(
  explicit?: Partial<RealtimeMintEndpoint>,
): RealtimeMintEndpoint | null {
  const apiKey = explicit?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) return null;
  const baseUrl =
    explicit?.baseUrl ?? process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

/**
 * Mints a realtime session, and reports whether the route existed.
 *
 * A 404 means the base URL points at something with no mint route, which is
 * what a LangWatch gateway older than this feature answers. That is an absence,
 * so the caller may fall back to dialing the vendor directly. Any other error
 * status is a refusal by an endpoint that does have the route, such as an
 * exhausted budget or a rejected model, and it raises. Falling back on a
 * refusal would spend a direct provider key on a call the gateway just
 * declined to bill.
 */
export async function mintOpenAIRealtimeSession(
  endpoint: RealtimeMintEndpoint,
  params: {
    model: string;
    expiresAfterSeconds?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<RealtimeMintResult> {
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

  const response = await doFetch(`${endpoint.baseUrl}${MINT_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(params.timeoutMs ?? MINT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (response.status === 404) return { minted: false, status: 404 };
  if (!response.ok) {
    // The endpoint's own message is the useful one: it names the budget, the
    // session cap or the missing provider far more precisely than a status.
    throw new Error(
      `realtime mint failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("realtime mint returned a body that is not JSON");
  }

  const clientSecret = readClientSecret(parsed);
  if (!clientSecret) {
    throw new Error("realtime mint returned no client secret");
  }
  return {
    minted: true,
    clientSecret,
    sessionId: response.headers.get(SESSION_ID_HEADER) ?? "",
  };
}

/**
 * Reports what the socket measured, closing the session's spend record.
 *
 * OpenAI reports usage over the socket, in `response.done`, and that socket
 * runs client to vendor, so this is the only path by which those numbers reach
 * a gateway. A session that never reports is not lost: the gateway settles it
 * as cost-unknown once its grace expires.
 *
 * Never throws. A failed report costs accuracy on one session, and raising here
 * would fail a test whose subject is the agent, not the billing.
 */
export async function reportOpenAIRealtimeUsage(
  endpoint: RealtimeMintEndpoint,
  params: {
    sessionId: string;
    usage: RealtimeUsage;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  // No session id means the vendor minted this credential, so there is no
  // spend record anywhere to close.
  if (!params.sessionId) return;
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const response = await doFetch(
      `${endpoint.baseUrl}${usagePath(params.sessionId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ usage: params.usage }),
        signal: AbortSignal.timeout(
          params.timeoutMs ?? USAGE_REPORT_TIMEOUT_MS,
        ),
      },
    );
    // A refused report is a failure that answers. Reading only the thrown
    // case would treat a 404 for an unknown session, or a 401 for a rotated
    // key, as a report that landed, and the session would settle as
    // cost-unknown with nobody told why.
    if (!response.ok) {
      params.onError?.(
        new Error(`realtime usage report refused with HTTP ${response.status}`),
      );
    }
  } catch (error) {
    params.onError?.(error);
  }
}

/**
 * Warns that a mint route was absent and a direct provider key is in use.
 *
 * Loud on purpose. A silent fall back to a direct key looks exactly like a
 * successful brokered run while producing no spend record at all, so a test
 * run that proved nothing would read as a run that proved everything.
 *
 * `credentialSource` names where the key being dialled came from, because the
 * adapter reads three in order and naming a fixed one sends the reader to a
 * variable that is not set.
 */
export function warnDirectDialFallback(
  baseUrl: string,
  credentialSource: string,
): void {
  logger.warn(
    `realtime mint route not found at ${baseUrl}${MINT_PATH}; dialing the ` +
      `vendor directly with ${credentialSource}. This session is not ` +
      `billed or budgeted by the gateway at ${baseUrl}.`,
  );
}

/**
 * The credential, wherever the mint put it.
 *
 * OpenAI returns `{ value }` at the top level today and has previously nested
 * it under `client_secret`, so both are read rather than pinning the adapter to
 * one release's shape.
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
