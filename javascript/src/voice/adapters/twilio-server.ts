/**
 * TwilioWebhookServer — local HTTP + WS server that impersonates Twilio's
 * webhook + Media Streams endpoints. TypeScript port of
 * `python/scenario/voice/adapters/_twilio_server.py`.
 *
 * Two routes:
 * - `POST /twilio/voice` returns `<Connect><Stream>` TwiML pointing at our
 *   own WS URL. Validates `X-Twilio-Signature` when the parent adapter has
 *   `validateSignature=true`.
 * - `WS /twilio/stream` is the Media Streams socket — receives start/media/
 *   stop/dtmf/mark frames, decodes µ-law into PCM16 chunks, hands them to
 *   the adapter.
 *
 * The server uses node's built-in `http` for the request listener and the
 * `ws` npm package for the WebSocket upgrade. Both default to binding on an
 * OS-assigned port so tests don't race over hard-coded ports.
 */

import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { Context } from "@opentelemetry/api";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import { AudioChunk } from "../audio-chunk";
import { voiceReceiveSpanUnder } from "../telemetry";

import type { TwilioAgentAdapter } from "./twilio";
import { twilioLogger } from "./twilio-logger";
import {
  escapeXmlAttr,
  mulaw8kToPcm16_24k,
  nonceMatches,
  parseMediaStreamFrame,
  redactE164,
  streamWsUrl,
  verifyTwilioSignature,
  type MediaStreamEvent,
} from "./twilio-shared";

/**
 * Maximum request body the webhook reader will accept. Twilio's voice
 * webhook bodies are ~1 KB form-encoded; this is generous head-room.
 * Rejecting larger bodies guards against OOM from an attacker who probes
 * the publicly-tunneled endpoint with a multi-GB POST.
 */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

/**
 * Minimal WS interface used by the media-stream loop. The full `ws.WebSocket`
 * class implements this, and tests can mock with a 30-line stub.
 */
export interface MediaStreamWebSocket {
  send(data: string | Uint8Array): void;
  /** Iterate received text frames. Resolves to `null` when the socket closes. */
  receiveText(): Promise<string | null>;
  close(): void;
}

/**
 * Outcome of the a-leg `start`-frame auth check: adopt the socket, drop this
 * frame but keep listening, or close the socket.
 */
type StartFrameVerdict = "accept" | "ignore" | "reject";

const BATCH_MS = 100;
const TWILIO_FRAME_MS = 20;

export class TwilioWebhookServer {
  private readonly _adapter: TwilioAgentAdapter;
  private _http: Server | null = null;
  private _wss: WebSocketServer | null = null;
  private _socketTracker = new Set<Socket>();
  private _boundPort: number | null = null;

  constructor(adapter: TwilioAgentAdapter) {
    this._adapter = adapter;
  }

  /** OS-bound address `http://127.0.0.1:<port>` after `start()` has resolved. */
  get baseUrl(): string {
    if (this._boundPort == null) {
      throw new Error("TwilioWebhookServer: server is not running.");
    }
    return `http://127.0.0.1:${this._boundPort}`;
  }

  get boundPort(): number {
    if (this._boundPort == null) {
      throw new Error("TwilioWebhookServer: server is not running.");
    }
    return this._boundPort;
  }

  async start(): Promise<void> {
    if (this._http) return;
    const http = createServer((req, res) => this._handleRequest(req, res));
    const wss = new WebSocketServer({ noServer: true });

    http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/twilio/stream") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws) => {
      void this._handleStreamSocket(ws);
    });

    // Track raw sockets so stop() can force-close keep-alive connections
    // (otherwise `server.close()` blocks until each socket idles out).
    http.on("connection", (sock) => {
      this._socketTracker.add(sock);
      sock.once("close", () => this._socketTracker.delete(sock));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      http.once("error", onError);
      http.listen(this._adapter.httpPort, "127.0.0.1", () => {
        http.off("error", onError);
        const address = http.address() as AddressInfo;
        this._boundPort = address.port;
        resolve();
      });
    });

    this._http = http;
    this._wss = wss;
  }

  async stop(): Promise<void> {
    if (!this._http) return;
    const http = this._http;
    const wss = this._wss;
    this._http = null;
    this._wss = null;
    this._boundPort = null;

    // Close active WebSockets so the WSS shutdown completes.
    if (wss) {
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          // Ignored.
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    // Force-close keep-alive sockets so `server.close()` doesn't hang.
    for (const sock of this._socketTracker) sock.destroy();
    this._socketTracker.clear();
    await new Promise<void>((resolve, reject) => {
      http.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // --- routing ---------------------------------------------------------------

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "POST" && url.pathname === "/twilio/voice") {
      await this._handleVoiceWebhook(req, res, url);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }

  private async _handleVoiceWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const adapter = this._adapter;
    // Webhook visibility counter (#775 disconnect T3): the media-stream WS
    // loop has no direct span (frozen-ctx + flood hazard), so a
    // misconfigured/rejected webhook shows up as a `voice.adapter.dial`
    // stream_connect_timeout with no obvious cause. This counter — stamped
    // onto `voice.adapter.disconnect` — closes that gap without a
    // per-request span.
    adapter._recordWebhookInvocation();
    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      twilioLogger.warn("webhook body rejected", {
        reason: err instanceof Error ? err.message : "unknown",
      });
      res.statusCode = 413;
      res.end("payload too large");
      return;
    }
    const params = parseFormUrlEncoded(body);

    if (adapter.validateSignature) {
      const fullUrl = `${adapter.publicBaseUrl?.replace(/\/$/, "") ?? this.baseUrl}${url.pathname}`;
      const valid = await verifyTwilioSignature({
        authToken: adapter.authToken,
        url: fullUrl,
        params,
        signature: req.headers["x-twilio-signature"] as string | undefined,
      });
      if (!valid) {
        adapter._onWebhookRejected();
        twilioLogger.warn("rejecting voice webhook — missing or invalid X-Twilio-Signature", {
          from: redactE164(params.From),
        });
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
    }

    const fromNumber = params.From ?? "";
    if (adapter.allowedCallers && !adapter.allowedCallers.has(fromNumber)) {
      adapter._onWebhookRejected();
      twilioLogger.info("rejecting call from disallowed caller", {
        from: redactE164(fromNumber),
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/xml");
      res.end("<Response><Reject/></Response>");
      return;
    }

    if (!adapter.publicBaseUrl) {
      res.statusCode = 500;
      res.end("publicBaseUrl is not set on the adapter");
      return;
    }
    const wsUrl = streamWsUrl(adapter.publicBaseUrl);
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect><Stream url="${escapeXmlAttr(wsUrl)}"/></Connect></Response>`;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/xml");
    res.end(twiml);
  }

  private async _handleStreamSocket(ws: WsWebSocket): Promise<void> {
    await this.runStreamSession(adaptWsSocket(ws));
  }

  /**
   * Production per-connection wrapper around {@link mediaStreamLoop}: runs the
   * loop, then — in a `finally` that fires on stop, socket close, OR a throw —
   * nulls the adapter's `_streamWs`/`_streamSid` transport state, exactly as the
   * real `/twilio/stream` handler does after a call ends.
   *
   * This is the seam tests must drive to reproduce the #695 teardown race: the
   * terminal sentinel is enqueued inside the loop's own `finally`, then THIS
   * `finally` nulls the transport — so a `receiveAudio` following the reset must
   * still drain cleanly. Driving `mediaStreamLoop` alone skips this reset and
   * hides the bug (that was the shipped tests' flaw, PR #697 P2 blocker).
   *
   * @internal Production entry is `_handleStreamSocket`; tests reach this via
   * `TwilioAgentAdapter._driveStreamSession`. Not public API.
   */
  async runStreamSession(ws: MediaStreamWebSocket): Promise<void> {
    try {
      await this.mediaStreamLoop(ws);
    } finally {
      // Only the socket that IS the live transport may clear it. The route is
      // publicly reachable, so without this identity check any stranger who
      // opens and closes `/twilio/stream` nulls the GENUINE call's transport —
      // no nonce needed — and every subsequent sendAudio/interrupt/receiveAudio
      // throws "no live media stream" while the PSTN call keeps billing to the
      // cap.
      if (this._adapter._streamWsForServer === ws) {
        this._adapter._setStreamWs(null);
        this._adapter._setStreamSid(undefined);
      }
    }
  }

  /**
   * Per-call Media Streams loop: parse frames, enqueue audio, fire DTMF.
   *
   * Exposed (via `TwilioAgentAdapter._driveMediaStream`) so unit tests can
   * drive the loop with a mock socket and no real HTTP/WS upgrade.
   */
  async mediaStreamLoop(ws: MediaStreamWebSocket): Promise<void> {
    const adapter = this._adapter;

    // A-leg WS auth (#762 guardrail (a)): `_streamNonceForServer` is set ONLY by
    // an "a-leg" placeCall, so its presence is what arms enforcement — b-leg and
    // inbound sockets keep today's un-gated behaviour byte for byte. Until an
    // armed socket has authenticated, it gets NO adapter state: not `_streamWs`
    // (which `sendAudio` writes to — adopting an unauthenticated socket would
    // hand the attacker our outbound audio) and not the per-call queue purge
    // (which would drop the live call's audio).
    //
    // The nonce is read WHERE the `start` frame is processed, never snapshotted
    // here at loop entry: a socket that opened before `placeCall` armed the
    // nonce would otherwise be adopted un-gated at entry and grandfather its
    // later `start` frame past the check (the CWE-306 arming race).
    let adopted = false;
    // The call generation captured at ADOPTION (#762 P1). Until this socket
    // adopts it stays -1 and `ownsCurrentCall` is false via the `adopted` guard.
    // Once adopted, a bump of `adapter._callGenerationForServer` (a new
    // placeCall/waitForCall) makes this socket stale: it is closed on its next
    // frame and none of its side effects touch the current call.
    let myGeneration = -1;
    const ownsCurrentCall = (): boolean =>
      adopted && myGeneration === adapter._callGenerationForServer;

    /**
     * Make `ws` the adapter's live transport and re-arm per-call state.
     *
     * The terminal flag AND the inbound queue are per-CALL state: re-armed
     * alongside `_streamWs` so a second media-stream session on the same
     * connected adapter (Twilio reconnect, back-to-back call) starts clean —
     * neither inheriting the previous call's terminal flag nor draining its
     * leftover terminal sentinel as this call's first chunk. See
     * `_resetCallState`.
     */
    const adopt = (): void => {
      adopted = true;
      // Capture the generation we are adopting under. Any later dial bumps
      // `adapter._callGenerationForServer` and this socket becomes stale.
      myGeneration = adapter._callGenerationForServer;
      adapter._setStreamWs(ws);
      adapter._resetCallState();
    };

    /**
     * Does this `start` frame belong to the call we originated?
     *
     * Nonce first (timing-safe, and a missing `<Parameter>` is a rejection, not
     * a bypass), then the originated call SID so a stale or probe socket cannot
     * win the race to `_signalStreamConnected`. Never logs the nonce itself — it
     * is a live credential for the rest of the call.
     */
    const authenticate = (
      frame: MediaStreamEvent,
      expected: string,
    ): StartFrameVerdict => {
      if (!nonceMatches(expected, frame.customParameters?.nonce)) {
        twilioLogger.warn("media stream rejected — a-leg nonce missing or mismatched", {
          callSid: frame.callSid,
        });
        return "reject";
      }
      const originatedCallSid = adapter._callSidForServer;
      if (originatedCallSid === undefined || frame.callSid !== originatedCallSid) {
        twilioLogger.warn("start frame ignored — callSid is not the originated call", {
          callSid: frame.callSid,
          originatedCallSid,
        });
        return "ignore";
      }
      return "accept";
    };

    const buffered: number[] = [];
    const flushThresholdBytes = (BATCH_MS / TWILIO_FRAME_MS) * 160; // 100ms = 800 bytes µ-law

    // Tier-3 (#775): the turn-ctx object we last emitted a background-loop
    // `voice.audio.receive` delivery marker for — so the marker fires ONCE
    // per live turn (mirrors Pipecat's `bgSpanTurnContext`, the #774/#781
    // primitive). Fresh per `mediaStreamLoop()` invocation, i.e. per
    // connected call/session — matches `buffered` above.
    let lastBgSpanTurnContext: Context | undefined;

    const flush = (): void => {
      if (buffered.length === 0) return;
      const mulaw = new Uint8Array(buffered);
      buffered.length = 0;
      const pcm = mulaw8kToPcm16_24k(mulaw);
      // At the FIRST wire delivery under a LIVE turn, wrap the enqueue in a
      // `voice.audio.receive` background-loop delivery marker parented to
      // that turn (#774/#781 primitive) — mirrors Pipecat's
      // `flushBufferedMulaw`. Between turns (`_voiceTurnContext` undefined)
      // or for later deliveries within the SAME turn (identity-check), no
      // span is emitted: only the first wire delivery per turn is spanned
      // (flood guard), and a fully pre-buffered turn (audio queued before
      // any turn went live) is drained by the base `voice.audio.receive`
      // span with no background marker at all.
      //
      // Coverage limit (by design, mirrors Pipecat): `voice.audio.bytes` is
      // the DELIVERED coalesced-batch size, which may fold in a sub-100ms
      // µ-law tail carried over from the prior turn.
      const parent = adapter._voiceTurnContext;
      if (parent === undefined || parent === lastBgSpanTurnContext) {
        adapter._enqueueInbound(new AudioChunk({ data: pcm }));
        return;
      }
      lastBgSpanTurnContext = parent;
      voiceReceiveSpanUnder(
        parent,
        {
          "voice.adapter.class": adapter.constructor.name,
          "voice.twilio.recv.source": "background_loop",
          "voice.audio.bytes": pcm.length,
        },
        () => {
          adapter._enqueueInbound(new AudioChunk({ data: pcm }));
        },
      );
    };

    try {
      while (true) {
        const text = await ws.receiveText();
        if (text == null) {
          if (ownsCurrentCall()) adapter._setStreamEndedReason("close");
          return; // socket closed
        }
        const frame = parseMediaStreamFrame(text);
        if (!frame) continue;

        // Security (#762 P1): a socket adopted under an OLDER call generation (it
        // connected — and even adopted — before this dial armed the nonce) is
        // stale the instant placeCall/waitForCall bumped the generation. Close it
        // on its next frame so it can neither inject audio nor connect nor change
        // the current call's terminal state. The `finally` below is
        // generation-gated too, so this early return does not end the live call.
        if (adopted && myGeneration !== adapter._callGenerationForServer) {
          ws.close();
          return;
        }

        // Security (#762, CWE-306): only an ADOPTED socket may touch adapter
        // state. A b-leg/inbound socket adopts un-gated on its first `start`; an
        // a-leg socket adopts only after presenting the nonce. Any other branch
        // (`media`/`dtmf`/`stop`/…) from a socket that skipped `start` — or
        // failed auth and was left "ignored" — is dropped silently, so a leaked
        // tunnel URL cannot inject audio or DTMF into the live call. `start` is
        // what adopts, so it is the one branch this cannot gate.
        if (frame.event !== "start" && !adopted) continue;

        if (frame.event === "start") {
          // Read the adapter's CURRENT nonce here, when the start frame is
          // processed — never a snapshot from loop entry. This is what closes
          // the arming race: a socket that connected before `placeCall` armed
          // the nonce is still gated on it the moment its start frame arrives.
          const expectedNonce = adapter._streamNonceForServer;
          if (expectedNonce !== undefined) {
            // A bad nonce closes the socket outright; a good nonce on the wrong
            // call is merely ignored (AC5/AC6). Either way the socket gets no
            // adapter state and no connected signal, so a correct socket
            // arriving later is the one that connects.
            const verdict = authenticate(frame, expectedNonce);
            if (verdict === "reject") {
              // No `_setStreamEndedReason` here: a socket that failed to
              // authenticate never became this adapter's transport, so it must
              // not stamp a verdict onto the call it failed to reach — the same
              // rule the terminal sentinel below already follows.
              ws.close();
              return;
            }
            if (verdict === "ignore") continue;
          }
          // Adopt on the first start frame — after auth in a-leg mode, always in
          // un-gated (b-leg/inbound) mode. Idempotent: a resend must not clobber
          // the live call's state.
          if (!adopted) adopt();
          if (frame.streamSid) adapter._setStreamSid(frame.streamSid);
          if (frame.callSid) adapter._setCallSid(frame.callSid);
          adapter._signalStreamConnected();
        } else if (frame.event === "media" && frame.payloadMulaw) {
          adapter._recordFrameReceived();
          for (const byte of frame.payloadMulaw) buffered.push(byte);
          if (buffered.length >= flushThresholdBytes) flush();
        } else if (frame.event === "dtmf" && frame.dtmfDigit) {
          adapter._recordDtmfReceived();
          twilioLogger.debug("received DTMF", { digit: frame.dtmfDigit });
          if (adapter.onDtmf) {
            try {
              adapter.onDtmf(frame.dtmfDigit);
            } catch (err) {
              // Callback errors are swallowed — adapter contract says they don't
              // tear down the stream — but they ARE worth logging.
              twilioLogger.warn("onDtmf callback raised; continuing", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else if (frame.event === "stop") {
          flush();
          if (ownsCurrentCall()) adapter._setStreamEndedReason("stop");
          return;
        }
      }
    } catch (err) {
      // Any transport error that is not a clean socket close (`text == null`
      // above) propagates to `runStreamSession`'s caller unchanged — tag the
      // outcome before re-throwing.
      if (ownsCurrentCall()) adapter._setStreamEndedReason("error");
      throw err;
    } finally {
      // Terminal sentinel (#695; mirrors the #648 / #646 fix). Whether the loop
      // exits on a "stop" frame, a socket close (`receiveText` resolves null),
      // or a throw, mark the call ended and enqueue an empty AudioChunk so a
      // `receiveAudio` blocked on the inbound queue returns cleanly instead of
      // timing out on a silent / tool-only turn. All three termination paths
      // (stop / close / throw) funnel through this `finally`, so the sentinel is
      // genuinely reachable on each.
      //
      // `_markStreamEnded()` is called FIRST and unconditionally:
      // `_handleStreamSocket` nulls `_streamWs`/`_streamSid` synchronously right
      // after this loop returns, so `receiveAudio`'s follow-up call would
      // otherwise trip `_assertStreamLive`. The flag tells `receiveAudio` to
      // keep draining post-teardown rather than assert liveness. Unlike the
      // Python twin, no null-guard is needed on the queue: it's never nulled —
      // `disconnect()` only `reset()`s it.
      //
      // A socket rejected before adoption never became this adapter's transport,
      // so it must not end the call it failed to authenticate into either: skip
      // the terminal sentinel entirely. A socket adopted under an OLDER
      // generation (#762 P1) is likewise not the current call: its teardown must
      // not cancel the live call's watchdog or mark the live stream ended —
      // hence `ownsCurrentCall()` rather than a bare `adopted`.
      if (ownsCurrentCall()) {
        // The session that owned the duration cap is over; disarm before
        // anything else so the watchdog can never hang up a LATER call.
        adapter._cancelMaxDurationTimer();
        adapter._markStreamEnded();
        adapter._enqueueInbound(new AudioChunk({ data: new Uint8Array(0) }));
      }
    }
  }
}

// ---------------------------------------------------------------- helpers

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error(`request body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseFormUrlEncoded(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!body) return params;
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [rawKey, rawValue = ""] = pair.split("=");
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    params[key] = value;
  }
  return params;
}

/**
 * Wrap a real `ws.WebSocket` so it presents the abstract `MediaStreamWebSocket`
 * interface — same shape the adapter test mocks satisfy.
 */
function adaptWsSocket(ws: WsWebSocket): MediaStreamWebSocket {
  type Pending = {
    resolve: (text: string | null) => void;
    reject: (err: Error) => void;
  };
  const queue: string[] = [];
  const waiters: Pending[] = [];
  let closed = false;

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // Twilio Media Streams is JSON over text frames only.
    const text = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(text);
    else queue.push(text);
  });
  const handleEnd = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(null);
    }
  };
  ws.on("close", handleEnd);
  ws.on("error", handleEnd);

  return {
    send(data) {
      try {
        ws.send(data);
      } catch {
        // Socket closed mid-send — receivers will see null on next take.
      }
    },
    receiveText() {
      const head = queue.shift();
      if (head !== undefined) return Promise.resolve(head);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
}
