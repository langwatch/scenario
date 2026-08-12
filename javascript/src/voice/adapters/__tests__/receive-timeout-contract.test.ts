/**
 * Binds `specs/voice-drain-error-propagation.feature` (#756).
 *
 * The response drain ends a turn only on a receive deadline and propagates
 * every other `receiveAudio` rejection. That split is worth nothing unless the
 * adapters hold up their half: an adapter whose deadline rejects with a plain
 * `Error` is read as a hard failure, so a perfectly normal end of turn crashes
 * the run.
 *
 * Nothing about a plain `new Error(...)` at a `setTimeout` looks wrong in
 * review, and no per-adapter test notices, because each one asserts its own
 * message rather than the class. So these tests drive each adapter to its real
 * deadline and assert only the drain's question: is this a receive timeout?
 *
 * **Adding a timeout site?** Reject with {@link ReceiveTimeoutError} and add the
 * adapter here. Faked at the network-client boundary — a socket factory or the
 * vendor SDK module — never by assigning adapter privates.
 *
 * Run with `pnpm test src/voice/adapters/__tests__/receive-timeout-contract.test.ts`
 * from `javascript/`.
 */
import { EventEmitter } from "node:events";

import { describe, it, expect, vi } from "vitest";

import { isReceiveTimeoutError } from "../../receive-timeout-error";
import { ElevenLabsAgentAdapter } from "../elevenlabs";
import { GeminiLiveAgentAdapter } from "../gemini-live";
import { PipecatAgentAdapter, type PipecatWebSocketLike } from "../pipecat";
import { makeFakeConv } from "./fixtures/fake-elevenlabs-conversation";

// Mock the Gemini SDK so connect() never opens a real WebSocket. Scoped to this
// module, and the other adapters under test do not import it.
vi.mock("@google/genai", () => {
  class FakeSession {
    sendRealtimeInput = vi.fn();
    close = vi.fn();
  }
  return {
    Modality: { AUDIO: "AUDIO" },
    GoogleGenAI: class {
      live = { connect: async () => new FakeSession() };
      constructor(_init: { apiKey?: string }) {}
    },
  };
});

/**
 * Short enough to keep the suite fast, long enough that the adapter has really
 * parked a waiter rather than failing some precondition on the way in.
 */
const DEADLINE_S = 0.05;

/** Minimal Pipecat socket: opens, accepts frames, never delivers audio. */
class SilentPipecatSocket extends EventEmitter implements PipecatWebSocketLike {
  send(_data: string | Uint8Array): void {}
  close(): void {}
}

function silentPipecatSocket(): SilentPipecatSocket {
  const socket = new SilentPipecatSocket();
  // The adapter registers `once('open')` during connect(); emit after that.
  queueMicrotask(() => socket.emit("open"));
  return socket;
}

/**
 * Each entry parks a `receiveAudio` against a transport that stays open and
 * silent, so the adapter's own deadline is what ends the wait.
 */
const ADAPTERS: Array<{
  name: string;
  parkReceive: () => Promise<{ receive: Promise<unknown>; teardown: () => Promise<void> }>;
}> = [
  {
    name: "ElevenLabsAgentAdapter",
    parkReceive: async () => {
      const fake = makeFakeConv();
      const adapter = new ElevenLabsAgentAdapter({
        agentId: "agt-timeout-contract",
        apiKey: "sk-timeout-contract",
        webSocketFactory: fake.webSocketFactory,
        conversationClient: fake.conversationClient,
      });
      await adapter.connect();
      return {
        receive: adapter.receiveAudio(DEADLINE_S),
        teardown: () => adapter.disconnect(),
      };
    },
  },
  {
    name: "PipecatAgentAdapter",
    parkReceive: async () => {
      const adapter = new PipecatAgentAdapter({
        url: "ws://pipecat.test/ws",
        streamSid: "MZtimeoutcontract",
        realTimePacing: false,
        webSocketFactory: () => silentPipecatSocket(),
      });
      await adapter.connect();
      return {
        receive: adapter.receiveAudio(DEADLINE_S),
        teardown: () => adapter.disconnect(),
      };
    },
  },
  {
    name: "GeminiLiveAgentAdapter",
    parkReceive: async () => {
      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();
      return {
        receive: adapter.receiveAudio(DEADLINE_S),
        teardown: () => adapter.disconnect(),
      };
    },
  },
];

describe("built-in adapters reject their receive deadline as a receive timeout (#756)", () => {
  it.each(ADAPTERS)("$name", async ({ parkReceive }) => {
    const { receive, teardown } = await parkReceive();
    try {
      const error = await receive.then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error, "the deadline did not fire").toBeDefined();
      expect(
        isReceiveTimeoutError(error),
        `the drain reads this as a HARD failure and will abort the run: ${String(error)}`,
      ).toBe(true);
      // The diagnosis the user reads still has to survive the classification.
      expect(String((error as Error).message)).not.toBe("");
    } finally {
      await teardown();
    }
  });
});
