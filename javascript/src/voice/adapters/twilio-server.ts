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

import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import { AudioChunk } from "../audio-chunk";

import type { TwilioAgentAdapter } from "./twilio";
import { twilioLogger } from "./twilio-logger";
import {
  escapeXmlAttr,
  mulaw8kToPcm16_24k,
  parseMediaStreamFrame,
  redactE164,
  verifyTwilioSignature,
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
    const wsUrl =
      adapter.publicBaseUrl
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:")
        .replace(/\/$/, "") + "/twilio/stream";
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect><Stream url="${escapeXmlAttr(wsUrl)}"/></Connect></Response>`;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/xml");
    res.end(twiml);
  }

  private async _handleStreamSocket(ws: WsWebSocket): Promise<void> {
    const adapted = adaptWsSocket(ws);
    try {
      await this.mediaStreamLoop(adapted);
    } finally {
      this._adapter._setStreamWs(null);
      this._adapter._setStreamSid(undefined);
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
    adapter._setStreamWs(ws);

    const buffered: number[] = [];
    const flushThresholdBytes = (BATCH_MS / TWILIO_FRAME_MS) * 160; // 100ms = 800 bytes µ-law

    const flush = (): void => {
      if (buffered.length === 0) return;
      const mulaw = new Uint8Array(buffered);
      buffered.length = 0;
      const pcm = mulaw8kToPcm16_24k(mulaw);
      adapter._enqueueInbound(new AudioChunk({ data: pcm }));
    };

    while (true) {
      const text = await ws.receiveText();
      if (text == null) return; // socket closed
      const frame = parseMediaStreamFrame(text);
      if (!frame) continue;

      if (frame.event === "start") {
        if (frame.streamSid) adapter._setStreamSid(frame.streamSid);
        if (frame.callSid) adapter._setCallSid(frame.callSid);
        adapter._signalStreamConnected();
      } else if (frame.event === "media" && frame.payloadMulaw) {
        for (const byte of frame.payloadMulaw) buffered.push(byte);
        if (buffered.length >= flushThresholdBytes) flush();
      } else if (frame.event === "dtmf" && frame.dtmfDigit) {
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
        return;
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
    const key = decodeURIComponent(rawKey!.replace(/\+/g, " "));
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
    while (waiters.length > 0) waiters.shift()!.resolve(null);
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
