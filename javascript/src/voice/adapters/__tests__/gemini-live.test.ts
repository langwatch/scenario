/**
 * Unit tests for GeminiLiveAgentAdapter — PR9 of issue #372.
 *
 * Binds the two `@ts-gemini-live` `@unit` scenarios from
 * `specs/voice-agents.feature`:
 *
 *   1. GeminiLiveAgentAdapter connects via native-audio endpoint
 *   2. GeminiLiveAgentAdapter advertises native-audio capabilities matrix
 *
 * Also contains a standalone unit suite that proves the spurious-pair
 * handling in `receiveAudio()` (the `[interrupted:true, turnComplete:true]`
 * sequence the server emits on a barge-in):
 *
 *   3. receiveAudio() absorbs the spurious pair and returns the recovery audio
 *      in a SINGLE call — the demo's two-agent() workaround is redundant.
 *
 * The `@google/genai` SDK is mocked at the module level via vitest's
 * `vi.mock` so this file runs offline without a Gemini API key.
 */

import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { vi, expect, describe, it } from "vitest";

import { AdapterCapabilities } from "../../capabilities";
import { GeminiLiveAgentAdapter } from "../gemini-live";

// -----------------------------------------------------------------------
// Mock the SDK so connect() never opens a real WebSocket.
// -----------------------------------------------------------------------

interface CapturedConnect {
  model?: string;
  config?: Record<string, unknown>;
  onmessage?: (msg: unknown) => void;
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
          callbacks?: { onmessage?: (msg: unknown) => void };
        }) => {
          captured.last = {
            model: params.model,
            config: params.config,
            onmessage: params.callbacks?.onmessage,
          };
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

// -----------------------------------------------------------------------
// Standalone unit suite: spurious-pair handling in receiveAudio()
//
// The question: when the server emits the spurious
//   [{ interrupted: true }, { turnComplete: true }]
// pair (which Gemini sends on a barge-in — the cancelled-turn boundary
// landing after the activityStart for the recovery turn), does the
// adapter's `continue` in receiveAudio() re-enter the dequeue loop and
// read the recovery audio in the SAME receiveAudio() call?
//
// If YES → the demo's second scenario.agent() is redundant.
// If NO  → the adapter has a latent gap papered over by the demo.
// -----------------------------------------------------------------------

describe("GeminiLiveAgentAdapter — spurious-pair handling in receiveAudio()", () => {
  /**
   * Build a minimal real-PCM16 payload that survives AudioChunk's
   * even-byte invariant. Two zero samples = 4 bytes = valid PCM16.
   */
  function makeAudioB64(): string {
    // 4 bytes: two int16 zero samples, little-endian
    return Buffer.from(new Uint8Array([0, 0, 0, 0])).toString("base64");
  }

  it(
    "absorbs the spurious [interrupted, turnComplete] pair and returns the " +
      "recovery audio in a single receiveAudio() call",
    async () => {
      // Reset the captured state so this test doesn't see stale callbacks
      // from earlier BDD scenarios.
      captured.last = null;

      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      // connect() must have registered the onmessage callback.
      const onmessage = captured.last?.onmessage;
      expect(onmessage, "connect() did not register an onmessage callback").toBeDefined();

      // Pre-load the internal queue with the full barge-in sequence:
      //
      //   1. { serverContent: { interrupted: true } }     — spurious pair start
      //   2. { serverContent: { turnComplete: true } }    — spurious pair end
      //   3. { serverContent: { modelTurn: { parts: [audio] } } } — real reply
      //   4. { serverContent: { turnComplete: true } }    — real turn end
      //
      // All four are pushed synchronously before receiveAudio() is called,
      // so they are already in the queue when the loop starts.
      const audioB64 = makeAudioB64();
      onmessage!({ serverContent: { interrupted: true } });
      onmessage!({ serverContent: { turnComplete: true } });
      onmessage!({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm", data: audioB64 } }],
          },
        },
      });
      onmessage!({ serverContent: { turnComplete: true } });

      // Single receiveAudio() call — must skip the spurious pair via `continue`
      // and return the real recovery audio chunk (non-empty data).
      const chunk = await adapter.receiveAudio(5);

      // The returned chunk must carry the real audio bytes, not an empty
      // end-of-turn sentinel. If the spurious-pair `continue` does NOT
      // re-enter the loop within the same call, receiveAudio() would have
      // returned an empty AudioChunk (the end-of-spurious-turn sentinel)
      // and this assertion would fail — exposing the latent gap.
      expect(
        chunk.data.length,
        "receiveAudio() returned an empty chunk — the spurious [interrupted, " +
          "turnComplete] pair was not absorbed in the same call. The `continue` " +
          "did NOT re-enter the dequeue loop. The demo's second scenario.agent() " +
          "is NOT redundant; the adapter has a latent gap.",
      ).toBeGreaterThan(0);

      await adapter.disconnect();
    },
  );

  it(
    "does NOT swallow a real turnComplete that follows actual audio " +
      "(only the spurious no-audio interrupted-pair is skipped)",
    async () => {
      captured.last = null;

      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      const onmessage = captured.last?.onmessage;
      expect(onmessage).toBeDefined();

      // A real turn: audio first, then turnComplete (no interrupted flag).
      // receiveAudio() should return the audio chunk immediately (not loop).
      const audioB64 = makeAudioB64();
      onmessage!({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm", data: audioB64 } }],
          },
        },
      });
      onmessage!({ serverContent: { turnComplete: true } });

      const chunk = await adapter.receiveAudio(5);
      expect(chunk.data.length, "real audio turn returned empty chunk").toBeGreaterThan(0);

      await adapter.disconnect();
    },
  );

  it(
    "returns an empty AudioChunk (end-of-turn sentinel) when the interrupted " +
      "pair is followed immediately by turnComplete with no recovery audio",
    async () => {
      // This is NOT the normal barge-in path — it tests that the adapter
      // doesn't loop forever on an interrupted-only turn with nothing after it.
      captured.last = null;

      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      const onmessage = captured.last?.onmessage;
      expect(onmessage).toBeDefined();

      // Spurious pair only — no recovery audio follows.
      // After swallowing the spurious pair, the adapter loops back to dequeue.
      // Push a real turnComplete (no audio) so it exits cleanly.
      onmessage!({ serverContent: { interrupted: true } });
      onmessage!({ serverContent: { turnComplete: true } });
      // A bare turnComplete with no audio and no interrupted flag is a
      // real end-of-turn — the loop should exit.
      onmessage!({ serverContent: { turnComplete: true } });

      const chunk = await adapter.receiveAudio(5);
      // Empty: the second turnComplete is a real end-of-turn (no audio anywhere).
      expect(chunk.data.length, "expected empty sentinel for bare turn").toBe(0);

      await adapter.disconnect();
    },
  );
});
