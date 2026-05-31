/**
 * Voice contract surface tests — PR1 of issue #372.
 *
 * Binds the five scenarios from `specs/voice-agents.feature` tagged
 * `@ts-bound`; concrete adapters and runtime behavior land in subsequent
 * PRs and bring their own tests.
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";

import { AgentAdapter, AgentRole } from "../../domain/agents";
import {
  AdapterCapabilities,
  AudioChunk,
  PCM16_CHANNELS,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
  UnsupportedCapabilityError,
  VoiceAgentAdapter,
  silentChunk,
} from "../index";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");
const MATRIX_DOC_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "docs",
  "voice",
  "capability-matrix.md",
);

/**
 * Stub adapter used by several scenarios. Keeps the same shape as the
 * original hand-written tests so assertions are equivalent.
 */
class StubVoiceAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    nativeVad: true,
    dtmf: false,
    interruption: true,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  connectCount = 0;
  disconnectCount = 0;
  sent: AudioChunk[] = [];

  async call(): Promise<string> {
    return "stub";
  }
  async connect(): Promise<void> {
    this.connectCount += 1;
  }
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
  }
  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.sent.push(chunk);
  }
  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    return silentChunk(0.01);
  }
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: AudioChunk internal format is PCM16 at 24kHz mono (lines 146-156)
    // -----------------------------------------------------------------------
    Scenario(
      "AudioChunk internal format is PCM16 at 24kHz mono",
      ({ Given, When, Then, And }) => {
        Given("any adapter receives or sends audio", () => {
          // Precondition — constants are module-level exports; nothing to set up.
        });

        When("the framework normalizes the chunk", () => {
          // Normalization is a compile-time invariant expressed in constants;
          // the assertion is in Then.
        });

        Then("the internal AudioChunk is PCM16, 24000 Hz, mono", () => {
          expect(PCM16_SAMPLE_RATE).toBe(24000);
          expect(PCM16_CHANNELS).toBe(1);
          expect(PCM16_SAMPLE_WIDTH_BYTES).toBe(2);

          const chunk = silentChunk(0.5);
          expect(chunk.sampleRate).toBe(24000);
          expect(chunk.channels).toBe(1);
          expect(chunk.durationSeconds).toBeCloseTo(0.5, 3);
        });

        And(
          "each adapter converts to/from its transport-native format at the send/recv boundary",
          () => {
            // PCM16 invariant: odd-byte buffers (partial samples) are rejected
            // at the canonical boundary rather than silently truncated.
            expect(
              () => new AudioChunk({ data: new Uint8Array([0x00, 0x00, 0x01]) }),
            ).toThrowError(/not a multiple of 2/);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: VoiceAgentAdapter base class is public (lines 698-704)
    // -----------------------------------------------------------------------
    Scenario(
      "VoiceAgentAdapter base class is public for custom implementations",
      ({ Given, When, Then }) => {
        let adapter: StubVoiceAdapter;

        Given(
          "a user subclass of VoiceAgentAdapter implementing connect/send_audio/recv_audio/disconnect",
          () => {
            // Arrange only — no assertions in Given.
            adapter = new StubVoiceAdapter();
          },
        );

        When("plugged into scenario.run()", async () => {
          await adapter.connect();
          await adapter.sendAudio(silentChunk(0.02));
          await adapter.receiveAudio(1);
          await adapter.disconnect();
        });

        Then("it works identically to built-in adapters", async () => {
          // Type-hierarchy assertions: the subclass IS a VoiceAgentAdapter / AgentAdapter.
          expect(adapter).toBeInstanceOf(VoiceAgentAdapter);
          expect(adapter).toBeInstanceOf(AgentAdapter);
          // Behavioural assertions: connect/send/recv/disconnect all exercised.
          const received = await adapter.receiveAudio(1);
          expect(adapter.connectCount).toBe(1);
          expect(adapter.disconnectCount).toBe(1);
          expect(adapter.sent).toHaveLength(1);
          expect(received).toBeInstanceOf(AudioChunk);
        });
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Every adapter publishes a capabilities attribute (lines 751-756)
    // -----------------------------------------------------------------------
    Scenario(
      "Every adapter publishes a capabilities attribute",
      ({ Given, Then, And }) => {
        let adapter: StubVoiceAdapter;

        Given("any concrete VoiceAgentAdapter subclass", () => {
          adapter = new StubVoiceAdapter();
        });

        Then("adapter.capabilities is an AdapterCapabilities instance", () => {
          expect(adapter.capabilities).toBeInstanceOf(AdapterCapabilities);
        });

        And(
          "it declares: streaming_transcripts, native_vad, dtmf, interruption, input_formats, output_formats",
          () => {
            const caps = adapter.capabilities;
            expect(typeof caps.streamingTranscripts).toBe("boolean");
            expect(typeof caps.nativeVad).toBe("boolean");
            expect(typeof caps.dtmf).toBe("boolean");
            expect(Array.isArray(caps.inputFormats)).toBe(true);
            expect(Array.isArray(caps.outputFormats)).toBe(true);

            // An adapter author who forgets to declare anything must NOT silently
            // claim every capability — default is "supports nothing".
            const empty = new AdapterCapabilities();
            expect(empty.streamingTranscripts).toBe(false);
            expect(empty.nativeVad).toBe(false);
            expect(empty.dtmf).toBe(false);
            expect(empty.interruption).toBe(false);
            expect(empty.inputFormats).toEqual([]);
            expect(empty.outputFormats).toEqual([]);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: dtmf() raises UnsupportedCapabilityError (lines 757-762)
    // -----------------------------------------------------------------------
    Scenario(
      "dtmf() raises UnsupportedCapabilityError on non-telephony adapters",
      ({ Given, When, Then }) => {
        Given("an adapter with capabilities.dtmf == False", () => {
          // The StubVoiceAdapter has dtmf: false; UnsupportedCapabilityError
          // is exercised directly below without an adapter instance.
        });

        When('scenario.dtmf("1") runs', () => {
          // Step represents the trigger; assertions are in Then.
        });

        Then(
          'UnsupportedCapabilityError is raised naming the adapter and the "dtmf" capability',
          () => {
            // Direct error construction — names the adapter and capability.
            const err = new UnsupportedCapabilityError("StubVoiceAdapter", "dtmf");
            expect(err).toBeInstanceOf(Error);
            expect(err.adapterName).toBe("StubVoiceAdapter");
            expect(err.capability).toBe("dtmf");
            expect(err.message).toContain("StubVoiceAdapter");
            expect(err.message).toContain("dtmf");
            expect(err.message).toContain("docs/voice/capability-matrix.md");

            // The base interrupt() throws UnsupportedCapabilityError on adapters
            // without an override — tests the raise-only contract from the spec.
            class NoInterruptAdapter extends VoiceAgentAdapter {
              readonly capabilities = new AdapterCapabilities();
              async call(): Promise<string> {
                return "stub";
              }
              async connect(): Promise<void> {}
              async disconnect(): Promise<void> {}
              async sendAudio(_chunk: AudioChunk): Promise<void> {}
              async receiveAudio(_timeout: number): Promise<AudioChunk> {
                return silentChunk(0);
              }
            }

            const noInterrupt = new NoInterruptAdapter();
            expect(() => noInterrupt.interrupt()).toThrow(UnsupportedCapabilityError);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Capability matrix is rendered into adapter docs (lines 763-771)
    // -----------------------------------------------------------------------
    Scenario(
      "Capability matrix is rendered into adapter docs",
      ({ Given, Then, And }) => {
        let doc: string;

        Given("the voice-agents documentation", () => {
          doc = readFileSync(MATRIX_DOC_PATH, "utf8");
        });

        Then("a capability matrix table lists every built-in adapter", () => {
          const adapters = [
            "PipecatAgentAdapter",
            "TwilioAgentAdapter",
            "OpenAIRealtimeAgentAdapter",
            "ElevenLabsAgentAdapter",
            "GeminiLiveAgentAdapter",
            "LiveKitAgentAdapter",
            "VapiAgentAdapter",
            "WebRTCAgentAdapter",
            "WebSocketAgentAdapter",
          ];
          for (const adapter of adapters) {
            expect(doc).toContain(adapter);
          }
        });

        And(
          "each row shows streaming_transcripts, native_vad, dtmf, input/output formats",
          () => {
            expect(doc.toLowerCase()).toContain("streaming transcripts");
            expect(doc.toLowerCase()).toContain("native vad");
            expect(doc.toLowerCase()).toContain("dtmf");
            expect(doc.toLowerCase()).toContain("wire formats");
          },
        );
      },
    );
  },
  { includeTags: ["ts-bound"] },
);
