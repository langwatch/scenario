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
 * Error message shared by the two fail-loud guards for the unsupported
 * "drive a realtime user autonomously" mode (issue #705, follow-up #711).
 *
 * A realtime user agent (OpenAI Realtime, `role=USER`) speaks SCRIPTED lines
 * verbatim via `speakUserTurn`. Driving it with `proceed()`/autonomous
 * generation is not supported yet: the realtime session runs with
 * `turn_detection:null` and the default voice `call()` issues no out-of-band
 * `response.create`, so it produces no spoken user turn (and even if it did,
 * the model would ANSWER the agent rather than drive as the user). Rather than
 * silently degrade the user side to text/TTS, both the adapter's `call()`
 * (primary, fires before the call wastes a turn) and the executor's
 * `voiceifyGeneratedUserTurn` (fail-closed backstop) throw this message.
 * Defined once here so the two sites can never drift.
 */
export const REALTIME_USER_AUTONOMOUS_UNSUPPORTED =
  "Realtime user agents (e.g. OpenAI Realtime, role=USER) only support " +
  'scripted `user("...")` turns, which the model speaks verbatim. Driving a ' +
  "realtime user with proceed()/autonomous generation is not supported yet — " +
  "use scripted user() turns, or a voice user simulator (userSimulatorAgent " +
  "with a voice) for autonomously generated voiced turns.";

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
