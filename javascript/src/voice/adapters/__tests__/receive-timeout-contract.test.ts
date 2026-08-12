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
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { describe, it, expect, vi } from "vitest";

import { AgentRole } from "../../../domain/agents";
import { makeAgentInput } from "../../__tests__/helpers/drive-production";
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

/**
 * The other half of the contract. A stream that ENDS is how a call finishes, so
 * it has to reach the drain as the empty end-of-stream chunk. Rejecting instead
 * used to be invisible, because the drain absorbed every rejection; now it
 * aborts the run. Pipecat was the last adapter still rejecting — ElevenLabs
 * (#648), OpenAI Realtime (#646) and Twilio (#695) already converged here.
 */
describe("a stream that ends is an end of turn, not a failure (#756)", () => {
  async function connectedPipecat(): Promise<{
    adapter: PipecatAgentAdapter;
    socket: SilentPipecatSocket;
  }> {
    let socket!: SilentPipecatSocket;
    const adapter = new PipecatAgentAdapter({
      url: "ws://pipecat.test/ws",
      streamSid: "MZstreamend",
      realTimePacing: false,
      webSocketFactory: () => {
        socket = silentPipecatSocket();
        return socket;
      },
    });
    await adapter.connect();
    return { adapter, socket };
  }

  it("hands a parked receive the terminal chunk when the bot closes the socket", async () => {
    const { adapter, socket } = await connectedPipecat();
    const receive = adapter.receiveAudio(30);
    await Promise.resolve();

    socket.emit("close");

    const chunk = await receive;
    expect(chunk.data.length).toBe(0);
  });

  it("keeps returning the terminal chunk once the stream has ended", async () => {
    // The drain's tail probe often lands AFTER the close rather than during it,
    // which is the race that made this throw.
    const { adapter, socket } = await connectedPipecat();
    socket.emit("close");

    const chunk = await adapter.receiveAudio(30);
    expect(chunk.data.length).toBe(0);
  });

  it("still fails every receive after a socket error", async () => {
    const { adapter, socket } = await connectedPipecat();
    socket.emit("error", new Error("ECONNRESET"));

    // Now, and on the drain's next probe: a broken transport is not an end of
    // turn however many times it is asked.
    for (const attempt of ["first", "second"]) {
      const error = await adapter.receiveAudio(30).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error, `${attempt} receive resolved after a socket error`).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("ECONNRESET");
      expect(isReceiveTimeoutError(error)).toBe(false);
    }
  });

  it("completes a real call() whose stream ends mid-drain", async () => {
    // The end-to-end shape of the regression: the bot speaks, then the call
    // ends while the drain is between its first chunk and its tail probe. This
    // drove the production wrapper straight to
    // "socket closed, no audio available".
    const { adapter, socket } = await connectedPipecat();
    adapter.role = AgentRole.AGENT;

    const payload = Buffer.alloc(160, 0xff).toString("base64");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event: "media",
          streamSid: "MZstreamend",
          media: { payload },
        }),
      ),
    );
    setTimeout(() => socket.emit("close"), 20);

    const messages = await adapter.call(makeAgentInput());
    expect(messages).toBeTruthy();
  });
});
