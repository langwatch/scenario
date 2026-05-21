/**
 * Unit tests for GeminiLiveAgentAdapter — PR9 of issue #372.
 *
 * Binds the two `@ts-gemini-live` `@unit` scenarios from
 * `specs/voice-agents.feature`:
 *
 *   1. GeminiLiveAgentAdapter connects via native-audio endpoint
 *   2. GeminiLiveAgentAdapter advertises native-audio capabilities matrix
 *
 * The `@google/genai` SDK is mocked at the module level via vitest's
 * `vi.mock` so this file runs offline without a Gemini API key.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { vi, expect } from "vitest";

import { AdapterCapabilities } from "../../capabilities";
import { GeminiLiveAgentAdapter } from "../gemini-live";

// -----------------------------------------------------------------------
// Mock the SDK so connect() never opens a real WebSocket.
// -----------------------------------------------------------------------

interface CapturedConnect {
  model?: string;
  config?: Record<string, unknown>;
}

const captured: { last: CapturedConnect | null } = { last: null };

vi.mock("@google/genai", () => {
  class FakeSession {
    sendRealtimeInput = vi.fn();
    close = vi.fn();
  }
  return {
    Modality: { AUDIO: "AUDIO" },
    GoogleGenAI: class {
      live = {
        connect: async (params: {
          model: string;
          config: Record<string, unknown>;
        }) => {
          captured.last = { model: params.model, config: params.config };
          return new FakeSession();
        },
      };
      constructor(_init: { apiKey?: string }) {}
    },
  };
});

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

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario 1 — Connect via native-audio endpoint
    // -----------------------------------------------------------------------
    Scenario(
      "GeminiLiveAgentAdapter connects via native-audio endpoint",
      ({ Given, When, Then }) => {
        let adapter: GeminiLiveAgentAdapter;

        Given(
          'a GeminiLiveAgentAdapter with model "gemini-2.5-flash-native-audio", voice "Algieba"',
          () => {
            captured.last = null;
            adapter = new GeminiLiveAgentAdapter({
              model: "gemini-2.5-flash-native-audio",
              voice: "Algieba",
              systemInstruction: "You are a helpful tour guide.",
              apiKey: "test-key",
            });
            expect(adapter.model).toBe("gemini-2.5-flash-native-audio");
            expect(adapter.voice).toBe("Algieba");
          },
        );

        When("the scenario starts", async () => {
          await adapter.connect();
        });

        Then(
          "a Gemini Live session is established with the given system_instruction",
          async () => {
            // The mock recorded the connect-params; verify model + system
            // instruction landed correctly, and that AAD is disabled (the
            // explicit-turn-boundary contract Gemini Live relies on).
            expect(captured.last).not.toBeNull();
            expect(captured.last?.model).toBe("gemini-2.5-flash-native-audio");
            const cfg = captured.last?.config as Record<string, unknown> | undefined;
            expect(cfg?.systemInstruction).toBe("You are a helpful tour guide.");
            expect(cfg?.responseModalities).toEqual(["AUDIO"]);
            const realtime = cfg?.realtimeInputConfig as
              | { automaticActivityDetection?: { disabled?: boolean } }
              | undefined;
            expect(realtime?.automaticActivityDetection?.disabled).toBe(true);
            await adapter.disconnect();
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 2 — Capabilities matrix invariants
    // -----------------------------------------------------------------------
    Scenario(
      "GeminiLiveAgentAdapter advertises native-audio capabilities matrix",
      ({ Given, Then, And }) => {
        let adapter: GeminiLiveAgentAdapter;

        Given("a GeminiLiveAgentAdapter", () => {
          adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
          expect(adapter.capabilities).toBeInstanceOf(AdapterCapabilities);
        });

        Then("capabilities.streaming_transcripts is True", () => {
          expect(adapter.capabilities.streamingTranscripts).toBe(true);
        });

        And("capabilities.native_vad is True", () => {
          expect(adapter.capabilities.nativeVad).toBe(true);
        });

        And("capabilities.interruption is True", () => {
          expect(adapter.capabilities.interruption).toBe(true);
        });

        And('capabilities.input_formats include "pcm16/16000"', () => {
          expect(adapter.capabilities.inputFormats).toContain("pcm16/16000");
        });

        And('capabilities.output_formats include "pcm16/24000"', () => {
          expect(adapter.capabilities.outputFormats).toContain("pcm16/24000");
        });
      },
    );
  },
  { includeTags: ["ts-gemini-live"] },
);
