/**
 * Binds 5 scenarios from `specs/voice-agents.feature` tagged
 * `@ts-elevenlabs` and `@unit`. Each scenario exercises the PR7 surface:
 * the hosted {@link ElevenLabsAgentAdapter} WS connect/send, plus the
 * composable + branded path (STT + LLM + TTS).
 *
 * No real network is hit — `WebSocket`, LanguageModel, ElevenLabs SDK,
 * and STT are stubbed via factory injection.
 *
 * Tag convention: `@ts-elevenlabs` (per-subject) instead of `@ts-bound`
 * to avoid colliding with PR1's `voice-contract-surface.test.ts` which
 * uses `includeTags: ["ts-bound"]`. Per-subject tagging matches PR #517,
 * #528, and #523's tag-convention decision.
 */
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import type { LanguageModel } from "ai";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { describe, it, expect, vi } from "vitest";

import { AudioChunk, silentChunk } from "../../audio-chunk";
import { VoiceAgentAdapter } from "../../adapter";
import { ELEVENLABS_DEFAULT_VOICE_ID } from "../../voice-models";
import {
  ComposableVoiceAgent,
  ElevenLabsAgentAdapter,
  ElevenLabsSTTProvider,
  ElevenLabsVoiceAgent,
  type STTProvider,
  type WebSocketLike,
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

/**
 * In-memory fake of the `ws` WebSocket. Tracks `send()` payloads as
 * decoded objects so tests can assert on the wire-shape without
 * round-tripping through JSON in every assertion.
 *
 * `EventEmitter`'s `on`/`once` are generic listeners; the
 * {@link WebSocketLike} contract narrows them per event. Casting through
 * `WebSocketLike` once at the factory boundary keeps the test code typed
 * without rewriting every `super.on` overload.
 */
class FakeWebSocket extends EventEmitter {
  sent: unknown[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
}

function makeFakeSocketFactory(): {
  factory: (url: string, headers: Record<string, string>) => WebSocketLike;
  url: { current: string | null };
  headers: { current: Record<string, string> | null };
  socket: { current: FakeWebSocket | null };
} {
  const urlRef: { current: string | null } = { current: null };
  const headersRef: { current: Record<string, string> | null } = { current: null };
  const socketRef: { current: FakeWebSocket | null } = { current: null };
  const factory = (url: string, headers: Record<string, string>) => {
    urlRef.current = url;
    headersRef.current = headers;
    const socket = new FakeWebSocket();
    socketRef.current = socket;
    queueMicrotask(() => socket.emit("open"));
    return socket as unknown as WebSocketLike;
  };
  return { factory, url: urlRef, headers: headersRef, socket: socketRef };
}

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
        const fake = makeFakeSocketFactory();

        Given("an ElevenLabsAgentAdapter with agent_id and api_key", () => {
          adapter = new ElevenLabsAgentAdapter({
            agentId: "agt_test_123",
            apiKey: "sk_fake_abc",
            webSocketFactory: fake.factory,
          });
        });

        When("the scenario starts", async () => {
          await adapter.connect();
        });

        Then(
          "a WebSocket to wss://api.elevenlabs.io/v1/convai/conversation?agent_id=... is opened",
          () => {
            expect(fake.url.current).toBe(
              "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agt_test_123",
            );
            expect(fake.headers.current).toEqual({ "xi-api-key": "sk_fake_abc" });
            // First frame after connect must be the session-init message —
            // observed by the Python adapter to be required for reliable
            // first_message delivery.
            expect(fake.socket.current?.sent[0]).toMatchObject({
              type: "conversation_initiation_client_data",
            });
          },
        );

        And("PCM16 audio chunks are sent over the socket", async () => {
          const speech = new Uint8Array([0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00]);
          await adapter.sendAudio(new AudioChunk({ data: speech }));
          const frames = fake.socket.current!.sent as Array<Record<string, string>>;
          // [init, speech, silence-tail]
          expect(frames).toHaveLength(3);
          expect(frames[1]).toMatchObject({ user_audio_chunk: expect.any(String) });
          expect(frames[2]).toMatchObject({ user_audio_chunk: expect.any(String) });
          const speechB64 = Buffer.from(speech).toString("base64");
          expect(frames[1].user_audio_chunk).toBe(speechB64);
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
                elevenLabsClientFactory: () => makeFakeElevenClient(ttsCalls.text),
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

function makeFakeElevenClient(recordedText: string[]): never {
  const fake = {
    textToSpeech: {
      convert: vi.fn(async (_voiceId: string, request: { text: string }) => {
        recordedText.push(request.text);
        // Return an async iterable of one PCM16 chunk.
        const buf = Buffer.from(new Uint8Array([0x01, 0x00, 0x02, 0x00]));
        return (async function* () {
          yield buf;
        })();
      }),
    },
  };
  return fake as never;
}

// -----------------------------------------------------------------------------
// Wire-protocol unit tests for `ElevenLabsAgentAdapter.onMessage` branches.
//
// These exercise each event type the EL ConvAI socket emits — kept separate
// from the cucumber-bound scenarios because the AC ("ElevenLabsAgentAdapter
// connects ...") covers connect+send, while the recv path branches deserve
// their own assertions. Driven by emitting fake frames on the FakeWebSocket
// after `connect()` resolves.
// -----------------------------------------------------------------------------
describe("ElevenLabsAgentAdapter wire-protocol (onMessage branches)", () => {
  async function makeConnected(): Promise<{
    adapter: ElevenLabsAgentAdapter;
    socket: FakeWebSocket;
  }> {
    const fake = makeFakeSocketFactory();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt",
      apiKey: "sk",
      webSocketFactory: fake.factory,
    });
    await adapter.connect();
    return { adapter, socket: fake.socket.current! };
  }

  function emit(socket: FakeWebSocket, event: Record<string, unknown>): void {
    socket.emit("message", Buffer.from(JSON.stringify(event), "utf-8"));
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

  it("replies to a ping event with a pong carrying the event_id", async () => {
    const { adapter, socket } = await makeConnected();
    // Discard the init frame so our pong is at a known index.
    socket.sent.length = 0;
    emit(socket, { type: "ping", ping_event: { event_id: 42, ping_ms: 100 } });
    expect(socket.sent[0]).toEqual({ type: "pong", event_id: 42 });
    await adapter.disconnect();
  });

  it("skips pong when ping has no event_id (defensive)", async () => {
    const { adapter, socket } = await makeConnected();
    socket.sent.length = 0;
    emit(socket, { type: "ping" });
    expect(socket.sent).toHaveLength(0);
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
    emit(socket, { type: "interruption" });
    emit(socket, { type: "vad_score", vad_event: { score: 0.5 } });
    emit(socket, { type: "client_tool_call", payload: {} });
    // No throw, no mutation visible to callers.
    expect(adapter.lastAgentTranscript).toBeNull();
    expect(adapter.lastUserTranscript).toBeNull();
    await adapter.disconnect();
  });

  it("ignores non-JSON frames cleanly", async () => {
    const { adapter, socket } = await makeConnected();
    socket.emit("message", Buffer.from("not-json", "utf-8"));
    // Adapter remains usable; next valid event still processes.
    emit(socket, {
      type: "user_transcript",
      user_transcription_event: { user_transcript: "after junk" },
    });
    expect(adapter.lastUserTranscript).toBe("after junk");
    await adapter.disconnect();
  });

  it("post-open socket error nulls this.ws and unblocks pending receivers", async () => {
    const { adapter, socket } = await makeConnected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recv = adapter.receiveAudio(2);
    socket.emit("error", new Error("connection lost"));
    const chunk = await recv;
    // Pending waiter resolves with an empty chunk so the executor unwinds
    // rather than hanging. The ws reference is cleared so subsequent
    // sendAudio fails fast instead of writing to a dead socket.
    expect(chunk.data.length).toBe(0);
    await expect(adapter.sendAudio(silentChunk(0.01))).rejects.toThrow(/not connected/);
    warn.mockRestore();
  });

  it("socket close event drains pending waiters", async () => {
    const { adapter, socket } = await makeConnected();
    const recv = adapter.receiveAudio(2);
    socket.emit("close");
    const chunk = await recv;
    expect(chunk.data.length).toBe(0);
  });

  it("receiveAudio rejects with timeout when no audio arrives in time", async () => {
    const { adapter } = await makeConnected();
    await expect(adapter.receiveAudio(0.05)).rejects.toThrow(/timed out/);
    await adapter.disconnect();
  });
});
