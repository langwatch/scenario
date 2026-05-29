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
import { vi, expect, describe, it, beforeEach } from "vitest";

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
  // `captured` is a module-level mutable singleton; reset before each test
  // in this describe block to prevent implicit ordering between the BDD
  // scenarios above and these standalone unit tests.
  beforeEach(() => {
    captured.last = null;
  });

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
      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      // connect() must have registered the onmessage callback.
      // Cast: TypeScript CFA narrowed captured.last to null by the beforeEach
      // reset, but connect() mutates it inside the mock.
      const onmessage = (captured.last as CapturedConnect | null)?.onmessage;
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
      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      const onmessage = (captured.last as CapturedConnect | null)?.onmessage;
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
      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      const onmessage = (captured.last as CapturedConnect | null)?.onmessage;
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

  it(
    "handles concurrent interrupt() + receiveAudio() without queue starvation",
    async () => {
      // Regression test for the single-consumer dequeue() concurrency race.
      //
      // Prior bug: interrupt() called dequeue() concurrently with receiveAudio().
      // The single `resolveNext` slot was overwritten by the second caller
      // (interrupt), leaving receiveAudio's resolver orphaned. The timer fired
      // with TimeoutError → drainAgentResponse caught and broke prematurely.
      //
      // With the abort-sentinel fix: interrupt() sets _interruptPending + wakes
      // any in-flight dequeue() via the resolver directly. receiveAudio() checks
      // the flag after each dequeue() await and returns the cut-off sentinel.
      //
      // Without the fix: receiveAudio() would hang until its timer fires
      // (TimeoutError), not resolve promptly with the cut-off sentinel.
      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      const onmessage = (captured.last as CapturedConnect | null)?.onmessage;
      expect(onmessage, "connect() did not register an onmessage callback").toBeDefined();

      // Start receiveAudio() in one async context — it will suspend in dequeue()
      // waiting for a message (nothing in the queue yet).
      const receivePromise = adapter.receiveAudio(5); // 5s budget

      // Fire interrupt() from another async context, after a tick, so
      // receiveAudio() is suspended in dequeue() when interrupt() runs.
      // interrupt() must NOT compete on resolveNext — it uses the abort-sentinel.
      await Promise.resolve(); // yield to let receiveAudio enter dequeue()
      await adapter.interrupt();

      // receiveAudio() must resolve promptly (not timeout) with the cut-off
      // sentinel (empty data — the interrupt cut off the in-flight turn).
      const chunk = await receivePromise;

      // Cut-off sentinel: empty data, NOT a TimeoutError.
      expect(
        chunk.data.length,
        "receiveAudio() did not return the cut-off sentinel (empty data) after interrupt() — " +
          "it may have timed out or returned stale audio. " +
          "The dequeue() resolveNext slot race was not fixed.",
      ).toBe(0);

      await adapter.disconnect();
    },
  );

  it(
    "extends the deadline after the spurious pair so delayed recovery audio " +
      "is captured within the same receiveAudio() call (iterator-restart semantic)",
    async () => {
      // Models the live-executor timing race: the spurious pair arrives
      // during receiveAudio(), but Gemini's actual recovery reply is delayed
      // by 600 ms — intentionally longer than the 0.5 s original timeout.
      // The pair is pre-loaded synchronously before receiveAudio() is called
      // so it is absorbed in ~1 ms, leaving ~499 ms on the original deadline.
      // The recovery audio arrives at ~600 ms — 101 ms past the original
      // deadline. WITHOUT the deadline extension the dequeue would time out.
      // WITH SPURIOUS_PAIR_RECOVERY_MS the deadline becomes now+10 s after
      // the spurious pair fires, so 600 ms is well within budget.
      const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key" });
      await adapter.connect();

      const onmessage = (captured.last as CapturedConnect | null)?.onmessage;
      expect(onmessage, "connect() did not register an onmessage callback").toBeDefined();

      const audioB64 = makeAudioB64();

      // Push the spurious pair immediately (no delay).
      onmessage!({ serverContent: { interrupted: true } });
      onmessage!({ serverContent: { turnComplete: true } });

      // Schedule the real recovery audio 600 ms later — LONGER than the
      // original 0.5 s budget. Without the deadline extension the dequeue
      // call would time out after 500 ms (before the recovery arrives).
      // With SPURIOUS_PAIR_RECOVERY_MS the deadline becomes now+10 s, so
      // the 600 ms delay is well within budget.
      const DELAY_MS = 600;
      setTimeout(() => {
        onmessage!({
          serverContent: {
            modelTurn: {
              parts: [{ inlineData: { mimeType: "audio/pcm", data: audioB64 } }],
            },
          },
        });
        onmessage!({ serverContent: { turnComplete: true } });
      }, DELAY_MS);

      // 0.5 s original budget — recovery arrives at 600 ms, which exceeds
      // the original timeout but falls within the SPURIOUS_PAIR_RECOVERY_MS
      // extended deadline.
      const chunk = await adapter.receiveAudio(0.5);

      expect(
        chunk.data.length,
        "receiveAudio() did not capture the delayed recovery audio — the " +
          "deadline extension after the spurious pair is not working.",
      ).toBeGreaterThan(0);

      await adapter.disconnect();
    },
  );
});
