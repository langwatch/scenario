/**
 * STT plumbing tests — PR2 of issue #372.
 *
 * Binds the `specs/voice-agents.feature` scenarios tagged `@ts-bound` for:
 * default STT model, provider swap, interface minimality, and >25-minute
 * audio chunking.
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

import { AudioChunk, silentChunk } from "../audio-chunk";
import {
  OPENAI_TRANSCRIBE_LIMIT_SECONDS,
  OpenAISTTProvider,
  getSttProvider,
  setSttProvider,
  type STTProvider,
} from "../stt";
import { OPENAI_STT_MODEL } from "../voice-models";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");

type OpenAILike = {
  audio: {
    transcriptions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
};

function makeMockOpenAI(text = "transcribed"): OpenAILike {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text }),
      },
    },
  };
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: Default STT provider is OpenAI gpt-4o-transcribe
    // -----------------------------------------------------------------------
    Scenario(
      "Default STT provider is OpenAI gpt-4o-transcribe",
      ({ Given, And, When, Then }) => {
        let provider: OpenAISTTProvider;

        Given("no scenario.configure(stt=...) has been called", () => {
          // Reset to default to isolate from any prior test.
          setSttProvider(new OpenAISTTProvider());
          provider = new OpenAISTTProvider();
        });

        And("a conversation contains an audio turn", () => {
          // The audio turn is represented by the provider being ready to transcribe.
          expect(provider.model).toBe(OPENAI_STT_MODEL);
        });

        When("the judge requests a transcript", async () => {
          const mock = makeMockOpenAI("hi");
          const configured = new OpenAISTTProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            openaiClient: mock as any,
          });
          await configured.transcribe(silentChunk(0.5));

          // Capture the call args for the Then assertion.
          const args = mock.audio.transcriptions.create.mock.calls[0][0];
          expect(args.model).toBe("gpt-4o-transcribe");
        });

        Then(
          'the SDK uses openai.audio.transcriptions with model "gpt-4o-transcribe"',
          () => {
            expect(provider.model).toBe("gpt-4o-transcribe");
            expect(provider.model).toBe(OPENAI_STT_MODEL);
            // The global default is an OpenAISTTProvider instance.
            expect(getSttProvider()).toBeInstanceOf(OpenAISTTProvider);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Users swap STT providers via scenario.configure
    // -----------------------------------------------------------------------
    Scenario(
      "Users swap STT providers via scenario.configure",
      ({ Given, When, And, Then }) => {
        let custom: STTProvider;
        const prior = getSttProvider();

        Given("a custom STTProvider implementation", () => {
          class MyProvider implements STTProvider {
            async transcribe(_audio: AudioChunk): Promise<string> {
              return "custom";
            }
          }
          custom = new MyProvider();
        });

        When("scenario.configure(stt=CustomProvider()) is called", () => {
          setSttProvider(custom);
        });

        And("the judge requests a transcript", async () => {
          const spy = vi.fn().mockResolvedValue("from-custom-provider");
          const spyProvider: STTProvider = { transcribe: spy };
          setSttProvider(spyProvider);
          const result = await getSttProvider()!.transcribe(silentChunk(0.01));
          expect(spy).toHaveBeenCalledTimes(1);
          expect(result).toBe("from-custom-provider");
          // Restore the custom for Then assertion.
          setSttProvider(custom);
        });

        Then(
          "the custom provider's transcribe() is invoked instead of the default",
          () => {
            expect(getSttProvider()).toBe(custom);
            // Restore previous provider after test.
            setSttProvider(prior);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: STT provider interface is minimal and provider-agnostic
    // -----------------------------------------------------------------------
    Scenario(
      "STT provider interface is minimal and provider-agnostic",
      ({ Given, Then, And }) => {
        let minimal: STTProvider;

        Given("the STTProvider abstract base class", () => {
          // The interface is intentionally tiny — a single async method.
          minimal = {
            transcribe: async (audio: AudioChunk): Promise<string> => {
              expect(audio).toBeInstanceOf(AudioChunk);
              return "ok";
            },
          };
        });

        Then("it defines async transcribe(audio: AudioChunk) -> str", async () => {
          const result = await minimal.transcribe(silentChunk(0.01));
          expect(result).toBe("ok");
        });

        And("no OpenAI-specific types leak into the interface", () => {
          // Structural check: a plain object literal satisfies STTProvider
          // without importing any OpenAI-specific type.
          const p: STTProvider = {
            async transcribe(audio) {
              return audio.transcript ?? "";
            },
          };
          expect(p).toBeDefined();
        });
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Transcription chunks audio longer than 25 minutes
    // -----------------------------------------------------------------------
    Scenario(
      "Transcription chunks audio longer than 25 minutes",
      ({ Given, When, Then }) => {
        let mock: OpenAILike;
        let provider: OpenAISTTProvider;

        Given("an audio turn exceeding 25 minutes in the default STT provider", () => {
          // The constant must match the documented 25-minute limit.
          expect(OPENAI_TRANSCRIBE_LIMIT_SECONDS).toBe(25 * 60);

          // Use a synthetic 1-second limit so the test runs on a small buffer.
          mock = makeMockOpenAI();
          let call = 0;
          mock.audio.transcriptions.create.mockImplementation(async () => ({
            text: `seg${++call}`,
          }));
          provider = new OpenAISTTProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            openaiClient: mock as any,
            transcribeLimitSeconds: 1,
          });
        });

        When("transcription is requested", async () => {
          // 2.5s at 1s limit → 3 sub-calls (1s, 1s, 0.5s).
          const result = await provider.transcribe(silentChunk(2.5));
          expect(mock.audio.transcriptions.create).toHaveBeenCalledTimes(3);
          expect(result).toBe("seg1 seg2 seg3");
        });

        Then("the audio is split into chunks under the limit and concatenated", async () => {
          // Audio under the limit → single request.
          const shortMock = makeMockOpenAI("short");
          const shortProvider = new OpenAISTTProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            openaiClient: shortMock as any,
            transcribeLimitSeconds: 2,
          });
          const text = await shortProvider.transcribe(silentChunk(1));
          expect(shortMock.audio.transcriptions.create).toHaveBeenCalledTimes(1);
          expect(text).toBe("short");

          // Empty sub-chunk transcripts are dropped from the joined result.
          const emptyMock = makeMockOpenAI();
          let emptyCall = 0;
          emptyMock.audio.transcriptions.create.mockImplementation(async () => {
            emptyCall += 1;
            return { text: emptyCall === 2 ? "" : `seg${emptyCall}` };
          });
          const emptyProvider = new OpenAISTTProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            openaiClient: emptyMock as any,
            transcribeLimitSeconds: 1,
          });
          const joined = await emptyProvider.transcribe(silentChunk(2.5));
          expect(joined).toBe("seg1 seg3");
        });
      },
    );
  },
  { includeTags: ["ts-stt"] },
);
