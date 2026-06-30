/**
 * Binds 5 scenarios from `specs/voice-agents.feature` tagged
 * `@ts-elevenlabs` and `@unit`. Each scenario exercises the PR7 surface:
 * the hosted {@link ElevenLabsAgentAdapter} connect/send (now over the official
 * `@elevenlabs/elevenlabs-js` SDK's `Conversation`), plus the composable + branded
 * path (STT + LLM + TTS).
 *
 * No real network is hit — the SDK runs against an in-memory fake socket
 * (`webSocketFactory`) + a fake signed-URL client (`conversationClient`), and the
 * LanguageModel, ElevenLabs TTS/STT are stubbed via factory injection.
 *
 * Tag convention: `@ts-elevenlabs` (per-subject) instead of `@ts-bound`
 * to avoid colliding with PR1's `voice-contract-surface.test.ts` which
 * uses `includeTags: ["ts-bound"]`. Per-subject tagging matches the
 * established per-subject tag-convention decision.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import type { LanguageModel } from "ai";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterEach, describe, it, expect, vi } from "vitest";

import { AgentRole } from "../../../domain/agents";
import { AudioChunk, silentChunk } from "../../audio-chunk";
import { VoiceAgentAdapter } from "../../adapter";
import { ELEVENLABS_DEFAULT_VOICE_ID } from "../../voice-models";
import { elevenLabsAgent } from "../../factories";
import {
  ComposableVoiceAgent,
  ElevenLabsAgentAdapter,
  ElevenLabsSTTProvider,
  ElevenLabsVoiceAgent,
  type ElevenLabsAgentAdapterOptions,
  type STTProvider,
} from "../index";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

// The two SDK injection seams, derived from the public options type so the test
// needs no deep SDK-path import.
type WsFactory = NonNullable<ElevenLabsAgentAdapterOptions["webSocketFactory"]>;
type ConvClient = NonNullable<ElevenLabsAgentAdapterOptions["conversationClient"]>;

/** `ws.readyState` OPEN/CLOSED — the SDK gates every send on `readyState === OPEN`. */
const WS_OPEN = 1;
const WS_CLOSED = 3;

/**
 * In-memory fake of the SDK's `WebSocketInterface` (an `EventEmitter` with
 * `readyState`/`send`/`close`). The real `Conversation` drives it: it sends the
 * init handshake + pongs + keepalives through `send()` (we record each as a decoded
 * object), and we feed it inbound EL frames by `emit("message", …)`. Structural
 * typing makes it a `WebSocketInterface` with no cast.
 */
class FakeWebSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = [];
  readyState = WS_OPEN;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    // The SDK's close handler calls `reason.toString()` — pass a real Buffer reason.
    this.emit("close", 1000, Buffer.from("closed"));
  }
}

/**
 * Build the two SDK seams: a fake `webSocketFactory` (returns an in-memory
 * `FakeWebSocket` that auto-opens) and a fake `conversationClient` (returns a
 * canned signed URL so `requiresAuth: true`'s `getSignedUrl` handshake never hits
 * the network). Tracks the opened socket + the signed-URL request for assertions.
 */
function makeFakeConv(): {
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

/** Feed one inbound EL ConvAI frame to the SDK over the fake socket. */
function emit(socket: FakeWebSocket, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event), "utf-8"));
}

/** Poll until `pred()` holds (the continuous mic pump feeds frames on a real 20 ms timer). */
async function flushUntil(pred: () => boolean, budgetMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("flushUntil: condition not met within budget");
}

const isUserAudioChunk = (f: Record<string, unknown>): boolean =>
  typeof f.user_audio_chunk === "string";

/**
 * Hand-rolled LanguageModelV3 stub — we only need `doGenerate`. Cast
 * through `unknown` so we don't drag the full LanguageModelV3 type
 * surface (and its myriad provider-specific fields) into test code.
 */
function makeFakeLanguageModel(text: string): {
  model: LanguageModel;
  calls: { current: number };
} {
  const calls = { current: 0 };
  const model = {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    doGenerate: async () => {
      calls.current += 1;
      return {
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text", text }],
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not implemented in fake");
    },
  } as unknown as LanguageModel;
  return { model, calls };
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: ElevenLabsAgentAdapter connects to conversational AI endpoint
    // -----------------------------------------------------------------------
    Scenario(
      "ElevenLabsAgentAdapter connects to conversational AI endpoint",
      ({ Given, When, Then, And }) => {
        let adapter: ElevenLabsAgentAdapter;
        const fake = makeFakeConv();

        Given("an ElevenLabsAgentAdapter with agent_id and api_key", () => {
          adapter = new ElevenLabsAgentAdapter({
            agentId: "agt_test_123",
            apiKey: "sk_fake_abc",
            webSocketFactory: fake.webSocketFactory,
            conversationClient: fake.conversationClient,
          });
        });

        When("the scenario starts", async () => {
          await adapter.connect();
        });

        Then(
          "a WebSocket to wss://api.elevenlabs.io/v1/convai/conversation?agent_id=... is opened",
          () => {
            // The SDK authenticates a hosted (private) agent via the signed-URL
            // handshake for our agent_id, then opens the socket and sends the
            // session-init message as the first frame.
            expect(fake.signedUrl.calls).toBeGreaterThanOrEqual(1);
            expect(fake.signedUrl.lastAgentId).toBe("agt_test_123");
            expect(fake.socket.current?.sent[0]).toMatchObject({
              type: "conversation_initiation_client_data",
            });
          },
        );

        And("PCM16 audio chunks are sent over the socket", async () => {
          const speech = new Uint8Array([0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00]);
          await adapter.sendAudio(new AudioChunk({ data: speech }));
          // The continuous mic pump feeds 20 ms frames on a real-time timer — queued
          // speech while the turn is in flight, silence when idle. Both serialize as
          // `user_audio_chunk`, so wait for (and match on) the frame carrying our
          // real speech bytes, not merely the first user_audio_chunk on the wire.
          const carriesSpeech = (f: Record<string, unknown>): boolean => {
            const b64 = f.user_audio_chunk;
            if (typeof b64 !== "string") return false;
            // The final frame is zero-padded to a full 20 ms, so compare the leading
            // speech bytes.
            const buf = Buffer.from(b64, "base64");
            return Array.from(buf.subarray(0, speech.length)).every(
              (b, i) => b === speech[i],
            );
          };
          await flushUntil(() => fake.socket.current!.sent.some(carriesSpeech));

          const frames = fake.socket.current!.sent;
          // Our real speech bytes reached EL as streamed PCM …
          expect(frames.some(carriesSpeech)).toBe(true);
          // … and NO `user_message` text commit is sent (the text-commit regression).
          expect(frames.some((f) => f.type === "user_message")).toBe(false);
          await adapter.disconnect();
        });
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Users can compose arbitrary STT + LLM + TTS providers
    // -----------------------------------------------------------------------
    Scenario(
      "Users can compose arbitrary STT + LLM + TTS providers into a voice agent",
      ({ Given, When, Then, And }) => {
        let stt: STTProvider;
        let agent: ComposableVoiceAgent;
        let llmCalls: { current: number };
        const sttCalls: { transcribed: AudioChunk[] } = { transcribed: [] };
        const ttsCalls: { text: string[] } = { text: [] };
        // Captures the EL SDK `textToSpeech.convert` spy so the scenario can
        // assert the request body (modelId/outputFormat), not just the
        // recorded text — a wrong-model regression must fail here.
        const ttsConvertSpy: { current: ReturnType<typeof vi.fn> | null } = {
          current: null,
        };

        Given(
          "an STTProvider implementation, an LLM identifier, and a TTSProvider identifier from any supported providers",
          () => {
            stt = {
              async transcribe(chunk: AudioChunk): Promise<string> {
                sttCalls.transcribed.push(chunk);
                return "hi there";
              },
            };
            const llm = makeFakeLanguageModel("hello back");
            llmCalls = llm.calls;
            agent = new ComposableVoiceAgent({
              stt,
              llm: llm.model,
              tts: "elevenlabs/test-voice",
              ttsOptions: {
                apiKey: "sk_fake_eleven",
                elevenLabsClientFactory: () =>
                  makeFakeElevenClient(ttsCalls.text, ttsConvertSpy),
              },
            });
          },
        );

        When("a user assembles them into a voice agent under test", () => {
          // Assertion in Then — `agent` is the constructed value.
          expect(agent).toBeDefined();
        });

        Then("the assembled agent implements the VoiceAgentAdapter contract", () => {
          expect(agent).toBeInstanceOf(VoiceAgentAdapter);
          expect(agent.capabilities.inputFormats).toContain("pcm16/24000");
          expect(agent.capabilities.outputFormats).toContain("pcm16/24000");
        });

        And(
          "the STT, LLM, and TTS seams are independently swappable without changes to the other two",
          async () => {
            await agent.connect();
            const userAudio = silentChunkBytes(0.5);
            await agent.sendAudio(new AudioChunk({ data: userAudio }));
            const out = await agent.receiveAudio(5);

            expect(sttCalls.transcribed).toHaveLength(1);
            expect(llmCalls.current).toBe(1);
            expect(ttsCalls.text).toEqual(["hello back"]);
            // Pin the EL `textToSpeech.convert` request body, not just the
            // recorded text: voiceId is positional arg 1, the body is arg 2.
            // The concrete modelId/outputFormat catch a wrong-model regression
            // that a call-count-only assertion would let through silently.
            expect(ttsConvertSpy.current).toHaveBeenCalledWith(
              "test-voice",
              expect.objectContaining({
                text: "hello back",
                modelId: "eleven_v3",
                outputFormat: "pcm_24000",
              }),
            );
            expect(out).toBeInstanceOf(AudioChunk);
            expect(out.data.length).toBeGreaterThan(0);

            // Independent swap: replace just the STT mid-test. LLM and TTS
            // factories from above are still active and must continue to
            // fire on the next turn.
            const replacementSpy = vi.fn(async () => "another question");
            (agent as unknown as { stt: STTProvider }).stt = {
              transcribe: replacementSpy,
            };
            await agent.sendAudio(new AudioChunk({ data: userAudio }));
            await agent.receiveAudio(5);
            expect(replacementSpy).toHaveBeenCalledTimes(1);
            expect(llmCalls.current).toBe(2);
            expect(ttsCalls.text).toHaveLength(2);
            await agent.disconnect();
          },
        );

        And(
          "intermediate transcripts and LLM decisions are observable by the scenario harness",
          () => {
            expect(agent.lastUserTranscript).toBe("another question");
            expect(agent.lastLlmResponse).toBe("hello back");
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Provider-branded voice agents — typed signatures + defaults
    // -----------------------------------------------------------------------
    Scenario(
      "Provider-branded voice agents expose typed, provider-specific signatures with sensible defaults",
      ({ Given, When, Then, And }) => {
        let branded: ElevenLabsVoiceAgent;

        Given(
          "a provider-branded voice agent (e.g. an ElevenLabs-branded voice agent)",
          () => {
            // Class exists and is constructible with only the EL-specific
            // required arg. We don't fire any network call here — the
            // defaults are what we're asserting.
          },
        );

        When(
          "a user instantiates it with only provider-specific required arguments",
          () => {
            branded = new ElevenLabsVoiceAgent({ apiKey: "sk_fake_eleven" });
          },
        );

        Then(
          "the branded agent applies opinionated defaults for that provider's STT and TTS",
          () => {
            expect(branded.stt).toBeInstanceOf(ElevenLabsSTTProvider);
            expect(branded.voice).toBe(`elevenlabs/${ELEVENLABS_DEFAULT_VOICE_ID}`);
            expect(branded.tts).toBe(branded.voice);
          },
        );

        And(
          "the public signature is typed with provider-specific parameter names, not opaque kwargs forwarding",
          () => {
            // Compile-time check: TS rejects unknown keys when
            // `ElevenLabsVoiceAgentOptions` is an interface (no index
            // signature). A `@ts-expect-error` directive forces the
            // test to fail if the typing regresses.
            // @ts-expect-error — `unknownProperty` is not a valid option.
            const bad = () => new ElevenLabsVoiceAgent({ apiKey: "x", unknownProperty: 1 });
            void bad;
            // Positive: every documented option is accepted.
            const wide = new ElevenLabsVoiceAgent({
              apiKey: "x",
              voice: "elevenlabs/custom",
              systemPrompt: "be terse",
            });
            expect(wide.voice).toBe("elevenlabs/custom");
          },
        );

        And(
          "it implements the same VoiceAgentAdapter contract as the composable path",
          () => {
            expect(branded).toBeInstanceOf(ComposableVoiceAgent);
            expect(branded).toBeInstanceOf(VoiceAgentAdapter);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Branded voice agents accept overrides for any piece
    // -----------------------------------------------------------------------
    Scenario(
      "Branded voice agents accept overrides for any piece (STT, LLM, or TTS)",
      ({ Given, When, Then }) => {
        let baseline: ElevenLabsVoiceAgent;
        let llmOverride: ElevenLabsVoiceAgent;
        let sttOverride: ElevenLabsVoiceAgent;
        let ttsOverride: ElevenLabsVoiceAgent;
        let customStt: STTProvider;

        Given("a provider-branded voice agent", () => {
          baseline = new ElevenLabsVoiceAgent({ apiKey: "sk" });
        });

        When("a user overrides the LLM, STT, or TTS independently", () => {
          const fakeLlm = makeFakeLanguageModel("ok").model;
          customStt = { async transcribe() { return "custom"; } };

          llmOverride = new ElevenLabsVoiceAgent({ apiKey: "sk", llm: fakeLlm });
          sttOverride = new ElevenLabsVoiceAgent({ apiKey: "sk", stt: customStt });
          ttsOverride = new ElevenLabsVoiceAgent({
            apiKey: "sk",
            voice: "elevenlabs/another-voice",
          });
        });

        Then(
          "the override takes effect and the other pieces retain their branded defaults",
          () => {
            // LLM override: only LLM changed, STT + TTS still EL defaults.
            expect(llmOverride.llm).not.toBe(baseline.llm);
            expect(llmOverride.stt).toBeInstanceOf(ElevenLabsSTTProvider);
            expect(llmOverride.voice).toBe(baseline.voice);

            // STT override: only STT changed.
            expect(sttOverride.stt).toBe(customStt);
            expect(sttOverride.voice).toBe(baseline.voice);

            // TTS override: only voice changed.
            expect(ttsOverride.voice).toBe("elevenlabs/another-voice");
            expect(ttsOverride.stt).toBeInstanceOf(ElevenLabsSTTProvider);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: ElevenLabsSTTProvider implements STTProvider
    // -----------------------------------------------------------------------
    Scenario(
      "ElevenLabsSTTProvider implements STTProvider and plugs into the composition path",
      ({ Given, Then, And }) => {
        let provider: ElevenLabsSTTProvider;
        const fakeClient = {
          speechToText: {
            convert: vi.fn(async () => ({ text: "transcribed text" })),
          },
        };

        Given("an ElevenLabsSTTProvider", () => {
          provider = new ElevenLabsSTTProvider({
            apiKey: "sk_fake_eleven",
            clientFactory: () => fakeClient as never,
          });
        });

        Then(
          "it implements the STTProvider interface (async transcribe(audio: AudioChunk) -> str)",
          async () => {
            const chunk = new AudioChunk({ data: silentChunkBytes(0.2) });
            const text = await provider.transcribe(chunk);
            expect(typeof text).toBe("string");
            expect(text).toBe("transcribed text");
            expect(fakeClient.speechToText.convert).toHaveBeenCalledTimes(1);
            // `speechToText.convert` takes a single body object (arg 1). Pin the
            // concrete modelId so a wrong-model regression fails — call-count
            // alone would pass with the wrong scribe model.
            expect(fakeClient.speechToText.convert).toHaveBeenCalledWith(
              expect.objectContaining({ modelId: "scribe_v1" }),
            );
          },
        );

        And("no ElevenLabs-specific types leak into the interface", () => {
          // Structural: any value satisfying { transcribe(AudioChunk): Promise<string> }
          // is an STTProvider. Assigning the EL provider to a bare STTProvider variable
          // must compile cleanly — no widening, no required EL fields.
          const asSttOnly: STTProvider = provider;
          expect(asSttOnly).toBe(provider);
        });

        And(
          "it can be used anywhere an STTProvider is accepted (run({ voice: { stt } }), composable voice agents)",
          () => {
            // Plug into ComposableVoiceAgent — the seam contract is `stt:
            // STTProvider`, so the EL provider must drop in.
            const composable = new ComposableVoiceAgent({
              stt: provider,
              llm: makeFakeLanguageModel("ok").model,
              tts: "elevenlabs/test",
              ttsOptions: { apiKey: "sk", elevenLabsClientFactory: () => fakeClient as never },
            });
            expect(composable.stt).toBe(provider);
            // And into the branded preset's override slot, which has the
            // same STTProvider contract.
            const branded = new ElevenLabsVoiceAgent({ apiKey: "sk", stt: provider });
            expect(branded.stt).toBe(provider);
          },
        );
      },
    );
  },
  { includeTags: [["unit", "ts-elevenlabs"]] },
);

// -------------------------------------------------------------- helpers
function silentChunkBytes(seconds: number): Uint8Array {
  const samples = Math.floor(seconds * 24000);
  return new Uint8Array(samples * 2);
}

function makeFakeElevenClient(
  recordedText: string[],
  spyRef?: { current: ReturnType<typeof vi.fn> | null },
): never {
  // The real adapter calls `textToSpeech.convert(voiceId, { text, modelId,
  // outputFormat })`. The spy records BOTH args verbatim, so a body assertion
  // on `spyRef.current` sees the actual modelId/outputFormat the adapter sent.
  const convert = vi.fn(
    async (_voiceId: string, request: { text: string }) => {
      recordedText.push(request.text);
      // Return an async iterable of one PCM16 chunk.
      const buf = Buffer.from(new Uint8Array([0x01, 0x00, 0x02, 0x00]));
      return (async function* () {
        yield buf;
      })();
    },
  );
  if (spyRef) spyRef.current = convert;
  const fake = {
    textToSpeech: { convert },
  };
  return fake as never;
}

// -----------------------------------------------------------------------------
// Wire-protocol unit tests for the hosted adapter's recv path, driven through the
// REAL `@elevenlabs/elevenlabs-js` SDK `Conversation` against an in-memory socket.
//
// We feed each EL ConvAI event type the SDK routes (audio → AudioInterface.output,
// transcripts → callbacks, ping → SDK auto-pong, client_tool_call → terminal) and
// assert the adapter's reaction. This is strictly higher-fidelity than poking a
// hand-rolled `onMessage`: the real SDK parses + dispatches the frame.
// -----------------------------------------------------------------------------
describe("ElevenLabsAgentAdapter wire-protocol (SDK-routed recv path)", () => {
  async function makeConnected(): Promise<{
    adapter: ElevenLabsAgentAdapter;
    socket: FakeWebSocket;
  }> {
    const fake = makeFakeConv();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt",
      apiKey: "sk",
      webSocketFactory: fake.webSocketFactory,
      conversationClient: fake.conversationClient,
    });
    await adapter.connect();
    return { adapter, socket: fake.socket.current! };
  }

  it("decodes base64 PCM16 from an `audio` event and resolves the next receiver", async () => {
    const { adapter, socket } = await makeConnected();
    const pcm = new Uint8Array([0xff, 0x00, 0x10, 0x20]);
    const recv = adapter.receiveAudio(1);
    emit(socket, {
      type: "audio",
      audio_event: { audio_base_64: Buffer.from(pcm).toString("base64") },
    });
    const chunk = await recv;
    expect(chunk).toBeInstanceOf(AudioChunk);
    expect(Array.from(chunk.data)).toEqual([0xff, 0x00, 0x10, 0x20]);
    await adapter.disconnect();
  });

  it("trims an odd-byte PCM16 payload so AudioChunk doesn't throw on the invariant", async () => {
    const { adapter, socket } = await makeConnected();
    const oddPcm = new Uint8Array([0xff, 0x00, 0x10, 0x20, 0xab]); // 5 bytes
    const recv = adapter.receiveAudio(1);
    emit(socket, {
      type: "audio",
      audio_event: { audio_base_64: Buffer.from(oddPcm).toString("base64") },
    });
    const chunk = await recv;
    expect(chunk.data.length).toBe(4); // last byte trimmed
    await adapter.disconnect();
  });

  it("queues audio events that arrive before any receiver is waiting", async () => {
    const { adapter, socket } = await makeConnected();
    const pcm = new Uint8Array([0x01, 0x02]);
    emit(socket, {
      type: "audio",
      audio_event: { audio_base_64: Buffer.from(pcm).toString("base64") },
    });
    // Now ask — should return the queued chunk immediately.
    const chunk = await adapter.receiveAudio(0.1);
    expect(Array.from(chunk.data)).toEqual([0x01, 0x02]);
    await adapter.disconnect();
  });

  it("the SDK auto-pongs a ping with the event_id (native keepalive, no hand-rolled reply)", async () => {
    const { adapter, socket } = await makeConnected();
    // Discard the init frame so the pong is at a known index.
    socket.sent.length = 0;
    emit(socket, { type: "ping", ping_event: { event_id: 42, ping_ms: 100 } });
    expect(socket.sent[0]).toEqual({ type: "pong", event_id: 42 });
    await adapter.disconnect();
  });

  it("captures user_transcript onto lastUserTranscript", async () => {
    const { adapter, socket } = await makeConnected();
    emit(socket, {
      type: "user_transcript",
      user_transcription_event: { user_transcript: "hello world" },
    });
    expect(adapter.lastUserTranscript).toBe("hello world");
    await adapter.disconnect();
  });

  it("captures agent_response onto lastAgentTranscript", async () => {
    const { adapter, socket } = await makeConnected();
    emit(socket, {
      type: "agent_response",
      agent_response_event: { agent_response: "I'm here" },
    });
    expect(adapter.lastAgentTranscript).toBe("I'm here");
    await adapter.disconnect();
  });

  it("agent_response_correction overrides lastAgentTranscript with the corrected text", async () => {
    const { adapter, socket } = await makeConnected();
    emit(socket, {
      type: "agent_response",
      agent_response_event: { agent_response: "draft text" },
    });
    emit(socket, {
      type: "agent_response_correction",
      agent_response_correction_event: {
        original_agent_response: "draft text",
        corrected_agent_response: "post-correction text",
      },
    });
    expect(adapter.lastAgentTranscript).toBe("post-correction text");
    await adapter.disconnect();
  });

  it("warns on conversation_initiation_metadata format drift", async () => {
    const { adapter, socket } = await makeConnected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emit(socket, {
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: {
        conversation_id: "conv_1",
        agent_output_audio_format: "mulaw_8000",
        user_input_audio_format: "pcm_24000",
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/agent_output_audio_format=mulaw_8000/);
    warn.mockRestore();
    await adapter.disconnect();
  });

  it("swallows interruption and unknown events without error", async () => {
    const { adapter, socket } = await makeConnected();
    emit(socket, { type: "interruption", interruption_event: { event_id: "1" } });
    emit(socket, { type: "vad_score", vad_event: { score: 0.5 } });
    emit(socket, { type: "agent_response_metadata", metadata: {} });
    // No throw, no mutation visible to callers. (`client_tool_call` is NOT here:
    // it is a non-audio terminal, covered by its own test below.)
    expect(adapter.lastAgentTranscript).toBeNull();
    expect(adapter.lastUserTranscript).toBeNull();
    await adapter.disconnect();
  });

  it("client_tool_call (tool-only turn) resolves the receiver with an empty chunk", async () => {
    const { adapter, socket } = await makeConnected();
    const recv = adapter.receiveAudio(2);
    emit(socket, {
      type: "client_tool_call",
      client_tool_call: {
        tool_name: "lookup_order",
        tool_call_id: "call_1",
        parameters: { order_id: "42" },
      },
    });
    const chunk = await recv;
    // A tool-only turn yields no spoken audio (this adapter ships no
    // client_tool_result path). The drain must exit cleanly with an empty chunk
    // rather than hanging to the receiveAudio timeout.
    expect(chunk).toBeInstanceOf(AudioChunk);
    expect(chunk.data.length).toBe(0);
    await adapter.disconnect();
  });

  it("ignores non-JSON frames cleanly", async () => {
    const { adapter, socket } = await makeConnected();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    socket.emit("message", Buffer.from("not-json", "utf-8"));
    // Adapter remains usable; next valid event still processes.
    emit(socket, {
      type: "user_transcript",
      user_transcription_event: { user_transcript: "after junk" },
    });
    expect(adapter.lastUserTranscript).toBe("after junk");
    err.mockRestore();
    await adapter.disconnect();
  });

  it("post-open socket error nulls the session and unblocks pending receivers", async () => {
    const { adapter, socket } = await makeConnected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recv = adapter.receiveAudio(2);
    socket.emit("error", new Error("connection lost"));
    const chunk = await recv;
    // Pending waiter resolves with an empty chunk so the executor unwinds
    // rather than hanging. The session is cleared so subsequent sendAudio
    // fails fast instead of writing to a dead socket.
    expect(chunk.data.length).toBe(0);
    await expect(adapter.sendAudio(silentChunk(0.01))).rejects.toThrow(/not connected/);
    warn.mockRestore();
  });

  it("socket close event drains pending waiters", async () => {
    const { adapter, socket } = await makeConnected();
    const recv = adapter.receiveAudio(2);
    socket.emit("close", 1000, Buffer.from("closed"));
    const chunk = await recv;
    expect(chunk.data.length).toBe(0);
  });

  it("receiveAudio rejects with timeout when no audio arrives in time", async () => {
    const { adapter } = await makeConnected();
    await expect(adapter.receiveAudio(0.05)).rejects.toThrow(/timed out/);
    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Continuous mic pump (Strategy B′)
//
// The pump is an always-on mic: while the session is open it feeds a 20 ms frame on
// EVERY tick — queued user-turn PCM during a turn, continuous SILENCE when the
// outbound queue is idle. End-of-turn emerges from the audio→continuous-silence
// transition (EL's server VAD), so there is NO bounded silence tail and NO
// `user_activity` keepalive. These tests drive the real SDK `Conversation` over the
// in-memory FakeWebSocket and assert the frames the pump puts on the wire.
// ---------------------------------------------------------------------------
describe("ElevenLabsAgentAdapter — continuous mic pump (B′)", () => {
  const FRAME_BYTES = 960; // one 20 ms PCM16/24 kHz mono frame

  async function makeConnected(): Promise<{
    adapter: ElevenLabsAgentAdapter;
    socket: FakeWebSocket;
  }> {
    const fake = makeFakeConv();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt-pump",
      apiKey: "sk-pump",
      webSocketFactory: fake.webSocketFactory,
      conversationClient: fake.conversationClient,
    });
    await adapter.connect();
    return { adapter, socket: fake.socket.current! };
  }

  /** Decode a user_audio_chunk frame's base64 payload to raw PCM bytes. */
  const pcmOf = (f: Record<string, unknown>): Buffer =>
    Buffer.from(f.user_audio_chunk as string, "base64");

  it("feeds the closing 960-byte silence frame on every idle tick BEFORE any agent response", async () => {
    const { adapter, socket } = await makeConnected();
    // No sendAudio and no agent response yet, so awaitingUserTurn is false — this is
    // the CLOSING-silence phase. The pump must put 20 ms silence frames on the wire
    // (so EL's server VAD has the audio→silence transition to measure end-of-turn
    // against), rather than going quiet as the old Strategy A did once its bounded
    // tail drained. The POST-response PAUSE (no silence once the agent has replied)
    // is covered by the dedicated #705 test below.
    await flushUntil(() => socket.sent.filter(isUserAudioChunk).length >= 3);

    const idleFrames = socket.sent.filter(isUserAudioChunk).map(pcmOf);
    for (const buf of idleFrames) {
      expect(buf.length).toBe(FRAME_BYTES); // a full 20 ms frame, never a partial
      expect(buf.every((b) => b === 0)).toBe(true); // pure silence
    }
    await adapter.disconnect();
  });

  it(
    "post-response pause (#705): streams closing silence before the agent responds, then feeds NOTHING through the inter-turn gap until the next user turn",
    async () => {
      const { adapter, socket } = await makeConnected();

      // 1) User speaks. The 2 speech frames drain, then the CLOSING silence streams
      //    (awaitingUserTurn is still false). The pump drains the queue before it
      //    emits any silence, so a pure-silence frame here necessarily FOLLOWS the
      //    speech — the audio→silence transition EL's server VAD closes the turn on.
      const speech = new Uint8Array(FRAME_BYTES * 2).fill(0x55);
      await adapter.sendAudio(new AudioChunk({ data: speech }));
      await flushUntil(() => {
        const pcm = socket.sent.filter(isUserAudioChunk).map(pcmOf);
        return (
          pcm.some((b) => b.some((x) => x !== 0)) && // real speech reached the wire
          pcm.some((b) => b.every((x) => x === 0)) //   closing silence followed it
        );
      });
      expect(
        socket.sent.filter(isUserAudioChunk).map(pcmOf).some((b) => b.every((x) => x === 0)),
        "closing silence must stream between the user's speech and the agent's response",
      ).toBe(true);

      // 2) Agent responds — the first agent audio frame (routed by the SDK to
      //    AudioInterface.output → onAgentAudio) flips awaitingUserTurn TRUE.
      emit(socket, {
        type: "audio",
        audio_event: {
          audio_base_64: Buffer.from(
            new Uint8Array([0x01, 0x00, 0x02, 0x00]),
          ).toString("base64"),
        },
      });

      // 3) Post-response PAUSE: with an empty outbound queue and the agent having
      //    responded, the pump must feed NOTHING. emit() is synchronous, so the flag
      //    is already TRUE at this read; let several 20 ms ticks elapse and assert the
      //    user_audio_chunk count does not grow.
      const pausedCount = socket.sent.filter(isUserAudioChunk).length;
      await new Promise((r) => setTimeout(r, 140)); // ~7 pump ticks
      expect(
        socket.sent.filter(isUserAudioChunk).length,
        "the pump must stream NO idle silence into the inter-turn gap once the agent has responded",
      ).toBe(pausedCount);

      // 4) Next user turn RESUMES the mic — enqueueSpeech clears awaitingUserTurn, so
      //    speech (and, after it, closing silence) streams again.
      await adapter.sendAudio(new AudioChunk({ data: speech }));
      await flushUntil(
        () => socket.sent.filter(isUserAudioChunk).length > pausedCount,
      );

      await adapter.disconnect();
    },
  );

  it("enqueueSpeech enqueues only the speech frames — no bounded silence tail (B′ deletes the tail)", async () => {
    const { adapter } = await makeConnected();
    // 3 full frames of non-zero PCM, so speech is distinguishable from silence.
    const speech = new Uint8Array(FRAME_BYTES * 3).fill(0x7f);
    await adapter.sendAudio(new AudioChunk({ data: speech }));

    // Read the outbound queue synchronously right after enqueue. The pump runs on a
    // 20 ms macrotask interval, and no macrotask can run between `await sendAudio`
    // (which resolves via a microtask) and this synchronous read — so the queue
    // holds EXACTLY what enqueueSpeech pushed. Under the old Strategy A it would
    // also carry ~75 appended all-zero silence-tail frames.
    const queue = (adapter as unknown as { outboundFrames: Buffer[] })
      .outboundFrames;
    expect(queue).toHaveLength(3);
    // None of the queued frames is an all-zero silence-tail frame.
    expect(queue.some((f) => f.every((b) => b === 0))).toBe(false);
    await adapter.disconnect();
  });

  it(
    "sends NO user_activity keepalive — B′ removed registerUserActivity (the pump streams audio frames instead)",
    { timeout: 10000 },
    async () => {
      vi.useFakeTimers();
      let adapter: ElevenLabsAgentAdapter | undefined;
      try {
        const connected = await makeConnected();
        adapter = connected.adapter;
        const socket = connected.socket;

        // Advance well past the old 10 s `user_activity` keepalive cadence. No
        // sendAudio and no agent response in this window, so awaitingUserTurn stays
        // false — the pump is in its closing-silence phase the whole time.
        await vi.advanceTimersByTimeAsync(12_000);

        // The old keepalive would have emitted at least one `user_activity` frame by
        // now; B′ emits none …
        expect(
          socket.sent.filter((f) => f.type === "user_activity"),
          "no user_activity keepalive must be sent under B′",
        ).toHaveLength(0);
        // … and the pump streamed 20 ms closing-silence frames the whole time (WS
        // liveness itself is the SDK's ping/pong, not these audio frames).
        expect(socket.sent.filter(isUserAudioChunk).length).toBeGreaterThan(0);
      } finally {
        await adapter?.disconnect();
        vi.useRealTimers();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Keepalive-aware sliding idle deadline (liveness-driven idle-timer reset)
// ---------------------------------------------------------------------------
describe("receiveAudio — keepalive-aware sliding idle deadline", () => {
  // Timing constants
  const TIMEOUT_S = 0.30;
  const NUM_PINGS = 8;
  const PING_GAP_MS = 80;
  const AUDIO_GAP_MS = 80;

  // PCM payload: 8 bytes of valid PCM16 (even-byte count)
  const pcmB64 = Buffer.from("\x12\x34".repeat(4)).toString("base64");

  // Helper: build adapter + connected FakeWebSocket
  async function makeConnected(): Promise<{
    adapter: ElevenLabsAgentAdapter;
    socket: FakeWebSocket;
  }> {
    const fake = makeFakeConv();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt-keepalive",
      apiKey: "sk-keepalive",
      webSocketFactory: fake.webSocketFactory,
      conversationClient: fake.conversationClient,
    });
    await adapter.connect();
    return { adapter, socket: fake.socket.current! };
  }

  it("timing invariant: ping stretch exceeds timeout budget", () => {
    // If this fails, the test scenario is misconfigured — it must be RED on pre-fix code.
    expect(NUM_PINGS * PING_GAP_MS).toBeGreaterThan(TIMEOUT_S * 1000);
  });

  it(
    "AC-KA1: receiveAudio tolerates a silent-but-pinging stretch longer than timeout",
    { timeout: 10000 },
    async () => {
      const { adapter, socket } = await makeConnected();

      // Schedule 8 ping frames at 80 ms real intervals, then one audio frame.
      // Total ping stretch = 640 ms; audio arrives at 720 ms.
      // Fixed-timer code fires at 300 ms → RED.
      // Sliding-deadline code resets on each ping (via the SDK's
      // callbackMessageReceived → onMessage) → GREEN.
      for (let i = 0; i < NUM_PINGS; i++) {
        setTimeout(() => {
          emit(socket, { type: "ping", ping_event: { event_id: i, ping_ms: 5 } });
        }, (i + 1) * PING_GAP_MS);
      }
      setTimeout(() => {
        emit(socket, { type: "audio", audio_event: { audio_base_64: pcmB64 } });
      }, NUM_PINGS * PING_GAP_MS + AUDIO_GAP_MS);

      const start = performance.now();
      const result = await adapter.receiveAudio(TIMEOUT_S);
      const elapsed = performance.now() - start;

      // Resolved with a valid AudioChunk containing the PCM bytes
      expect(result).toBeInstanceOf(AudioChunk);
      expect(result.data.length).toBeGreaterThan(0);

      // Proved we waited past what a fixed timer would have allowed
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_S * 1000);

      await adapter.disconnect();
    },
  );

  it(
    "AC-KA2 regression guard: truly silent socket still times out",
    { timeout: 10000 },
    async () => {
      // No messages emitted — the idle deadline must still fire.
      const { adapter } = await makeConnected();
      await expect(adapter.receiveAudio(TIMEOUT_S)).rejects.toThrow(/timed out/);
      await adapter.disconnect();
    },
  );

  it("AC-KA5: socket close drains cleanly with no surviving timer", { timeout: 5000 }, async () => {
    // Use fake timers so we can inspect surviving timer count after drain.
    vi.useFakeTimers();
    let adapter: ElevenLabsAgentAdapter | undefined;
    try {
      const connected = await makeConnected();
      adapter = connected.adapter;
      const socket = connected.socket;

      // Start a receiveAudio with a long timeout (5s) — we'll close before it fires.
      const receivePromise = adapter.receiveAudio(5);

      // At minimum the two receiveAudio timers (idle deadline + hard ceiling) are
      // live, alongside the session pump interval.
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

      // Emit close — _onWebSocketClose → session_ended → drainPendingWaiters.
      socket.emit("close", 1000, Buffer.from("closed"));

      // The promise resolves to the empty drain chunk.
      const result = await receivePromise;
      expect(result.data.length).toBe(0); // empty chunk = drained, not a real audio payload

      // No surviving timers — the waiter cancelled its timers on drain AND the
      // session-ended handler cleared the pump interval.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await adapter?.disconnect();
      vi.useRealTimers();
    }
  });

  it("hard ceiling fires despite endless keepalive pings (no infinite wedge)", { timeout: 5000 }, async () => {
    // Pings reset the idle deadline forever (the liveness-driven idle-timer reset);
    // without the absolute ceiling, a pings-but-no-audio agent wedges receiveAudio
    // indefinitely (the keepalive-ping wedge). With it, the call must still reject
    // by the ceiling.
    vi.useFakeTimers();
    let adapter: ElevenLabsAgentAdapter | undefined;
    try {
      const connected = await makeConnected();
      adapter = connected.adapter;
      const socket = connected.socket;

      const recv = adapter.receiveAudio(1); // idle 1s; hard ceiling = max(1,45) = 45s
      let rejected = false;
      recv.catch(() => {
        rejected = true;
      });

      // Emit a ping every 0.9s (< the 1s idle deadline, so it always re-arms)
      // across > 45s of fake time. The idle timer never fires; the hard ceiling
      // must.
      for (let t = 0; t < 55; t++) {
        emit(socket, { type: "ping", ping_event: { event_id: t } });
        await vi.advanceTimersByTimeAsync(900);
      }

      expect(rejected, "hard ceiling did not fire despite > 45s of pings").toBe(true);
    } finally {
      await adapter?.disconnect();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// dynamicVariables + overrides passthrough (#705)
//
// The customer's hosted EL agent is personalized PER CALL via a call-init webhook
// keyed on dynamic variables (tenant/org -> system prompt / first message / task
// context). These tests drive the REAL SDK `Conversation` against the in-memory
// FakeWebSocket and assert the SNAKE_CASE init frame (`sent[0]`, the
// `conversation_initiation_client_data`) the SDK actually puts on the wire:
// `conversation_config_override` (deep-merged) and `dynamic_variables` (native
// JSON types, omitted entirely when unset).
// ---------------------------------------------------------------------------
describe("ElevenLabsAgentAdapter — dynamicVariables + overrides passthrough (#705)", () => {
  // Every adapter a test connects is tracked here and torn down in afterEach (the
  // connect path arms a 20 ms pump interval) even if an assertion
  // throws first.
  const live: ElevenLabsAgentAdapter[] = [];

  afterEach(async () => {
    while (live.length > 0) await live.pop()!.disconnect();
    vi.restoreAllMocks();
  });

  /**
   * Connect a fresh adapter (real SDK `Conversation` over the in-memory fake
   * socket) with `extra` options layered onto the required agentId/apiKey + the
   * two test seams, and return the decoded init frame the SDK sent FIRST
   * (`sent[0]`). The adapter is tracked for afterEach teardown.
   */
  async function connectWith(
    extra: Omit<
      ElevenLabsAgentAdapterOptions,
      "agentId" | "apiKey" | "webSocketFactory" | "conversationClient"
    >,
  ): Promise<{
    adapter: ElevenLabsAgentAdapter;
    fake: ReturnType<typeof makeFakeConv>;
    initFrame: Record<string, unknown>;
  }> {
    const fake = makeFakeConv();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt",
      apiKey: "sk",
      webSocketFactory: fake.webSocketFactory,
      conversationClient: fake.conversationClient,
      ...extra,
    });
    live.push(adapter);
    await adapter.connect();
    const initFrame = fake.socket.current!.sent[0];
    // Sanity: sent[0] is the init handshake (no user_audio_chunk/keepalive has
    // raced ahead of it), so every assertion below reads the right frame.
    expect(initFrame).toMatchObject({
      type: "conversation_initiation_client_data",
    });
    return { adapter, fake, initFrame };
  }

  /** Pull `conversation_config_override.agent` off an init frame as an object. */
  const agentOf = (frame: Record<string, unknown>): Record<string, unknown> =>
    (frame.conversation_config_override as Record<string, unknown>)
      .agent as Record<string, unknown>;

  it("AC1: option surface is additive + typed — agentId+apiKey alone still constructs, no field became required", () => {
    // ADDITIVE / not-required: agentId + apiKey ALONE still construct via BOTH the
    // factory and the class. A clean compile of these two lines is the proof that
    // neither `dynamicVariables` nor `overrides` became a required field.
    const viaFactory = elevenLabsAgent({ agentId: "agt", apiKey: "sk" });
    const viaClass = new ElevenLabsAgentAdapter({ agentId: "agt", apiKey: "sk" });
    expect(viaFactory).toBeInstanceOf(ElevenLabsAgentAdapter);
    expect(viaClass).toBeInstanceOf(ElevenLabsAgentAdapter);

    // TYPED (not opaque kwargs forwarding): the options interface is CLOSED, so an
    // unknown key is a COMPILE error. This @ts-expect-error fails `tsc --noEmit`
    // (unused-directive) if the surface ever regresses to an index signature.
    // @ts-expect-error — `notAnOption` is not a valid ElevenLabsAgentAdapterOptions key.
    const bad = () => elevenLabsAgent({ agentId: "agt", apiKey: "sk", notAnOption: 1 });
    void bad;
  });

  it("AC2: dynamicVariables + overrides both reach the init frame as snake_case keys", async () => {
    const { initFrame } = await connectWith({
      dynamicVariables: { tenant_id: "acme", locale: "en" },
      overrides: { agent: { language: "es" }, tts: { stability: 0.4 } },
    });
    expect(initFrame.dynamic_variables).toEqual({ tenant_id: "acme", locale: "en" });
    const cco = initFrame.conversation_config_override as Record<string, unknown>;
    expect(cco).toMatchObject({
      agent: { language: "es" },
      tts: { stability: 0.4 },
    });
  });

  it("AC3: shared `agent` DEEP-merges — caller agent.language AND narrow prompt both survive", async () => {
    const { initFrame } = await connectWith({
      systemPromptOverride: "X",
      overrides: { agent: { language: "es" } },
    });
    const agent = agentOf(initFrame);
    expect((agent.prompt as Record<string, unknown>).prompt).toBe("X");
    expect(agent.language).toBe("es");
  });

  it("AC4: narrow systemPromptOverride WINS over overrides.agent.prompt; JSDoc states the order", async () => {
    const { initFrame } = await connectWith({
      systemPromptOverride: "X",
      overrides: { agent: { prompt: { prompt: "Y" } } },
    });
    const agent = agentOf(initFrame);
    expect((agent.prompt as Record<string, unknown>).prompt).toBe("X");

    // The adapter JSDoc states the precedence order (caller overrides applied
    // first, narrow knobs layered on top).
    const adapterSrc = readFileSync(resolve(HERE, "..", "elevenlabs.ts"), "utf-8");
    expect(adapterSrc).toContain("take precedence over the same keys");
  });

  it("AC5a: both unset -> conversation_config_override is {agent:{}} and NO dynamic_variables key", async () => {
    const { initFrame } = await connectWith({});
    expect(initFrame.conversation_config_override).toEqual({ agent: {} });
    expect("dynamic_variables" in initFrame).toBe(false);
  });

  it("AC5b: regression guard — systemPromptOverride alone is identical to the pre-change frame", async () => {
    const { initFrame } = await connectWith({ systemPromptOverride: "X" });
    expect(initFrame.conversation_config_override).toEqual({
      agent: { prompt: { prompt: "X" } },
    });
    expect("dynamic_variables" in initFrame).toBe(false);
  });

  it("AC6: dynamicVariables keep NATIVE JSON types (number 2 / boolean true, not strings)", async () => {
    const { initFrame } = await connectWith({
      dynamicVariables: { tier: 2, vip: true },
    });
    expect(initFrame.dynamic_variables).toEqual({ tier: 2, vip: true });
    const dv = initFrame.dynamic_variables as Record<string, unknown>;
    expect(typeof dv.tier).toBe("number");
    expect(typeof dv.vip).toBe("boolean");
  });

  it("AC7: adapter contract unchanged — capabilities, role, instanceof, method surface", () => {
    const baseline = new ElevenLabsAgentAdapter({ agentId: "agt", apiKey: "sk" });
    const withOpts = new ElevenLabsAgentAdapter({
      agentId: "agt",
      apiKey: "sk",
      dynamicVariables: { tenant: "acme" },
      overrides: { agent: { language: "es" } },
    });

    expect(withOpts).toBeInstanceOf(VoiceAgentAdapter);
    expect(withOpts.role).toBe(AgentRole.AGENT);
    // Capabilities equality — input/output formats unchanged (pcm16/24000), and
    // identical to a no-options baseline.
    expect(withOpts.capabilities.inputFormats).toEqual(["pcm16/24000"]);
    expect(withOpts.capabilities.outputFormats).toEqual(["pcm16/24000"]);
    expect(withOpts.capabilities.inputFormats).toEqual(
      baseline.capabilities.inputFormats,
    );
    expect(withOpts.capabilities.outputFormats).toEqual(
      baseline.capabilities.outputFormats,
    );
    // Method surface intact — the public lifecycle/IO methods still exist.
    expect(typeof withOpts.connect).toBe("function");
    expect(typeof withOpts.disconnect).toBe("function");
    expect(typeof withOpts.sendAudio).toBe("function");
    expect(typeof withOpts.receiveAudio).toBe("function");
    expect(typeof withOpts.isConnected).toBe("function");
  });

  it("AC8: dynamicVariables are secret-safe — absent from toString() and all console output", async () => {
    const SENTINEL = "SENTINEL_9f3";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { adapter, fake } = await connectWith({
      dynamicVariables: { tenant: SENTINEL },
    });

    // toString() emits only agentId + masked apiKey — never the dynamic variable.
    expect(adapter.toString()).not.toContain(SENTINEL);

    // Force a session error so the adapter's console.warn error path also runs.
    fake.socket.current!.emit("error", new Error("downstream failure"));

    const logged = [...warnSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((arg) => String(arg))
      .join("\n");
    expect(logged).not.toContain(SENTINEL);
  });

  it("AC9: factory JSDoc carries the exact override caveat + a dynamicVariables usage example", () => {
    const factoriesSrc = readFileSync(
      resolve(HERE, "..", "..", "factories.ts"),
      "utf-8",
    );
    // Exact caveat string (EL ignores non-allowlisted overrides server-side).
    expect(factoriesSrc).toContain(
      "applied only if the agent is configured to allow it",
    );
    // A usage example that demonstrates the new dynamicVariables option.
    expect(factoriesSrc).toMatch(/@example[\s\S]*?dynamicVariables/);
  });
});
