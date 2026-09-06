// Shared in-memory fake of the ElevenLabs SDK's Conversation transport for the
// hosted-adapter unit tests: an EventEmitter WebSocket that records each `send()`
// payload, plus a `makeFakeConv()` that builds the two SDK injection seams (a fake
// `webSocketFactory` and a fake signed-URL `conversationClient`) so the REAL
// `Conversation` runs against memory with no network.
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import type { ElevenLabsAgentAdapterOptions } from "../../index";

// The two SDK injection seams, derived from the public options type (no deep
// SDK-path import needed).
export type WsFactory = NonNullable<ElevenLabsAgentAdapterOptions["webSocketFactory"]>;
export type ConvClient = NonNullable<ElevenLabsAgentAdapterOptions["conversationClient"]>;

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSED = 3;

/**
 * In-memory fake of the SDK's `WebSocketInterface` (an `EventEmitter` with
 * `readyState`/`send`/`close`). The real `Conversation` drives it: it sends the
 * init handshake + pongs + keepalives through `send()` (we record each as a decoded
 * object), and we feed it inbound EL frames by `emit("message", …)`. Structural
 * typing makes it a `WebSocketInterface` with no cast.
 */
export class FakeWebSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = [];
  readyState = WS_CONNECTING;
  constructor() {
    super();
    // Model the real connecting -> open transition: the socket is CONNECTING
    // until the transport reports it up (makeFakeConv emits "open" on the next
    // microtask). Starting OPEN would let a "send while still connecting" bug
    // slip past the fake.
    this.on("open", () => {
      this.readyState = WS_OPEN;
    });
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    // The SDK's close handler calls `reason.toString()`, so pass a real Buffer reason.
    this.emit("close", 1000, Buffer.from("closed"));
  }
}

/**
 * Build the two SDK seams: a fake `webSocketFactory` (returns an in-memory
 * `FakeWebSocket` that auto-opens) and a fake `conversationClient` (returns a
 * canned signed URL so `requiresAuth: true`'s `getSignedUrl` handshake never hits
 * the network). Tracks the opened socket + the signed-URL request for assertions.
 */
export function makeFakeConv(): {
  webSocketFactory: WsFactory;
  conversationClient: ConvClient;
  socket: { current: FakeWebSocket | null };
  signedUrl: { calls: number; lastAgentId: string | null };
} {
  const socketRef: { current: FakeWebSocket | null } = { current: null };
  const signedUrl = { calls: 0, lastAgentId: null as string | null };
  const webSocketFactory: WsFactory = {
    create: (_url: string) => {
      const socket = new FakeWebSocket();
      socketRef.current = socket;
      // Open on the next microtask so `startSession()` resolves.
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  };
  const conversationClient: ConvClient = {
    conversationalAi: {
      conversations: {
        getSignedUrl: async ({ agentId }: { agentId: string }) => {
          signedUrl.calls += 1;
          signedUrl.lastAgentId = agentId;
          return { signedUrl: "wss://fake-signed.elevenlabs.test/convai" };
        },
      },
    },
  };
  return { webSocketFactory, conversationClient, socket: socketRef, signedUrl };
}
