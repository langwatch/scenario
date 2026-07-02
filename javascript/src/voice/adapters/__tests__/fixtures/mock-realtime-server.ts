// In-process WebSocket server that stands in for the OpenAI Realtime endpoint in
// the adapter unit tests. It owns the http + `ws` server lifecycle (registered on
// the current suite via beforeAll/afterAll), tracks the live client socket, and
// re-arms a per-connection `socketReady` promise. Each caller passes a capture sink
// so it can record wire events in whatever shape its assertions need.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

export interface MockRealtimeServer {
  /** Port the server is listening on. */
  port(): number;
  /** Send a JSON payload to the connected client. */
  push(payload: unknown): void;
  /** Re-arm `socketReady` and drop the current socket for the next connection. */
  arm(): void;
  /** Resolves once a client connects after the most recent `arm()` (or startup). */
  socketReady(): Promise<void>;
  /** The live client socket, or null before a connection / after `arm()`. */
  readonly socket: WsServerSocket | null;
}

/**
 * Stand up a mock realtime server for the current test file. `onMessage` receives
 * the decoded text of every frame the client sends, so the caller records it in the
 * shape its assertions expect.
 */
export function setupMockRealtimeServer(
  onMessage: (text: string) => void,
): MockRealtimeServer {
  let http: Server;
  let wss: WebSocketServer;
  let activeSocket: WsServerSocket | null = null;
  let readyResolve: (() => void) | null = null;
  let ready: Promise<void> = new Promise((r) => {
    readyResolve = r;
  });

  beforeAll(
    async () =>
      await new Promise<void>((doneStart) => {
        http = createServer();
        wss = new WebSocketServer({ server: http });
        wss.on("connection", (sock) => {
          activeSocket = sock;
          readyResolve?.();
          sock.on("message", (raw) => {
            const text =
              typeof raw === "string"
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : Buffer.from(raw as ArrayBuffer).toString("utf8");
            onMessage(text);
          });
        });
        http.listen(0, "127.0.0.1", doneStart);
      }),
  );

  afterAll(async () => {
    wss.close();
    await new Promise<void>((done) => http.close(() => done()));
  });

  return {
    port: () => (http.address() as AddressInfo).port,
    push: (payload: unknown) => {
      if (!activeSocket) throw new Error("socket not connected");
      activeSocket.send(JSON.stringify(payload));
    },
    arm: () => {
      // Close the previous client connection before re-arming. Without this the
      // prior socket keeps the "message" listener registered above and can feed
      // onMessage into the next test, leaking events across tests now that this
      // server is shared across suites.
      if (activeSocket) {
        activeSocket.removeAllListeners("message");
        activeSocket.terminate();
      }
      activeSocket = null;
      ready = new Promise<void>((r) => {
        readyResolve = r;
      });
    },
    socketReady: () => ready,
    get socket() {
      return activeSocket;
    },
  };
}
