/**
 * User simulator voice-path tests — PR4 of issue #372.
 *
 * Binds 4 scenarios from `specs/voice-agents.feature` tagged `@ts-simulator`.
 * Each scenario exercises the voice path of {@link UserSimulatorAgent} without
 * making real LLM or TTS calls — all external I/O is replaced by vitest spies.
 *
 * Tag convention: `@ts-simulator` (per-subject, not `@ts-bound`) to avoid
 * over-matching PR1's voice-contract-surface.test.ts which uses
 * `includeTags: ["ts-bound"]`. See issue #523 for the tag-convention decision.
 *
 * Note: the `Per-step voice override applies to only that step` scenario in
 * specs/voice-agents.feature stays @todo for the AUDIBLE voiceStyle effect —
 * no TTS backend changes timbre by style yet (the simulator emits a one-shot
 * warning). The per-step override PLUMBING (voiceStyle/audioEffects installed
 * for one turn, then reverted) is wired and covered by
 * `script/__tests__/interrupt-after-and-user-overrides.test.ts`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

import { AudioChunk } from "../../voice/audio-chunk";
import { makeChunk } from "./fixtures/make-chunk";
import { extractAudio, messageHasAudio } from "../../voice/messages";
import { userSimulatorAgent, type UserSimulatorAgentConfig } from "../user-simulator-agent";
import type { AgentInput } from "../../domain";

// Mock getProjectConfig to avoid filesystem dependency in unit tests.
vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Build a minimal {@link AgentInput} stub sufficient for user simulator tests.
 * The simulator only reads `scenarioConfig.description` and `messages`.
 */
function makeInput(messages: unknown[] = []): AgentInput {
  return {
    threadId: "test-thread",
    messages: messages as AgentInput["messages"],
    newMessages: [],
    requestedRole: "User" as AgentInput["requestedRole"],
    scenarioConfig: {
      name: "test",
      description: "A test scenario description",
    } as AgentInput["scenarioConfig"],
    scenarioState: {
      config: {},
      description: "A test scenario description",
      get messages() { return []; },
      get threadId() { return "test-thread"; },
      get currentTurn() { return 0; },
      addMessage() {},
      lastMessage() { throw new Error("not implemented"); },
      lastUserMessage() { throw new Error("not implemented"); },
      lastAgentMessage() { throw new Error("not implemented"); },
      lastToolCall() { throw new Error("not implemented"); },
      hasToolCall() { return false; },
      rollbackMessagesTo() { return []; },
    } as unknown as AgentInput["scenarioState"],
  };
}

// ---------------------------------------------------------------------------
// Stub LLM + TTS
// ---------------------------------------------------------------------------

/**
 * Wire a stub LLM into the simulator that always returns the given text.
 */
function stubLlm(sim: ReturnType<typeof userSimulatorAgent>, text: string) {
  (sim as unknown as {
    invokeLLM: (p: unknown) => Promise<{ text: string; toolCalls?: []; steps?: [] }>;
  }).invokeLLM = async () => ({ text, toolCalls: [], steps: [] });
}

/**
 * Wire a stub synthesize function into the simulator.
 * Returns an AudioChunk with the given text as the transcript and 4 zero bytes.
 */
function stubSynth(
  sim: ReturnType<typeof userSimulatorAgent>,
  fn?: (text: string, voice: string) => Promise<AudioChunk>
) {
  const defaultFn = async (text: string): Promise<AudioChunk> =>
    makeChunk(text);
  (sim as unknown as { _synthesize: typeof fn })._synthesize =
    fn ?? defaultFn;
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: UserSimulatorAgent without voice is unchanged (line 158)
    // -----------------------------------------------------------------------
    Scenario(
      "UserSimulatorAgent without voice is unchanged",
      ({ Given, When, Then }) => {
        let sim: ReturnType<typeof userSimulatorAgent>;
        let result: unknown;

        Given(
          'UserSimulatorAgent(model="openai/gpt-4.1-mini") with no voice parameter',
          () => {
            sim = userSimulatorAgent({ model: "openai/gpt-4.1-mini" } as UserSimulatorAgentConfig);
            stubLlm(sim, "hello I need help");
          }
        );

        When("the simulator produces a message", async () => {
          result = await sim.call(makeInput());
        });

        Then(
          "the output is a text-only message (existing behavior preserved)",
          () => {
            expect(result).not.toBeNull();
            const msg = result as { role: string; content: unknown };
            expect(msg.role).toBe("user");
            expect(typeof msg.content).toBe("string");
            expect(messageHasAudio(msg)).toBe(false);
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: UserSimulatorAgent with voice produces audio messages (line 165)
    // -----------------------------------------------------------------------
    Scenario(
      "UserSimulatorAgent with voice produces audio messages",
      ({ Given, When, Then }) => {
        let sim: ReturnType<typeof userSimulatorAgent>;
        let result: unknown;

        Given('UserSimulatorAgent(voice="openai/nova")', () => {
          sim = userSimulatorAgent({ voice: "openai/nova" } as UserSimulatorAgentConfig);
          stubLlm(sim, "I need help with my account");
          stubSynth(sim);
        });

        When("the simulator produces a user turn", async () => {
          result = await sim.call(makeInput());
        });

        Then(
          "the LLM generates text, TTS synthesizes audio, and an audio message is returned",
          () => {
            expect(result).not.toBeNull();
            const msg = result as { role: string; content: unknown };
            expect(msg.role).toBe("user");
            // Message must contain audio content.
            expect(messageHasAudio(msg)).toBe(true);

            // Transcript must match the LLM-generated text.
            const chunk = extractAudio(msg);
            expect(chunk).not.toBeNull();
            expect(chunk!.transcript).toBe("I need help with my account");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Per-step audio_effects override applies to only that step (line 196)
    // -----------------------------------------------------------------------
    Scenario(
      "Per-step audio_effects override applies to only that step",
      ({ Given, When, Then }) => {
        let sim: ReturnType<typeof userSimulatorAgent>;
        let resultWithOverride: unknown;
        let resultWithoutOverride: unknown;

        Given(
          "scenario.user(\"Hello?\", audio_effects=[effects.low_volume(0.3)])",
          () => {
            // low_volume(0.3): attenuate audio — every byte becomes 0 (zero-fill mock)
            const lowVolume = (_bytes: Uint8Array): Uint8Array =>
              new Uint8Array(4); // silenced — all zeros

            sim = userSimulatorAgent({ voice: "openai/nova" } as UserSimulatorAgentConfig);
            stubLlm(sim, "Hello?");
            // Stub synth returns recognizable non-zero bytes so we can detect if
            // low_volume ran: if bytes are all zero, the effect applied.
            const synthFn = async (text: string): Promise<AudioChunk> =>
              new AudioChunk({ data: new Uint8Array([1, 2, 3, 4]), transcript: text });
            stubSynth(sim, synthFn);

            // Assign the per-step effect override.
            const restore = sim.setOneShotOverride({ audioEffects: [lowVolume] });

            // Call with override active.
            resultWithOverride = null; // will be set in When
            restore(); // clean up before When runs
          }
        );

        When("the step runs", async () => {
          // Re-install override for the actual call.
          const lowVolume = (_bytes: Uint8Array): Uint8Array =>
            new Uint8Array(4); // all zeros

          const restore = sim.setOneShotOverride({ audioEffects: [lowVolume] });
          resultWithOverride = await sim.call(makeInput());
          restore();

          // Then a second call with no override.
          resultWithoutOverride = await sim.call(makeInput());
        });

        Then("low_volume is applied to only that turn's audio", () => {
          expect(resultWithOverride).not.toBeNull();

          // With the low_volume override: extracted audio data must be all zeros.
          const chunkWith = extractAudio(resultWithOverride);
          expect(chunkWith).not.toBeNull();
          expect(Array.from(chunkWith!.data)).toEqual([0, 0, 0, 0]);

          // Without override: audio must be original non-zero stub bytes.
          const chunkWithout = extractAudio(resultWithoutOverride);
          expect(chunkWithout).not.toBeNull();
          expect(Array.from(chunkWithout!.data)).toEqual([1, 2, 3, 4]);
        });
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Persona and audio_effects compose on user simulator (line 203)
    // -----------------------------------------------------------------------
    Scenario(
      "Persona and audio_effects compose on user simulator",
      ({ Given, When, Then, And }) => {
        let sim: ReturnType<typeof userSimulatorAgent>;
        let systemPromptCapture: string;
        let results: unknown[];
        let effectCallCount: number;

        Given(
          "UserSimulatorAgent with voice, persona, and audio_effects [background_noise(\"cafe\", 0.2), phone_quality()]",
          () => {
            effectCallCount = 0;

            // Two stub effects: each increments counter and passes bytes through.
            const cafeNoise = (bytes: Uint8Array): Uint8Array => {
              effectCallCount++;
              return bytes;
            };
            const phoneQuality = (bytes: Uint8Array): Uint8Array => {
              effectCallCount++;
              return bytes;
            };

            const config: UserSimulatorAgentConfig = {
              voice: "openai/nova",
              persona: "An elderly confused customer who speaks slowly",
              audioEffects: [cafeNoise, phoneQuality],
            };
            sim = userSimulatorAgent(config);

            // Capture system prompt via LLM spy — check persona block present.
            systemPromptCapture = "";
            (sim as unknown as {
              invokeLLM: (p: { messages: Array<{ role: string; content: string }> }) => Promise<{ text: string; toolCalls: []; steps: [] }>;
            }).invokeLLM = async ({ messages }) => {
              // System message is passed unchanged through role reversal.
              const sysMsg = messages.find((m) => m.role === "system");
              systemPromptCapture = sysMsg?.content ?? "";
              return { text: "I need help please", toolCalls: [], steps: [] };
            };

            stubSynth(sim);
            results = [];
          }
        );

        When("multiple turns are produced", async () => {
          results.push(await sim.call(makeInput()));
          results.push(await sim.call(makeInput()));
        });

        Then(
          "every turn's audio has cafe noise and phone-quality filter applied",
          () => {
            // Both effects run for each of 2 turns = 4 total effect invocations.
            expect(effectCallCount).toBe(4);

            for (const result of results) {
              expect(messageHasAudio(result)).toBe(true);
            }
          }
        );

        And("the persona shapes the text content", () => {
          // The persona text must appear somewhere in the LLM messages passed.
          // We check that the system prompt received by the LLM (after role reversal)
          // contains the persona text.
          expect(systemPromptCapture).toContain(
            "An elderly confused customer who speaks slowly"
          );
        });
      }
    );
  },
  { includeTags: ["ts-simulator"] }
);
