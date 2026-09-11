/**
 * `TwilioWebhookServer.receiveExternalUpgrade` /
 * `TwilioAgentAdapter.receiveExternalMediaSocket` — the child-side half of the
 * LangWatch platform's split-process handoff.
 *
 * Production shape: a host platform's PARENT process accepts Twilio's raw TCP
 * upgrade on its OWN public listener (a different process, a different port),
 * resolves the routing nonce from the path, and hands the still-unhandshaked
 * `net.Socket` to the CHILD process that placed the call — over IPC, which can
 * carry a socket handle but never a real `http.IncomingMessage`, and which does
 * NOT complete the WebSocket handshake before handing off (that requires the
 * receiving process's own `ws.WebSocketServer`).
 *
 * This test reproduces that shape for real, in one process: a separate raw TCP
 * server stands in for the parent's public listener, an adapter (`connect()`ed
 * as usual) stands in for the child, and the two are joined ONLY through
 * `receiveExternalMediaSocket` — never through the adapter's own bound port.
 * No mock of `ws`, no mock of the adapter's media loop: a real WebSocket
 * client, a real socket handoff, a real frame.
 */

import { createServer as createRawHttpServer } from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  makeAdapter,
  ORIGINATED_CALL_SID,
  spyRest,
  startALegCall,
  startFrame,
} from "./a-leg-harness";
import type { TwilioAgentAdapter } from "../twilio";

/** Encode one client->server WebSocket text frame (masked, per RFC 6455 —
 *  every client frame MUST be masked). Supports the short (<126 bytes) and
 *  extended 16-bit (126-65535 bytes) length forms — a Media Stream `start`
 *  frame's JSON (streamSid + full-length callSid + nonce) regularly exceeds
 *  126 bytes, so both forms are exercised across the test suite in practice. */
function encodeMaskedTextFrame(payload: string): Buffer {
  const payloadBytes = Buffer.from(payload, "utf-8");
  if (payloadBytes.length > 65535) {
    throw new Error("test helper does not encode 64-bit-length frames");
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payloadBytes.length);
  for (let i = 0; i < payloadBytes.length; i++) {
    masked[i] = payloadBytes[i] ^ mask[i % 4];
  }
  const header =
    payloadBytes.length < 126
      ? Buffer.from([0x81, 0x80 | payloadBytes.length])
      : Buffer.concat([
          Buffer.from([0x81, 0x80 | 126]),
          Buffer.from([
            (payloadBytes.length >> 8) & 0xff,
            payloadBytes.length & 0xff,
          ]),
        ]);
  return Buffer.concat([header, mask, masked]);
}

/** A minimal, valid WS upgrade request line + headers for `path`. */
function upgradeRequestHead(params: { path: string; port: number }): Buffer {
  const key = randomBytes(16).toString("base64");
  const lines = [
    `GET ${params.path} HTTP/1.1`,
    `Host: 127.0.0.1:${params.port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
    "",
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

describe("receiveExternalMediaSocket — split-process handoff", () => {
  let adapter: TwilioAgentAdapter | null = null;
  let parentServer: ReturnType<typeof createRawHttpServer> | null = null;

  afterEach(async () => {
    if (adapter) {
      await adapter.disconnect();
      adapter = null;
    }
    if (parentServer) {
      await new Promise<void>((resolve) => parentServer!.close(() => resolve()));
      parentServer = null;
    }
  });

  describe("given the parent hands off a raw socket for the placed call's nonce", () => {
    /**
     * Proves the WHOLE production path this method exists for: a socket that
     * never touched the adapter's own bound port still completes the
     * handshake and delivers a frame that authenticates and connects the
     * call — exactly what a real Twilio dial-back does through the
     * LangWatch platform's parent listener.
     * @scenario "A split-process handoff completes the handshake and connects the call"
     */
    it("completes the WS handshake and accepts the start frame, connecting the call", async () => {
      const rest = spyRest();
      adapter = makeAdapter(rest);
      await adapter.connect();
      const { nonce, call } = await startALegCall(adapter, rest);
      const ownAdapter = adapter;

      // The "parent": a raw TCP/HTTP server on a DIFFERENT port from the
      // adapter's own local server. It never completes the handshake —
      // it captures the request + head and hands off, exactly like
      // voice-ws-listener.ts does against a real Twilio connection.
      let capturedHeadLength = -1;
      const handoff = new Promise<void>((resolve, reject) => {
        parentServer = createRawHttpServer();
        parentServer.on("upgrade", (req, socket, head) => {
          try {
            capturedHeadLength = head.length;
            ownAdapter.receiveExternalMediaSocket({
              req: {
                method: req.method ?? "GET",
                url: req.url ?? "/",
                headers: req.headers as Record<
                  string,
                  string | string[] | undefined
                >,
              },
              socket,
              head,
            });
            resolve();
          } catch (err) {
            reject(err as Error);
          }
        });
        parentServer.listen(0, "127.0.0.1");
      });
      await new Promise<void>((resolve) => parentServer!.once("listening", resolve));
      const parentPort = (parentServer!.address() as AddressInfo).port;

      // A real WebSocket client, connecting to the PARENT's port — never the
      // adapter's own bound port. Pipelines the upgrade request and the
      // first Media Stream frame (the `start` event) in ONE write, so the
      // parent's `head` buffer carries real post-header bytes: this is what
      // proves the head-replay ordering (the part most likely to be
      // silently wrong) rather than merely a clean handshake with no
      // pipelined data.
      const raw = net.connect(parentPort, "127.0.0.1");
      raw.setNoDelay(true);
      const startFrameJson = startFrame({ nonce, callSid: ORIGINATED_CALL_SID });
      const pipelined = Buffer.concat([
        upgradeRequestHead({ path: `/twilio/${nonce}`, port: parentPort }),
        encodeMaskedTextFrame(startFrameJson),
      ]);

      const responseChunks: Buffer[] = [];
      // Resolves once the 101 response line has arrived back at the client —
      // the observable the assertions below wait on, not a fixed sleep. The
      // server-side handoff completing (`await handoff`, below) only proves
      // this process WROTE the response; reading it back over the loopback
      // socket is a separate, later event-loop turn.
      let signalResponseSeen!: () => void;
      const responseSeen = new Promise<void>((resolve) => {
        signalResponseSeen = resolve;
      });
      raw.on("data", (chunk: Buffer) => {
        responseChunks.push(chunk);
        if (Buffer.concat(responseChunks).includes("\r\n\r\n")) signalResponseSeen();
      });
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", () => {
          raw.write(pipelined, (err) => (err ? reject(err) : resolve()));
        });
        raw.once("error", reject);
      });

      await handoff;

      // Confirms the test actually forced the pipelined shape it claims to:
      // without a non-empty head, "the call connects" would only prove a
      // clean two-step handshake-then-frame, not that head bytes are
      // correctly replayed ahead of the rest of the stream.
      expect(capturedHeadLength).toBeGreaterThan(0);

      // The call's placeCall() promise resolves only once the media stream
      // authenticates and signals connected (see startALegCall's doc
      // comment) — this is the end-to-end proof, not an internal spy. If the
      // head buffer were dropped or mis-ordered, the `start` frame carried
      // in it would never reach the media loop and this would hang/time out.
      await expect(call).resolves.toBeUndefined();

      await Promise.race([
        responseSeen,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("101 response never arrived at the client")),
            2_000,
          ),
        ),
      ]);
      const response = Buffer.concat(responseChunks).toString("utf-8");
      expect(response).toContain("HTTP/1.1 101");

      raw.destroy();
    });
  });
});
