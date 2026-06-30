/**
 * Narrow structural interfaces for duck-typed user-simulator capabilities.
 *
 * The executor detects whether a user-simulator agent has voice capabilities
 * by inspecting its shape at runtime (duck-typing) rather than requiring the
 * concrete class to declare `implements`. This avoids a circular import
 * between the execution layer and the concrete adapter implementations.
 *
 * These interfaces + type guards replace the raw `as unknown as { ... }`
 * casts in {@link ScenarioExecution} with named, documentable contracts.
 *
 * File placement: lives in `domain/agents/` because these are structural
 * contracts about what shapes agents expose — independent of the voice
 * transport layer. The voice-config parameter uses a generic structural
 * shape (`{ tts?: { voice?: string } }`) so this file stays import-free
 * of `voice/config` and can remain in the domain layer.
 */

import type { ModelMessage } from "ai";

/**
 * Error message for the executor's adapter-AGNOSTIC fail-closed invariant: a
 * USER turn produced for a voice agent under test MUST carry audio (issue #705).
 *
 * Why this exists (and replaced the old realtime-user type-check): a voice agent
 * only "hears" a turn that carries audio — its `call()` extracts audio from the
 * incoming message (`extractIncomingAudio`). A text-only user turn never commits
 * on the agent's transport, so the next agent turn has nothing to answer and its
 * `receiveAudio` times out (the #705 symptom). Rather than silently degrade the
 * user side to text, {@link ScenarioExecution.voiceifyGeneratedUserTurn} asserts
 * audio-presence on the FINAL (post-voiceify) user turn and throws this when it
 * is missing.
 *
 * This is strictly stronger than the prior `isRealtimeUserAgent` type-check it
 * replaced: it catches ANY producer that yields a no-audio user turn against a
 * voice agent — a realtime adapter that returns text, OR a non-realtime/
 * non-voice-sim producer the old check let through silently — not just one class.
 * The autonomous OpenAI Realtime user (`role=USER`) now PASSES it: its `call()`
 * speaks a generative turn and returns audio. Defined once here so every site
 * that references the invariant can never drift.
 */
export const USER_TURN_NO_AUDIO_FOR_VOICE_AUT =
  "A user turn produced for a VOICE agent under test carried no audio. A voice " +
  'agent only "hears" a turn that carries audio (its call() extracts audio from ' +
  "the incoming message); a text-only user turn never commits, so the next agent " +
  "turn has nothing to answer and times out. Ensure the user side voices its " +
  "turn — a voice user simulator (userSimulatorAgent with a voice) TTS's its " +
  "generated text to audio, and a realtime user (OpenAI Realtime, role=USER) " +
  "speaks it natively. This fail-closed check prevents silently degrading the " +
  "user side to text.";

/**
 * A user-sim agent that speaks scripted text into a realtime transport — the
 * realtime model synthesizes the voice itself, with NO TTS conversion step.
 * Implemented by the OpenAI Realtime adapter when `role=USER`.
 */
export interface RealtimeUserAgent {
  /**
   * Inject a text turn into the realtime session and kick off the response
   * (`conversation.item.create` + `response.create`). Fire-and-forget — the
   * spoken audio arrives on the adapter's own `receiveAudio` stream.
   */
  sendText(text: string): Promise<void>;

  /**
   * Speak a scripted line AND drain the resulting spoken audio, returning it as
   * one audio chunk (PCM16 bytes + the model's spoken transcript). This is the
   * bridge the executor uses to feed a realtime USER's voice into a SEPARATE
   * agent-under-test (e.g. hosted ElevenLabs) through `scenario.run()` (#705):
   * the chunk's audio is recorded as the real user turn, and its transcript
   * drives the agent-under-test's turn-commit.
   *
   * The returned chunk carries `transcript` = the model's own spoken transcript
   * (fallback: the scripted text). The adapter owns all protocol framing and
   * end-of-turn detection.
   */
  speakUserTurn(text: string): Promise<{
    readonly data: Uint8Array;
    readonly transcript?: string;
  }>;
}

/**
 * A voice-capable user simulator that converts text to a voiced
 * {@link ModelMessage} (TTS + audio bytes). Used by the interruption path
 * to generate the user barge-in phrase as real audio before feeding it to
 * the agent adapter.
 */
export interface VoiceUserSimulator {
  /**
   * The voice identifier to use for TTS synthesis. Non-empty string signals
   * that this simulator has a voice channel configured.
   */
  readonly voice: string;

  /**
   * Convert `text` to a voiced {@link ModelMessage} using the given voice
   * config (falls back to the simulator's own defaults when `cfg` is
   * omitted).
   *
   * The `cfg` parameter accepts a generic structural shape
   * (`{ tts?: { voice?: string } }`) rather than importing `VoiceConfig`
   * from the voice layer — keeping this file in the domain layer without
   * introducing an upward dependency.
   */
  voiceifyText(text: string, cfg?: { tts?: { voice?: string } }): Promise<ModelMessage>;
}

/**
 * A `UserSimulatorAgent` narrowed to one that has a concrete voice set.
 *
 * The public `UserSimulatorAgent.voice` getter is typed `string | undefined`
 * (optional voice). This intersection narrows it to `string` (non-optional),
 * so the executor can use the return value of `findVoiceUserSim` without
 * additional null-guards on the `voice` field.
 *
 * Usage: callers that need the narrowed type should use
 * {@link isVoiceUserSim} as a type guard — it already enforces `voice.length > 0`.
 */
export type UserSimulatorAgentWithVoice = {
  readonly voice: string;
  voiceifyText(text: string, cfg?: { tts?: { voice?: string } }): Promise<ModelMessage>;
};

/**
 * Returns `true` when `agent` structurally satisfies {@link RealtimeUserAgent}.
 *
 * Requires BOTH `sendText` and `speakUserTurn` — the executor's #705 bridge
 * routes scripted user turns through `speakUserTurn` (speak + drain spoken
 * audio), so a shape without it is not a realtime user for routing purposes.
 */
export function isRealtimeUserAgent(agent: unknown): agent is RealtimeUserAgent {
  const candidate = agent as {
    sendText?: unknown;
    speakUserTurn?: unknown;
  };
  return (
    typeof candidate.sendText === "function" &&
    typeof candidate.speakUserTurn === "function"
  );
}

/**
 * Returns `true` when `agent` structurally satisfies {@link VoiceUserSimulator}.
 *
 * Checks that `voice` is a non-empty string and `voiceifyText` is a function
 * — mirrors the Python `getattr(sim, "voice", None)` + `callable` guard in
 * `_find_user_sim`.
 */
export function isVoiceUserSim(agent: unknown): agent is VoiceUserSimulator {
  const candidate = agent as {
    voice?: unknown;
    voiceifyText?: unknown;
  };
  return (
    typeof candidate.voiceifyText === "function" &&
    typeof candidate.voice === "string" &&
    candidate.voice.length > 0
  );
}
