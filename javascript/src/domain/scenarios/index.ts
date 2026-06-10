import { ModelMessage } from "ai";
import type { AudioChunk } from "../../voice/audio-chunk";
import type { VoiceConfig } from "../../voice/config";
import type { VoiceEvent } from "../../voice/recording.types";
import { AgentAdapter } from "../agents/index";
import { ScenarioExecutionStateLike, ScenarioResult } from "../core/execution";

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_VERBOSE = false;

/**
 * Configuration for a scenario.
 */
export interface ScenarioConfig {
  /**
   * Optional unique identifier for the scenario.
   * If not provided, a UUID will be generated.
   */
  id?: string;
  /**
   * The name of the scenario.
   */
  name: string;
  /**
   * A description of what the scenario tests.
   */
  description: string;

  /**
   * The agents participating in the scenario.
   */
  agents: AgentAdapter[];
  /**
   * The script of steps to execute for the scenario.
   */
  script?: ScriptStep[];

  /**
   * Whether to output verbose logging.
   *
   * If no value is provided, this defaults to {@link DEFAULT_VERBOSE}.
   *
   * @default {@link DEFAULT_VERBOSE}
   */
  verbose?: boolean;
  /**
   * The maximum number of turns to execute.
   *
   * If no value is provided, this defaults to {@link DEFAULT_MAX_TURNS}.
   *
   * @default {@link DEFAULT_MAX_TURNS}
   */
  maxTurns?: number;

  /**
   * Optional thread ID to use for the conversation.
   * If not provided, a new thread will be created.
   */
  threadId?: string;

  /**
   * Optional identifier to group this scenario into a set ("Simulation Set").
   * This is useful for organizing related scenarios in the UI and for reporting.
   * If not provided, the scenario will not be grouped into a set.
   */
  setId?: string;

  /**
   * Optional metadata to attach to the scenario run.
   * Accepts arbitrary key-value pairs (e.g. prompt IDs, environments, versions).
   * The `langwatch` key is reserved for platform-internal use.
   */
  metadata?: Record<string, unknown>;

  /**
   * Optional callback invoked for every audio chunk that flows through
   * a voice adapter (both user-side and agent-side).
   *
   * Mirrors Python `scenario.run(on_audio_chunk=...)`. Best-effort — if
   * the hook throws, the scenario continues uninterrupted.
   */
  onAudioChunk?: (chunk: AudioChunk) => void;

  /**
   * Optional callback invoked for every {@link VoiceEvent} appended to
   * the timeline (`user_start_speaking`, `agent_stop_speaking`, etc.).
   *
   * Mirrors Python `scenario.run(on_voice_event=...)`. Best-effort — if
   * the hook throws, the scenario continues uninterrupted.
   */
  onVoiceEvent?: (event: VoiceEvent) => void;

  /**
   * Per-run voice configuration (ADR-002). This is the carrier that reaches
   * every `call()` via {@link AgentInput.scenarioConfig} — the STT/TTS
   * providers the judge's transcription pass and the user-simulator's TTS
   * pass read live here, NOT in a module global. An optional
   * {@link RunOptions.voice} override seeds this at the `run()` boundary
   * (`options?.voice ?? cfg.voice ?? default`); the resolved provider is
   * always read off `cfg.voice`. See `voice/config.ts#resolveVoiceConfig`.
   */
  voice?: VoiceConfig;
}

/**
 * Final, normalized scenario configuration.
 * All optional fields are filled with default values.
 * @internal
 */
export interface ScenarioConfigFinal
  extends Omit<
    ScenarioConfig,
    "id" | "script" | "threadId" | "verbose" | "maxTurns"
  > {
  id: string;
  script: ScriptStep[];

  verbose: boolean;
  maxTurns: number;
  threadId: string;
}

/**
 * The execution context for a scenario script.
 * This provides the functions to control the flow of the scenario.
 */
export interface ScenarioExecutionLike {
  /**
   * The history of messages in the conversation.
   */
  readonly messages: ModelMessage[];

  /**
   * The ID of the conversation thread.
   */
  readonly threadId: string;

  /**
   * Adds a message to the conversation.
   * @param message The message to add.
   */
  message(message: ModelMessage): Promise<void>;
  /**
   * Adds a user message to the conversation.
   * If no content is provided, the user simulator will generate a message.
   * @param content The content of the user message.
   */
  user(content?: string | ModelMessage): Promise<void>;
  /**
   * Adds an agent message to the conversation.
   * If no content is provided, the agent under test will generate a message.
   * @param content The content of the agent message.
   */
  agent(content?: string | ModelMessage): Promise<void>;
  /**
   * Voice-only: fire an agent turn WITHOUT awaiting it — the non-blocking
   * primitive behind `agent({ wait: false })` (PRD §4.4). The executor tracks
   * the in-flight turn so a subsequent {@link user} call lands as a mid-stream
   * barge-in (interruption) rather than a separate turn. Optional: text-only
   * executors may omit it, in which case the `{ wait: false }` step falls back
   * to a fire-and-forget `agent()` with no barge-in coordination.
   */
  agentNonBlocking?(content?: string | ModelMessage): void;
  /**
   * Invokes the judge agent to evaluate the current state.
   * @param options Optional options with inline criteria to evaluate as a checkpoint.
   * @returns The result of the scenario if the judge makes a final decision.
   */
  judge(options?: { criteria?: string[] }): Promise<ScenarioResult | null>;
  /**
   * Proceeds with the scenario automatically for a number of turns.
   * @param turns The number of turns to proceed. Defaults to running until the scenario ends.
   * @param onTurn Optional callback executed at the end of each turn.
   * @param onStep Optional callback executed after each agent interaction.
   * @returns The result of the scenario if it ends.
   */
  proceed(
    turns?: number,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<ScenarioResult | null>;
  /**
   * Ends the scenario with a success.
   * @param reasoning Optional reasoning for the success.
   * @returns The final result of the scenario.
   */
  succeed(reasoning?: string): Promise<ScenarioResult>;
  /**
   * Ends the scenario with a failure.
   * @param reasoning Optional reasoning for the failure.
   * @returns The final result of the scenario.
   */
  fail(reasoning?: string): Promise<ScenarioResult>;
}

/**
 * A step in a scenario script.
 * This is a function that takes the current state and an executor, and performs an action.
 */
export type ScriptStep = (
  state: ScenarioExecutionStateLike,
  executor: ScenarioExecutionLike
) => Promise<void> | void;
