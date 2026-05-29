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
 * A user-sim agent that can directly send text to the realtime transport
 * without a TTS conversion step. Implemented by OpenAI Realtime user sims
 * that operate in text mode over the websocket.
 */
export interface RealtimeUserAgent {
  /**
   * Send a text turn directly to the realtime transport.
   * The adapter is responsible for any protocol framing.
   */
  sendText(text: string): Promise<void>;
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
 * Checks that `sendText` is a function — sufficient for the executor to
 * safely call `agent.sendText(content)` without a full-class cast.
 */
export function isRealtimeUserAgent(agent: unknown): agent is RealtimeUserAgent {
  return (
    typeof (agent as { sendText?: unknown }).sendText === "function"
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
