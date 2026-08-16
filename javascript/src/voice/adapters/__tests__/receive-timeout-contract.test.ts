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

import type { LanguageModel } from "ai";
import { describe, it, expect, vi } from "vitest";

import { AgentRole } from "../../../domain/agents";
import { makeAgentInput } from "../../__tests__/helpers/drive-production";
import { extractAudio } from "../../messages";
import { isReceiveTimeoutError } from "../../receive-timeout-error";
import type { STTProvider } from "../../stt";
import { OPENAI_REALTIME_MODEL } from "../../voice-models";
import { ComposableVoiceAgent } from "../composable";
import { ElevenLabsAgentAdapter } from "../elevenlabs";
import { GeminiLiveAgentAdapter } from "../gemini-live";
import { OpenAIRealtimeAgentAdapter } from "../openai-realtime";
import { PipecatAgentAdapter, type PipecatWebSocketLike } from "../pipecat";
import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { mulaw8kToPcm16At24k, TwilioRESTHelper } from "../twilio-shared";
import { makeFakeConv } from "./fixtures/fake-elevenlabs-conversation";
import { setupMockRealtimeServer } from "./fixtures/mock-realtime-server";

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

/** In-process stand-in for the OpenAI Realtime endpoint. Stays silent. */
const realtimeServer = setupMockRealtimeServer(() => {});

/** Twilio REST with every network call stubbed, so connect() stays local. */
function stubTwilioRest(): TwilioRESTHelper {
  const stub = new TwilioRESTHelper("ACtest", "secret");
  stub.resolvePhoneNumberSid = async () => "PNtimeoutcontract";
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async () => "CAtimeoutcontract";
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

/** A media-stream socket that stays open and sends only what we hand it. */
function twilioSocket(): MediaStreamWebSocket & { emit(text: string): void } {
  const incoming: string[] = [];
  let resolver: ((text: string | null) => void) | null = null;
  return {
    send() {},
    close() {},
    receiveText() {
      const head = incoming.shift();
      if (head !== undefined) return Promise.resolve(head);
      return new Promise<string | null>((resolve) => {
        resolver = resolve;
      });
    },
    emit(text: string) {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(text);
      } else {
        incoming.push(text);
      }
    },
  } as MediaStreamWebSocket & { emit(text: string): void };
}

/** An ai-sdk model whose generation never settles, so the wrapper deadline wins. */
function hangingLlm(): LanguageModel {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "hanging-model",
    supportedUrls: {},
    doGenerate: () => new Promise(() => {}),
    doStream: () => new Promise(() => {}),
  } as unknown as LanguageModel;
}

const stubStt: STTProvider = {
  async transcribe(): Promise<string> {
    return "user said hello";
  },
};

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
  {
    name: "OpenAIRealtimeAgentAdapter",
    parkReceive: async () => {
      realtimeServer.arm();
      const adapter = new OpenAIRealtimeAgentAdapter({
        apiKey: "test-key",
        url: `ws://127.0.0.1:${realtimeServer.port()}/realtime?model=${OPENAI_REALTIME_MODEL}`,
      });
      await adapter.connect();
      await realtimeServer.socketReady();
      return {
        receive: adapter.receiveAudio(DEADLINE_S),
        teardown: () => adapter.disconnect(),
      };
    },
  },
  {
    name: "TwilioAgentAdapter",
    parkReceive: async () => {
      const adapter = new TwilioAgentAdapter({
        accountSid: "ACtest",
        authToken: "secret",
        phoneNumber: "+14155551234",
        publicBaseUrl: "https://example.test",
        validateSignature: false,
        rest: stubTwilioRest(),
      });
      await adapter.connect();
      const socket = twilioSocket();
      // Drive the media-stream loop and open a call, but never end it: the
      // stream stays LIVE with an empty queue, which is the state whose only
      // exit is the receive deadline.
      const loop = adapter._driveMediaStream(socket);
      socket.emit(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZtimeoutcontract", callSid: "CAtimeoutcontract" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        receive: adapter.receiveAudio(DEADLINE_S),
        teardown: async () => {
          socket.emit(JSON.stringify({ event: "stop", streamSid: "MZtimeoutcontract" }));
          await loop;
          await adapter.disconnect();
        },
      };
    },
  },
  {
    name: "ComposableVoiceAgent",
    parkReceive: async () => {
      // No transport: the deadline wraps the STT/LLM/TTS work itself, and a
      // generation that never settles is what a wedged provider looks like.
      const adapter = new ComposableVoiceAgent({
        stt: stubStt,
        llm: hangingLlm(),
        tts: "openai/nova",
      });
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
    const transportError = new Error("ECONNRESET");
    const inFlightReceive = adapter.receiveAudio(30);
    await Promise.resolve();

    socket.emit("error", transportError);

    // A broken transport rejects the currently parked receive immediately,
    // rather than letting its deadline relabel the failure as a timeout.
    await expect(inFlightReceive).rejects.toBe(transportError);
    expect(isReceiveTimeoutError(transportError)).toBe(false);

    // The drain's next probe must see the same transport failure too.
    await expect(adapter.receiveAudio(30)).rejects.toBe(transportError);
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

    const message = await adapter.call(makeAgentInput());
    const audio = extractAudio(message);
    expect(audio, "call() returned no assistant audio").not.toBeNull();
    expect(audio!.data.length).toBeGreaterThan(0);
    const expectedPcm = mulaw8kToPcm16At24k(Buffer.from(payload, "base64"));
    expect(Array.from(audio!.data)).toEqual(Array.from(expectedPcm));
  });
});
