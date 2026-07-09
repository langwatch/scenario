import { context, type Span } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { ModelMessage } from "ai";
import { getLangWatchTracer } from "langwatch";
import { attributes } from "langwatch/observability";
import { filter, Observable, Subject } from "rxjs";
import {
  ScenarioExecutionState,
  StateChangeEventType,
} from "./scenario-execution-state";
import { getGlobalSettings } from "../config/configure";
import {
  type ScenarioResult,
  type ScenarioConfig,
  AgentRole,
  type AgentInput,
  type JudgmentRequest,
  type ScriptStep,
  type AgentReturnTypes,
  type ScenarioExecutionLike,
  type AgentAdapter,
  JudgeAgentAdapter,
  ScenarioExecutionStateLike,
  ScenarioConfigFinal,
  DEFAULT_MAX_TURNS,
  DEFAULT_VERBOSE,
} from "../domain";
import {
  isRealtimeUserAgent,
  isVoiceUserSim,
  USER_TURN_NO_AUDIO_FOR_VOICE_AUT,
  type RealtimeUserAgent,
  type VoiceUserSimulator,
} from "../domain/agents/agent-shapes";
import {
  ScenarioEvent,
  ScenarioEventType,
  ScenarioMessageSnapshotEvent,
  ScenarioRunFinishedEvent,
  ScenarioRunStartedEvent,
  ScenarioRunStatus,
  Verdict,
} from "../events/schema";
import {
  ATTR_SCENARIO_SDK_NAME,
  ATTR_SCENARIO_SDK_VERSION,
  SCENARIO_SDK_NAME,
  SCENARIO_SDK_VERSION,
} from "../tracing/sdk-metadata";
import convertModelMessagesToAguiMessages from "../utils/convert-core-messages-to-agui-messages";
import {
  generateScenarioId,
  generateScenarioRunId,
  generateThreadId,
} from "../utils/ids";
import { Logger } from "../utils/logger";
import type { VoiceAgentAdapter } from "../voice/adapter";
import {
  appendEvent,
  initVoiceExecutorState,
  pickVoiceAdapters,
  startVoiceAdapters,
  stopVoiceAdapters,
  writeUserSegment,
} from "../voice/adapter.runtime";
import { AudioChunk } from "../voice/audio-chunk";
import {
  resolveVoiceConfig,
  type ResolvedVoiceConfig,
} from "../voice/config";
import { InterruptionConfig } from "../voice/interruption";
import {
  createAudioMessage,
  extractAudio,
  extractTranscript,
  messageHasAudio,
} from "../voice/messages";
import { AudioPlaybackSink } from "../voice/playback";
import { computeLatencyMetrics } from "../voice/recording.runtime";
import type {
  LatencyMetrics,
  VoiceEvent,
  VoiceRecording,
} from "../voice/recording.types";
import {
  deriveInterruptResponseTime,
  markTruncatedAgentSegments,
} from "../voice/segment-utils";
import { sleep } from "../voice/utils";
import type { VoiceExecutorState } from "../voice/voice-executor-state";

/**
 * Default bound (ms) on the barge-in wait for the agent to start speaking.
 * Used by {@link ScenarioExecution.fireUserInterrupt} when the `interrupt()`
 * step has not threaded its own `waitForSpeechTimeout`. A hung bot can't stall
 * the script past this.
 */
const DEFAULT_WAIT_FOR_SPEECH_MS = 15_000;

/**
 * Manages the execution of a single scenario test.
 *
 * This class orchestrates the interaction between agents (user simulator, agent under test,
 * and judge), executes the test script step-by-step, and manages the scenario's state
 * throughout execution. It also emits events that can be subscribed to for real-time
 * monitoring of the scenario's progress.
 *
 * ## Execution Flow Overview
 *
 * The execution follows a turn-based system where agents take turns responding. The key
 * concepts are:
 * - **Script Steps**: Functions in the scenario script like `user()`, `agent()`, `proceed()`, etc.
 * - **Agent Interactions**: Individual agent responses that occur when an agent takes their turn
 * - **Turns**: Groups of agent interactions that happen in sequence
 *
 * ## Message Broadcasting System
 *
 * The class implements a sophisticated message broadcasting system that ensures all agents
 * can "hear" each other's messages:
 *
 * 1. **Message Creation**: When an agent sends a message, it's added to the conversation history
 * 2. **Broadcasting**: The message is immediately broadcast to all other agents via `broadcastMessage()`
 * 3. **Queue Management**: Each agent has a pending message queue (`pendingMessages`) that stores
 *    messages from other agents
 * 4. **Agent Input**: When an agent is called, it receives both the full conversation history
 *    and any new pending messages that have been broadcast to it
 * 5. **Queue Clearing**: After an agent processes its pending messages, its queue is cleared
 *
 * This creates a realistic conversation environment where agents can respond contextually
 * to the full conversation history and any new messages from other agents.
 *
 * ## Example Message Flow
 *
 * ```
 * Turn 1:
 * 1. User Agent sends: "Hello"
 *    - Added to conversation history
 *    - Broadcast to Agent and Judge (pendingMessages[1] = ["Hello"], pendingMessages[2] = ["Hello"])
 *
 * 2. Agent is called:
 *    - Receives: full conversation + pendingMessages[1] = ["Hello"]
 *    - Sends: "Hi there! How can I help you?"
 *    - Added to conversation history
 *    - Broadcast to User and Judge (pendingMessages[0] = ["Hi there!..."], pendingMessages[2] = ["Hello", "Hi there!..."])
 *    - pendingMessages[1] is cleared
 *
 * 3. Judge is called:
 *    - Receives: full conversation + pendingMessages[2] = ["Hello", "Hi there!..."]
 *    - Evaluates and decides to continue
 *    - pendingMessages[2] is cleared
 * ```
 *
 * Each script step can trigger one or more agent interactions depending on the step type.
 * For example, a `proceed(5)` step might trigger 10 agent interactions across 5 turns.
 *
 * Note: This is an internal class. Most users will interact with the higher-level
 * `scenario.run()` function instead of instantiating this class directly.
 *
 * @example
 * ```typescript
 * import scenario from "@langwatch/scenario";
 *
 * // This is a simplified example of what `scenario.run` does internally.
 * const result = await scenario.run({
 *   name: "My First Scenario",
 *   description: "A simple test of the agent's greeting.",
 *   agents: [
 *     scenario.userSimulatorAgent(),
 *     scenario.judgeAgent({
 *       criteria: ["Agent should respond with a greeting"],
 *     }),
 *   ],
 *   script: [
 *     scenario.user("Hello"),     // Script step 1: triggers 1 agent interaction
 *     scenario.agent(),           // Script step 2: triggers 1 agent interaction
 *     scenario.proceed(3),        // Script step 3: triggers multiple agent interactions
 *     scenario.judge(),           // Script step 4: triggers 1 agent interaction
 *   ]
 * });
 *
 * console.log("Scenario result:", result.success);
 * ```
 */
export class ScenarioExecution implements ScenarioExecutionLike, VoiceExecutorState {
  /** LangWatch tracer for scenario execution */
  private tracer = getLangWatchTracer("@langwatch/scenario");

  /** The current state of the scenario execution */
  private state: ScenarioExecutionState;

  // ----- VoiceExecutorState surface (issue #372 Decision 1(b)). ----------
  // These are public fields rather than getters because the voice adapter
  // runtime writes to them through the typed surface — see
  // `voice/voice-executor-state.ts` for the contract. They default to
  // `null` and only get populated when at least one VoiceAgentAdapter
  // participates in the scenario.

  /** PCM16 segments + timeline accumulated during the run. */
  voiceRecording: VoiceRecording | null = null;
  /** Mirror of `voiceRecording.timeline` for direct subscribers. */
  voiceTimeline: VoiceEvent[] | null = null;
  /** Response-time measurements from agent_start_speaking events. */
  voiceLatency: LatencyMetrics | null = null;
  /** Monotonic clock anchor (`performance.now() / 1000`) for offsets. */
  voiceRecordingStartedAt: number | null = null;
  /**
   * Byte-accurate audio cursor (seconds) — cumulative PCM byte-duration of all
   * segments laid so far. Drives segment start/end so `voiceRecording.duration`
   * tracks the `full.wav` byte-duration, not wall-clock send latency (M1).
   */
  voiceAudioCursor: number | null = null;
  /**
   * Resolved per-run voice config (ADR-002 / Gap #7). Set at run start from
   * `cfg.voice` when voice adapters are present; the consumer agents read
   * the provider/knobs here instead of a module global.
   */
  voiceConfig: ResolvedVoiceConfig | null = null;
  /**
   * Interruption config recorded by `voiceProceed({ interruptions })`. Read
   * at the top of each `proceed()` iteration to decide barge-ins (Gap #8).
   */
  voiceInterruptions?: InterruptionConfig;
  /**
   * Background ambience recorded by `backgroundNoise(source, volume)` — read
   * by the user-simulator audio path when mixing turns (Gap #8).
   */
  voiceBackgroundNoise?: { source: string; volume: number };
  /** Per-event hook from {@link ScenarioConfig.onVoiceEvent}. */
  onVoiceEvent?: (event: VoiceEvent) => void;
  /** Per-chunk hook from {@link ScenarioConfig.onAudioChunk}. */
  onAudioChunk?: (chunk: AudioChunk) => void;
  /**
   * Live local-speaker playback sink. Constructed at run start when
   * `audioPlayback === true` (per-run wins over global per ADR-002). Each
   * audio chunk is fanned out here via `fireAudioChunk` alongside the recording.
   * `undefined` when audioPlayback is disabled (the common case).
   */
  audioPlaybackSink?: AudioPlaybackSink | null;

  /**
   * In-flight non-blocking agent turn started by `agent({ wait: false })` (or
   * the `interrupt()` sugar). When set and not yet settled, a subsequent
   * {@link user} call fires {@link fireUserInterrupt} — the new user audio
   * lands as a mid-stream barge-in. Mirrors Python's `_pending_agent_task`.
   * JS promises aren't cancelable; `done` records settlement so `user()` can
   * tell "agent still speaking" from "already finished".
   *
   * `error` captures any rejection from the background turn so it can be
   * re-thrown after the promise settles (rather than silently swallowed).
   */
  private pendingAgentTask: {
    promise: Promise<void>;
    done: boolean;
    /** Captured rejection, if any. Re-thrown by {@link fireUserInterrupt}. */
    error: unknown | null;
  } | null = null;

  /**
   * Snapshot of voice adapters for the in-flight execution. Captured at
   * the top of {@link execute} so the matching `disconnect()` always
   * fires in the finally block, even when the for-loop bails early.
   */
  private voiceAdapters: readonly VoiceAgentAdapter[] = [];

  /** The final result of the scenario execution, set when a conclusion is reached */
  private _result?: ScenarioResult;

  /** Logger for debugging and monitoring */
  private logger = new Logger("scenario.execution.ScenarioExecution");

  /** Finalized configuration with all defaults applied */
  private config: ScenarioConfigFinal;

  /** Array of all agents participating in the scenario */
  private agents: AgentAdapter[] = [];

  /** Roles that still need to act in the current turn (USER, AGENT, JUDGE) */
  private pendingRolesOnTurn: AgentRole[] = [];

  /** Agents that still need to act in the current turn */
  private pendingAgentsOnTurn: Set<AgentAdapter> = new Set();

  /**
   * Message queues for each agent. When an agent sends a message, it gets
   * broadcast to all other agents' pending message queues. When an agent
   * is called, it receives these pending messages as part of its input.
   *
   * Key: agent index, Value: array of pending messages for that agent
   */
  private pendingMessages: Map<number, ModelMessage[]> = new Map();

  /** Accumulated execution time for each agent (for performance tracking) */
  private agentTimes: Map<number, number> = new Map();

  /** Current turn span for trace context management */
  private currentTurnSpan?: Span;

  /** Timestamp when execution started (for total time calculation) */
  private totalStartTime: number = 0;

  /** Accumulated results from inline judge checkpoints */
  private checkpointResults: { metCriteria: string[]; unmetCriteria: string[] }[] = [];

  /** Event stream for monitoring scenario progress */
  private eventSubject = new Subject<ScenarioEvent>();

  /**
   * An observable stream of events that occur during the scenario execution.
   * Subscribe to this to monitor the progress of the scenario in real-time.
   *
   * Events include:
   * - RUN_STARTED: When scenario execution begins
   * - MESSAGE_SNAPSHOT: After each message is added to the conversation
   * - RUN_FINISHED: When scenario execution completes (success/failure/error)
   */
  public readonly events$: Observable<ScenarioEvent> =
    this.eventSubject.asObservable();

  /** Batch run ID for grouping scenario runs */
  private batchRunId: string;

  /** The run ID for the current execution */
  private scenarioRunId?: string;

  /** Pre-assigned run ID (provided externally, e.g. by the platform) */
  private preAssignedRunId?: string;

  /**
   * Creates a new ScenarioExecution instance.
   *
   * @param config - The scenario configuration containing agents, settings, and metadata
   * @param script - The ordered sequence of script steps that define the test flow
   * @param batchRunId - Batch run ID for grouping scenario runs
   * @param runId - Optional pre-assigned run ID. When provided, the execution uses this
   *   ID instead of generating a new one. This prevents duplicate entries when the
   *   platform pre-creates placeholder rows with a known ID.
   */
  constructor(config: ScenarioConfig, script: ScriptStep[], batchRunId: string, runId?: string) {
    if (!batchRunId) {
      throw new Error("batchRunId is required");
    }
    this.batchRunId = batchRunId;
    this.config = {
      id: config.id ?? generateScenarioId(),
      name: config.name,
      description: config.description,
      agents: config.agents,
      script: script,
      verbose: config.verbose ?? DEFAULT_VERBOSE,
      maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
      threadId: config.threadId ?? generateThreadId(),
      setId: config.setId || "default",
      metadata: config.metadata,
      // Voice carriers (ADR-002): the per-run voice config + audio hooks must
      // survive onto `this.config` so they reach every `call()` via
      // `AgentInput.scenarioConfig`. `run({ voice })` seeds `cfg.voice`; the
      // judge STT pre-pass + simulator TTS resolve their provider off
      // `scenarioConfig.voice`. Dropping these here silently defeated
      // `run({ voice: { stt } })` (the judge fell back to the default STT).
      voice: config.voice,
      onAudioChunk: config.onAudioChunk,
      onVoiceEvent: config.onVoiceEvent,
    } satisfies ScenarioConfigFinal;

    this.state = new ScenarioExecutionState(this.config);
    // The voice adapter runtime reaches into `state._executor` to read the
    // VoiceExecutorState surface (Python parity: `ScenarioState._executor`).
    // Set once here so adapters fetched via AgentInput.scenarioState can
    // find their voice fields.
    this.state.setExecutor(this);
    this.preAssignedRunId = runId;

    // Pull voice-side hooks off the user-supplied config. They fan out
    // through the VoiceExecutorState surface during the run.
    this.onAudioChunk = config.onAudioChunk;
    this.onVoiceEvent = config.onVoiceEvent;

    // Wire up rollback handler so the state can clean pending queues
    this.state.setOnRollback((removedSet: Set<object>) => {
      this.pendingMessages.forEach((queue, idx) => {
        this.pendingMessages.set(
          idx,
          queue.filter((m: ModelMessage) => !removedSet.has(m))
        );
      });
      this.logger.debug(`[${this.config.id}] rollbackMessagesTo removed ${removedSet.size} message(s)`);
    });

    this.reset();
  }

  /**
   * Gets the complete conversation history as an array of messages.
   *
   * @returns Array of ModelMessage objects representing the full conversation
   */
  get messages(): ModelMessage[] {
    return this.state.messages;
  }

  /**
   * Gets the unique identifier for the conversation thread.
   * This ID is used to maintain conversation context across multiple runs.
   *
   * @returns The thread identifier string
   */
  get threadId(): string {
    return this.state.threadId;
  }

  /**
   * Gets the result of the scenario execution if it has been set.
   *
   * @returns The scenario result or undefined if not yet set
   */
  get result(): ScenarioResult | undefined {
    return this._result;
  }

  /**
   * Sets the result of the scenario execution.
   * This is called when the scenario reaches a conclusion (success or failure).
   * Automatically includes messages, totalTime, and agentTime from the current execution context.
   *
   * @param result - The final scenario result (without messages/timing, which will be added automatically)
   */
  private setResult(
    result: Omit<ScenarioResult, "runId" | "messages" | "totalTime" | "agentTime">
  ): ScenarioResult {
    if (!this.scenarioRunId) {
      throw new Error("Cannot set result: scenarioRunId has not been initialized. This is a bug in ScenarioExecution.");
    }

    const agentRoleAgentsIdx = this.agents
      .map((agent, i) => ({ agent, idx: i }))
      .filter(({ agent }) => agent.role === AgentRole.AGENT)
      .map(({ idx }) => idx);

    const agentTimes = agentRoleAgentsIdx.map(
      (i) => this.agentTimes.get(i) || 0
    );

    const totalAgentTime = agentTimes.reduce((sum, time) => sum + time, 0);

    this._result = {
      runId: this.scenarioRunId,
      ...result,
      messages: this.state.messages,
      totalTime: this.totalTime,
      agentTime: totalAgentTime,
      ...this.buildVoiceResultFields(),
    };

    this.logger.debug(`[${this.config.id}] Result set`, {
      success: result.success,
      reasoning: result.reasoning,
      totalTime: this.totalTime,
      agentTime: totalAgentTime,
      messageCount: this.state.messages.length,
    });

    return this._result;
  }

  /**
   * Build the voice-only `audio` / `timeline` / `latency` result fields
   * (issue #372, EDR §4.3 — "Gap A"). Returns an empty object for text-only
   * runs so {@link setResult} stays a pure spread and the existing fields are
   * untouched (back-compat).
   *
   * The per-run recording is a {@link VoiceRecordingRuntime} (see
   * `adapter.runtime.ts#emptyRecording`, "Gap B") so the attached
   * `result.audio` carries `save()` / `saveSegments()`. Latency is finalized
   * here from the running measurements (avg / p50 / p95 computed once at
   * end-of-run rather than re-derived each turn), and `audio.timeline`
   * aliases `result.timeline` (the runtime appends to both during the run).
   */
  private buildVoiceResultFields(): Pick<
    ScenarioResult,
    "audio" | "timeline" | "latency"
  > {
    const recording = this.voiceRecording;
    if (!recording) {
      return {};
    }

    const timeline = this.voiceTimeline ?? recording.timeline;

    // Flag agent segments cut off by a barge-in so manifest readers + the judge
    // know the reply was truncated mid-utterance (see helper docstring).
    markTruncatedAgentSegments(recording.segments, timeline ?? []);

    const latency = this.voiceLatency
      ? computeLatencyMetrics({
          measurements: this.voiceLatency.measurements,
          timeToFirstByte: this.voiceLatency.timeToFirstByte,
          // Prefer an explicitly-recorded value; otherwise derive it from the
          // barge-in timeline (how fast the agent stopped after the interrupt).
          interruptResponseTime:
            this.voiceLatency.interruptResponseTime ??
            deriveInterruptResponseTime(timeline),
        })
      : undefined;

    return {
      audio: recording,
      timeline,
      latency,
    };
  }

  /**
   * The total elapsed time for the scenario execution.
   */
  private get totalTime(): number {
    return Date.now() - this.totalStartTime;
  }

  /**
   * Executes the entire scenario from start to finish.
   *
   * This method runs through all script steps sequentially until a final result
   * (success, failure, or error) is determined. Each script step can trigger one or
   * more agent interactions depending on the step type:
   * - `user()` and `agent()` steps typically trigger one agent interaction each
   * - `proceed()` steps can trigger multiple agent interactions across multiple turns
   * - `judge()` steps trigger the judge agent to evaluate the conversation
   * - `succeed()` and `fail()` steps immediately end the scenario
   *
   * The execution will stop early if:
   * - A script step returns a ScenarioResult
   * - The maximum number of turns is reached
   * - An error occurs during execution
   *
   * @returns A promise that resolves with the final result of the scenario
   * @throws Error if an unhandled exception occurs during execution
   *
   * @example
   * ```typescript
   * const execution = new ScenarioExecution(config, script);
   * const result = await execution.execute();
   * console.log(`Scenario ${result.success ? 'passed' : 'failed'}`);
   * ```
   */
  async execute(): Promise<ScenarioResult> {
    this.logger.debug(`[${this.config.id}] Starting scenario execution`, {
      name: this.config.name,
      maxTurns: this.config.maxTurns,
      scriptLength: this.config.script.length,
    });

    this.reset();

    const scenarioRunId = this.preAssignedRunId || generateScenarioRunId();
    this.scenarioRunId = scenarioRunId;

    // Create the initial turn span via newTurn() and then reset the counter
    // back to 0. This matches the original reset() behavior — newTurn() creates
    // the span and sets currentTurn=1, then we override to 0 so the first
    // newTurn() in the execution loop correctly advances to 1.
    this.newTurn();
    this.state.currentTurn = 0;
    this.logger.debug(`[${this.config.id}] ${this.preAssignedRunId ? "Using pre-assigned" : "Generated"} run ID: ${scenarioRunId}`);
    this.emitRunStarted({ scenarioRunId });

    // Create subscription with captured runId (closure)
    const subscription = this.state.events$
      .pipe(
        filter((event) => event.type === StateChangeEventType.MESSAGE_ADDED)
      )
      .subscribe(() => {
        this.emitMessageSnapshot({ scenarioRunId });
      });

    // Voice adapter lifecycle (issue #372 spec lines 138-145):
    // `connect()` is awaited exactly once before the first script step;
    // the matching `disconnect()` lives in the finally block so it fires
    // regardless of pass / fail / exception. Connect runs inside the try
    // so a partial connect still pairs with disconnect on the cleanup path
    // — matches Python `scenario_executor.py:642-678`.
    this.voiceAdapters = pickVoiceAdapters(this.agents);

    let checkFailure: Error | null = null;

    try {
      if (this.voiceAdapters.length > 0) {
        // Resolve the per-run voice config off cfg.voice (ADR-002, Gap #7).
        // RunOptions.voice was already folded into cfg.voice at the run()
        // boundary, so cfg.voice is the carrier. The resolved provider/knobs
        // are read by the judge STT pass + simulator TTS pass (Tier C).
        // resolveVoiceConfig merges per-run (cfg.voice) over scenario-level
        // (config.voice) over defaults. audioPlayback is already included.
        this.voiceConfig = resolveVoiceConfig(undefined, this.config.voice);
        initVoiceExecutorState(this);
        // Construct the local-speaker playback sink when audioPlayback is
        // enabled. The resolved voiceConfig already applies per-run vs global
        // precedence per ADR-002. The module-global configure() setting is an
        // additional fallback read here so callers can do configure({ audioPlayback: true })
        // without specifying it on every run() call.
        const audioPlayback =
          this.voiceConfig.audioPlayback || (getGlobalSettings().audioPlayback ?? false);
        if (audioPlayback) {
          const sink = new AudioPlaybackSink();
          sink.open();
          this.audioPlaybackSink = sink;
        }
        await startVoiceAdapters(this.voiceAdapters, this);
      }

      // Execute script steps - pass the execution context (this), not just state
      for (let i = 0; i < this.config.script.length; i++) {
        const scriptStep = this.config.script[i];

        try {
          await this.executeScriptStep(scriptStep, i);
        } catch (error) {
          if (error instanceof Error && error.name === "AssertionError") {
            checkFailure = error;
            break;
          }
          throw error;
        }

        if (this.result) {
          const cp = this.compiledCheckpoints;
          this.result.metCriteria = [...cp.metCriteria, ...this.result.metCriteria];

          this.emitRunFinished({
            scenarioRunId,
            status: this.result.success
              ? ScenarioRunStatus.SUCCESS
              : ScenarioRunStatus.FAILED,
            result: this.result,
          });

          return this.result;
        }

      }

      if (checkFailure) {
        const cp = this.compiledCheckpoints;
        const result = this.setResult({
          success: false,
          reasoning: `Scenario failed with error: ${checkFailure.message}`,
          metCriteria: cp.metCriteria,
          unmetCriteria: [...cp.unmetCriteria, checkFailure.message],
        });

        this.emitRunFinished({
          scenarioRunId,
          status: ScenarioRunStatus.ERROR,
          result,
        });

        throw checkFailure;
      }

      if (this.checkpointResults.length > 0) {
        const cp = this.compiledCheckpoints;
        const result = this.setResult({
          success: cp.unmetCriteria.length === 0,
          reasoning: "All inline criteria checkpoints passed",
          metCriteria: cp.metCriteria,
          unmetCriteria: cp.unmetCriteria,
        });

        this.emitRunFinished({
          scenarioRunId,
          status: result.success ? ScenarioRunStatus.SUCCESS : ScenarioRunStatus.FAILED,
          result,
        });

        return result;
      }

      const result = this.reachedMaxTurns(
        [
          "Reached end of script without conclusion, add one of the following:",
          "- Add `Scenario.judge()` to the script to force criteria judgement",
          "- Add `Scenario.succeed()` or `Scenario.fail()` to end the test with an explicit result",
          "- If your script already has a judge but is hitting maxTurns, increase `maxTurns` in your config",
        ].join("\n")
      );

      this.emitRunFinished({
        scenarioRunId,
        status: result.success ? ScenarioRunStatus.SUCCESS : ScenarioRunStatus.FAILED,
        result,
      });

      return result;
    } catch (error) {
      if (checkFailure) {
        // Already handled above — just propagate
        throw error;
      }

      const errorInfo = extractErrorInfo(error);

      const result = this.setResult({
        success: false,
        reasoning: `Scenario failed with error: ${errorInfo.message}`,
        metCriteria: [],
        unmetCriteria: [],
        error: JSON.stringify(errorInfo),
      });

      this.emitRunFinished({
        scenarioRunId,
        status: ScenarioRunStatus.ERROR,
        result,
      });

      // Re-throw the error in case it was a vitest assertion error
      throw error;
    } finally {
      // End the last turn span to prevent leaked/un-ended spans
      if (this.currentTurnSpan) {
        this.currentTurnSpan.end();
        this.currentTurnSpan = undefined;
      }
      // Back-fill transcripts on recording segments that the transport did not
      // supply one for (e.g. Pipecat over Twilio Media Streams carries audio
      // only, no transcript) so the committed manifest is READABLE — the same
      // STT the judge pre-pass uses, run over the recorded bytes. The shared
      // recording object is what `result.audio` points at, so the back-fill is
      // visible to a later `saveSegments()`. Runs before disconnect so the
      // resolved STT config is still live. (issue #372 — FIX #5.)
      if (this.voiceAdapters.length > 0) {
        await this.backfillSegmentTranscripts();
      }
      // Voice adapter lifecycle close — matches the connect at the top of
      // execute(). Errors swallowed inside stopVoiceAdapters so cleanup
      // never masks the primary scenario result.
      if (this.voiceAdapters.length > 0) {
        await stopVoiceAdapters(this.voiceAdapters);
      }
      // Close the playback sink after adapters are stopped (no more chunks).
      if (this.audioPlaybackSink) {
        await this.audioPlaybackSink.close().catch(() => {
          // Best-effort — playback drain errors must not mask the scenario result.
        });
        this.audioPlaybackSink = null;
      }
      // Clean up the subscription when execution is done
      subscription.unsubscribe();
    }
  }

  /**
   * Transcribe any recording segment that lacks a transcript, using the per-run
   * resolved STT provider — so the committed manifest reads as a conversation
   * even on transports that carry no transcript (Pipecat / Twilio Media
   * Streams). The judge already gets transcribed text via its own STT pre-pass
   * ({@link prepareJudgeInput}); this back-fills the SEGMENTS (the manifest).
   *
   * Best-effort and bounded: STT failures leave the segment transcript unset
   * (manifest stays `null` for that turn) rather than failing the run — mirrors
   * the judge pre-pass's degrade-gracefully contract. A segment whose transcript
   * was marked {@link AudioSegment.transcriptTruncated} is RE-transcribed from
   * the recorded bytes (what actually played), since the chunk-level transcript
   * reflected the agent's intended — not cut-off — reply.
   */
  private async backfillSegmentTranscripts(): Promise<void> {
    const recording = this.voiceRecording;
    const stt = this.voiceConfig?.stt;
    if (!recording || !stt) return;
    const targets = recording.segments.filter(
      (s) =>
        s.audio.length > 0 &&
        (s.transcriptTruncated || !s.transcript || s.transcript.trim() === ""),
    );
    if (targets.length === 0) return;
    await Promise.all(
      targets.map(async (seg) => {
        try {
          const chunk = new AudioChunk({ data: seg.audio });
          const text = (await stt.transcribe(chunk)).trim();
          if (text) seg.transcript = text;
        } catch (err) {
          this.logger.warn(
            `voice: STT back-fill failed for a ${seg.speaker} segment; ` +
              `manifest transcript left unset (${(err as Error).message})`,
          );
        }
      }),
    );
  }

  /**
   * Executes a single agent interaction in the scenario.
   *
   * This method is for manual step-by-step execution of the scenario, where each call
   * represents one agent taking their turn. This is different from script steps (like
   * `user()`, `agent()`, `proceed()`, etc.) which are functions in the scenario script.
   *
   * Each call to this method will:
   * - Progress to the next turn if needed
   * - Find the next agent that should act
   * - Execute that agent's response
   * - Set the result if the scenario concludes
   *
   * Note: This method is primarily for debugging or custom execution flows. Most users
   * will use `execute()` to run the entire scenario automatically.
   *
   * After calling this method, check `this.result` to see if the scenario has concluded.
   *
   * @example
   * ```typescript
   * const execution = new ScenarioExecution(config, script);
   *
   * // Execute one agent interaction at a time
   * await execution.step();
   * if (execution.result) {
   *   console.log('Scenario finished:', execution.result.success);
   * }
   * ```
   */
  async step(): Promise<void> {
    await this._step();
  }

  private async _step(
    goToNextTurn: boolean = true,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<void> {
    this.logger.debug(`[${this.config.id}] _step called`, {
      goToNextTurn,
      pendingRoles: this.pendingRolesOnTurn,
      currentTurn: this.state.currentTurn,
    });

    if (this.pendingRolesOnTurn.length === 0) {
      if (!goToNextTurn) {
        this.logger.debug(
          `[${this.config.id}] No pending roles, not advancing turn`
        );
        return;
      }

      this.newTurn();

      if (onTurn) await onTurn(this.state);

      if (this.state.currentTurn >= this.config.maxTurns) {
        this.logger.debug(
          `[${this.config.id}] Reached max turns: ${this.state.currentTurn}`
        );
        this.reachedMaxTurns();
        return;
      }
    }

    const currentRole = this.pendingRolesOnTurn[0];
    const { idx, agent: nextAgent } = this.nextAgentForRole(currentRole);
    if (!nextAgent) {
      this.logger.debug(
        `[${this.config.id}] No agent for role ${currentRole}, removing role`
      );
      this.removePendingRole(currentRole);
      return this._step(goToNextTurn, onTurn);
    }

    this.logger.debug(`[${this.config.id}] Calling agent`, {
      role: currentRole,
      agentIdx: idx,
      agentName: nextAgent.name ?? nextAgent.constructor.name,
    });

    this.removePendingAgent(nextAgent);

    await this.callAgent(idx, currentRole);
  }

  /**
   * Calls a specific agent to generate a response or make a decision.
   *
   * This method is the core of agent interaction. It prepares the agent's input
   * by combining the conversation history with any pending messages that have been
   * broadcast to this agent, then calls the agent and processes its response.
   *
   * The agent input includes:
   * - Full conversation history (this.state.messages)
   * - New messages that have been broadcast to this agent (this.pendingMessages.get(idx))
   * - The role the agent is being asked to play
   * - Whether this is a judgment request (for judge agents)
   * - Current scenario state and configuration
   *
   * After the agent responds:
   * - Performance timing is recorded
   * - Pending messages for this agent are cleared (they've been processed)
   * - If the agent returns a ScenarioResult, it's set on this.result
   * - Otherwise, the agent's messages are added to the conversation and broadcast
   *
   * @param idx - The index of the agent in the agents array
   * @param role - The role the agent is being asked to play (USER, AGENT, or JUDGE)
   * @param judgmentRequest - Whether this is a judgment request (for judge agents)
   * @throws Error if the agent call fails
   */
  private async callAgent(
    idx: number,
    role: AgentRole,
    judgmentRequest?: JudgmentRequest
  ): Promise<void> {
    const agent = this.agents[idx];
    const agentName = agent.name ?? agent.constructor.name;

    this.logger.debug(`[${this.config.id}] callAgent started`, {
      agentIdx: idx,
      role,
      judgmentRequest,
      agentName,
      pendingMessagesCount: this.pendingMessages.get(idx)?.length ?? 0,
    });

    const startTime = Date.now();
    const agentInput: AgentInput = {
      threadId: this.state.threadId,
      messages: this.state.messages,
      newMessages: this.pendingMessages.get(idx) ?? [],
      requestedRole: role,
      judgmentRequest: judgmentRequest,
      scenarioState: this.state,
      scenarioConfig: this.config,
    };

    // Create agent span as child of the turn span
    // Following OpenTelemetry docs: create context with parent span right before creating child
    const agentContext = this.currentTurnSpan
      ? trace.setSpan(context.active(), this.currentTurnSpan)
      : context.active();

    const agentSpanName = `${
      agentName !== Object.prototype.constructor.name
        ? agent.constructor.name
        : "Agent"
    }.call`;

    try {
      // Wrap in context.with() so that context.active() returns the turn span
      // context for ALL async continuations, including those created internally
      // by the Vercel AI SDK. Without this, detached spans lose their parent.
      await context.with(agentContext, () =>
        this.tracer.withActiveSpan(
          agentSpanName,
          {
            attributes: {
              [attributes.ATTR_LANGWATCH_THREAD_ID]: this.state.threadId,
              "scenario.role": role,
            },
          },
          agentContext,
          async (agentSpan) => {
          agentSpan.setType("agent");

          // Set input for the span
          agentSpan.setInput("chat_messages", this.state.messages);

          const agentResponse = await agent.call(agentInput);
          const endTime = Date.now();
          const duration = endTime - startTime;

          this.logger.debug(`[${this.config.id}] Agent responded`, {
            agentIdx: idx,
            duration,
            responseType: typeof agentResponse,
            isScenarioResult:
              agentResponse &&
              typeof agentResponse === "object" &&
              "success" in agentResponse,
          });

          this.addAgentTime(idx, duration);
          this.pendingMessages.delete(idx);

          if (
            agentResponse &&
            typeof agentResponse === "object" &&
            "success" in agentResponse
          ) {
            this.logger.debug(
              `[${this.config.id}] Agent returned ScenarioResult`,
              {
                success: (agentResponse as { success: boolean }).success,
              }
            );
            // JudgeResult is automatically augmented with messages by setResult
            this.setResult(agentResponse);
            return;
          }

          const messages = convertAgentReturnTypesToMessages(
            agentResponse,
            role === AgentRole.USER ? "user" : "assistant"
          );

          // Set output for the span
          if (messages.length > 0) {
            agentSpan.setOutput("chat_messages", messages);
          }

          // Set metrics if available (would need to be extracted from agent response)
          const metrics: Record<string, number> = {
            duration: endTime - startTime,
          };

          // Add token usage if available from agent response
          if (agentResponse && typeof agentResponse === "object") {
            const usage = (
              agentResponse as {
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                };
              }
            ).usage;
            if (usage) {
              if (usage.prompt_tokens !== undefined)
                metrics.promptTokens = usage.prompt_tokens;
              if (usage.completion_tokens !== undefined)
                metrics.completionTokens = usage.completion_tokens;
              if (usage.total_tokens !== undefined)
                metrics.totalTokens = usage.total_tokens;
            }
          }

          agentSpan.setMetrics(metrics);

          // Voice bridge (issue #705): a user-simulator turn generated inside
          // the `proceed()` loop returns TEXT; a voice agent under test needs
          // AUDIO or it never commits the turn (`receiveAudio` times out). TTS
          // the generated text into audio here — parity with the scripted
          // `user("text")` path's voiceify — so every `proceed()` user turn
          // re-engages the agent. No-op for text-only runs and non-user turns.
          const outgoing = await this.voiceifyGeneratedUserTurn(
            messages,
            idx,
            role,
          );

          // Add traceId to each message for proper correlation
          const traceId = agentSpan.spanContext().traceId.toString();

          for (const message of outgoing) {
            this.state.addMessage({
              ...message,
              traceId,
            });
            this.broadcastMessage(message, idx);
          }

          // Voice path: if a non-blocking agent turn is in flight when the
          // user-sim produces audio (e.g. via the script-level `agent({ wait:
          // false }) + user()` barge-in pattern), fire the interrupt so the
          // new audio lands mid-response. The proceed-loop path fires via
          // maybeScheduleInterruptedAgentTurn (inline, before `_step`); this
          // guard handles explicit `agent(wait:false)` script steps.
          if (role === AgentRole.USER && outgoing.length > 0) {
            const pendingTask = this.pendingAgentTask;
            if (pendingTask && !pendingTask.done) {
              await this.fireUserInterrupt(outgoing[outgoing.length - 1]);
            }
          }
        }
        )
      );
    } catch (error) {
      throw new Error(`[${agentName}] ${error}`, { cause: error });
    }
  }

  /**
   * Adds a message to the conversation history.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   * It automatically routes the message to the appropriate agent based on the message role:
   * - "user" messages are routed to USER role agents
   * - "assistant" messages are routed to AGENT role agents
   * - Other message types are added directly to the conversation
   *
   * @param message - The ModelMessage to add to the conversation
   *
   * @example
   * ```typescript
   * await execution.message({
   *   role: "user",
   *   content: "Hello, how are you?"
   * });
   * ```
   */
  async message(message: ModelMessage): Promise<void> {
    if (message.role === "user") {
      await this.scriptCallAgent(AgentRole.USER, message);
    } else if (message.role === "assistant") {
      await this.scriptCallAgent(AgentRole.AGENT, message);
    } else {
      this.state.addMessage(message);
      this.broadcastMessage(message);
    }
  }

  /**
   * Executes a user turn in the conversation.
   *
   * If content is provided, it's used directly as the user's message. If not provided,
   * the user simulator agent is called to generate an appropriate response based on
   * the current conversation context.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param content - Optional content for the user's message. Can be a string or ModelMessage.
   *                 If not provided, the user simulator agent will generate the content.
   *
   * @example
   * ```typescript
   * // Use provided content
   * await execution.user("What's the weather like?");
   *
   * // Let user simulator generate content
   * await execution.user();
   *
   * // Use a ModelMessage object
   * await execution.user({
   *   role: "user",
   *   content: "Tell me a joke"
   * });
   * ```
   */
  async user(content?: string | ModelMessage): Promise<void> {
    // Voice routing for an explicit, scripted user line (parity with
    // python/scenario/scenario_executor.py:user). Without this, a voice agent
    // under test (OpenAI Realtime, ElevenLabs hosted, Pipecat, …) sees a
    // text-only message when the script emits `scenario.user("...")` and never
    // receives audio — its `call()` then drains a response that was never
    // prompted and times out. Only applies to a plain string; a pre-built
    // ModelMessage (already audio, or a deliberate text turn) passes straight
    // through.
    if (typeof content === "string") {
      // (1) Realtime USER agent (e.g. OpenAI Realtime, role=USER) → speak the
      //     scripted line on the realtime session AND drain the spoken audio
      //     the model synthesizes for it (#705). The realtime model generates
      //     the voice natively (no TTS, §7.2); we capture that real audio and
      //     route it — as an AUDIO ModelMessage carrying the model's spoken
      //     transcript — to the agent under test (e.g. hosted ElevenLabs).
      //
      //     Why an audio message and not the old text-only record: the agent
      //     under test's voice adapter only "hears" a turn that carries audio
      //     (defaultVoiceCall extracts audio from the incoming message). The
      //     hosted EL transport additionally commits the turn from the chunk's
      //     transcript (turnCommitMode:"text"). Recording text alone left EL
      //     with nothing to commit, so its next agent() drained an unprompted
      //     response and timed out (#638). Speaking + bridging the audio is the
      //     realtime→realtime path "through the scenario API as is".
      const realtimeUser = this.findRealtimeUserAgent();
      if (realtimeUser) {
        const spoken = await realtimeUser.speakUserTurn(content);
        const audioMessage = createAudioMessage(
          new AudioChunk({
            data: spoken.data,
            transcript: spoken.transcript ?? content,
          }),
          "user",
        );
        // Barge-in parity with the voice-sim branch: if an agent({wait:false})
        // turn is in flight, THIS user turn is the interrupt.
        if (await this.maybeFireUserInterrupt(audioMessage)) return;
        await this.scriptCallAgent(AgentRole.USER, audioMessage);
        return;
      }
      // (2) Voice-capable user simulator → TTS the scripted text so the agent
      //     under test receives AUDIO. Route the resulting audio ModelMessage
      //     through the normal scriptCallAgent path (add + broadcast).
      const sim = this.findVoiceUserSim();
      if (sim) {
        const audioMessage = await sim.voiceifyText(content, this.config.voice);
        // Interruption path: when an `agent({ wait: false })` turn is in flight,
        // THIS user() call IS the barge-in. `agent({wait:false}) + user("...")`
        // reads as "agent starts replying; user interrupts" — no sleep needed.
        if (await this.maybeFireUserInterrupt(audioMessage)) return;
        await this.scriptCallAgent(AgentRole.USER, audioMessage);
        return;
      }
    }
    // (3) Default: text path (or a pre-built ModelMessage / generated turn).
    await this.scriptCallAgent(AgentRole.USER, content);
  }

  /**
   * If a non-blocking agent turn is in flight ({@link pendingAgentTask} set and
   * unsettled), fire the barge-in for `voicedMessage` and return `true`
   * (the caller must NOT then run the normal user turn — the interrupt already
   * delivered the audio). Returns `false` when there is nothing to interrupt.
   *
   * Mirrors the `_pending_agent_task` guard around Python's
   * `_fire_user_interrupt`.
   */
  private async maybeFireUserInterrupt(
    voicedMessage: ModelMessage,
  ): Promise<boolean> {
    const pending = this.pendingAgentTask;
    if (!pending || pending.done) return false;
    await this.fireUserInterrupt(voicedMessage);
    // Record the barge-in user turn in conversation history so the judge
    // and downstream agents see the correction. Mirrors the recording step in
    // maybeScheduleInterruptedAgentTurn (lines 1539-1543 pattern).
    this.state.addMessage(voicedMessage);
    this.broadcastMessage(voicedMessage);
    return true;
  }

  /**
   * Find a USER-role agent that speaks scripted lines verbatim into a realtime
   * session via `speakUserTurn` (the model synthesizes the voice itself) — the
   * OpenAI Realtime user-simulator path. Duck-typed to avoid coupling the
   * executor to the concrete adapter class.
   */
  private findRealtimeUserAgent(): RealtimeUserAgent | null {
    for (const agent of this.agents) {
      if (agent.role === AgentRole.USER && isRealtimeUserAgent(agent)) {
        return agent;
      }
    }
    return null;
  }

  /**
   * Find a voice-capable user simulator (has a non-empty `voice` and a
   * `voiceifyText` method). Mirrors Python's `_find_user_sim` + the
   * `getattr(sim, "voice", None)` guard. Duck-typed for the same reason.
   */
  private findVoiceUserSim(): VoiceUserSimulator | null {
    for (const agent of this.agents) {
      if (agent.role !== AgentRole.USER) continue;
      if (isVoiceUserSim(agent)) return agent;
    }
    return null;
  }

  /**
   * Voiceify the GENERATED text of a user-simulator turn into audio so a voice
   * agent under test receives audio — not text — during the `proceed()` loop.
   *
   * ## Why this exists (issue #705)
   *
   * Scripted `user("text")` voices correctly because {@link user} intercepts the
   * string and calls `sim.voiceifyText(content)` BEFORE broadcasting. But
   * `proceed(N)` drives the user simulator through {@link callAgent} with no
   * content — the simulator's `call()` returns a plain TEXT message, which is
   * broadcast as text. A {@link VoiceAgentAdapter} (e.g. hosted ElevenLabs) then
   * runs its default `call()`, finds NO audio in the latest message
   * (`extractIncomingAudio` → null), never calls `sendAudio`, and so never
   * commits a user turn — the next agent turn has nothing to answer and
   * `receiveAudio` times out. The result: `proceed(N)` collapses to a single
   * voiced exchange (only the scripted opener), exactly the #705 symptom.
   *
   * This bridges the gap: for each USER-role text message the simulator
   * generated, it synthesizes the equivalent audio message via the SAME
   * `voiceifyText` pipeline the scripted path uses, so the broadcast carries
   * audio and every `proceed()` user turn re-engages the agent. It is a no-op
   * (returns the input array unchanged) when:
   *   - the turn was not the USER role, or
   *   - no {@link VoiceAgentAdapter} participates (text-only run), or
   *   - the producing agent is not a voice-capable user simulator, or
   *   - the message already carries audio (scripted/realtime turns) or is empty.
   *
   * Mirrors the scripted-content voiceify branch of {@link user} (lines ~1128).
   * Python parity (`scenario_executor.py:_call_agent`) is a follow-up.
   *
   * @param messages - Messages the agent at `idx` produced for `role`.
   * @param idx - Index of the producing agent in {@link agents}.
   * @param role - The role the agent was called for.
   * @returns The messages to add/broadcast — voiced where applicable.
   * @throws {Error} ({@link USER_TURN_NO_AUDIO_FOR_VOICE_AUT}, the fail-closed
   *   invariant) when the FINAL (post-voiceify) user turn for a voice agent
   *   under test carries no audio. Adapter-AGNOSTIC and strictly stronger than
   *   the old realtime-user type-check it replaced: it trips on the produced
   *   ARTIFACT (a no-audio turn) regardless of producer type — catching a
   *   realtime adapter that returns text AND a non-realtime/non-voice-sim
   *   producer the type-check let through silently — rather than degrade the
   *   user side to a text turn the voice agent can't hear. The autonomous
   *   OpenAI Realtime user PASSES it (its `call()` returns audio).
   */
  private async voiceifyGeneratedUserTurn(
    messages: ModelMessage[],
    idx: number,
    role: AgentRole,
  ): Promise<ModelMessage[]> {
    if (role !== AgentRole.USER || messages.length === 0) return messages;
    if (this.findVoiceAgentAdapter() === null) return messages;
    const producer = this.agents[idx];

    // Voice-capable user simulator → TTS each generated TEXT turn into audio
    // (parity with the scripted user("text") path) so the agent under test
    // receives audio it can hear. A realtime user / any other producer is left
    // unchanged here — its own call() is responsible for returning audio. The
    // audio-presence invariant below is what makes leaving them unchanged safe.
    let outgoing = messages;
    if (producer && isVoiceUserSim(producer)) {
      const voiced: ModelMessage[] = [];
      for (const message of messages) {
        // Already audio (defensive — generated user-sim turns are text) → pass
        // through untouched so we never double-encode.
        if (messageHasAudio(message)) {
          voiced.push(message);
          continue;
        }
        const text =
          typeof message.content === "string"
            ? message.content
            : extractTranscript(message);
        if (!text) {
          voiced.push(message);
          continue;
        }
        voiced.push(await producer.voiceifyText(text, this.config.voice));
      }
      outgoing = voiced;
    }

    // Fail-closed invariant (adapter-AGNOSTIC): a USER turn for a voice agent
    // under test MUST carry REAL content — audio bytes the AUT can hear, or a
    // transcript (for a text-commit adapter) — the why is on
    // USER_TURN_NO_AUDIO_FOR_VOICE_AUT.
    // LOAD-BEARING ORDER: this runs AFTER the voiceify/TTS step, on the FINAL
    // outgoing turn — so a legitimate voice-user-sim TEXT turn (text is PRE-TTS)
    // is allowed through ONCE voiced, while a realtime adapter that returns text,
    // or any producer that yields a CONTENT-LESS user turn, fails loud rather
    // than silently degrading the agent under test to a turn it can't hear.
    // NB: test real content, not `messageHasAudio` — a ZERO-byte audio part still
    // "has audio" (extractAudio is non-null), so an empty-audio #708-flake turn
    // would sail through and feed the AUT silence (a receiveAudio-timeout hang).
    // It is the produced ARTIFACT, not the producer's TYPE, that trips it —
    // strictly stronger than the old isRealtimeUserAgent check.
    const carriesContent = outgoing.some((message) => {
      const audio = extractAudio(message);
      return (
        !!audio && (audio.data.length > 0 || (audio.transcript?.length ?? 0) > 0)
      );
    });
    if (!carriesContent) {
      throw new Error(USER_TURN_NO_AUDIO_FOR_VOICE_AUT);
    }
    return outgoing;
  }

  /**
   * Executes an agent turn in the conversation.
   *
   * If content is provided, it's used directly as the agent's response. If not provided,
   * the agent under test is called to generate a response based on the current conversation
   * context and any pending messages.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param content - Optional content for the agent's response. Can be a string or ModelMessage.
   *                 If not provided, the agent under test will generate the response.
   *
   * @example
   * ```typescript
   * // Let agent generate response
   * await execution.agent();
   *
   * // Use provided content
   * await execution.agent("The weather is sunny today!");
   *
   * // Use a ModelMessage object
   * await execution.agent({
   *   role: "assistant",
   *   content: "I'm here to help you with weather information."
   * });
   * ```
   */
  async agent(content?: string | ModelMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.AGENT, content);
  }

  /**
   * Fire an agent turn WITHOUT awaiting it (PRD §4.4 `agent({ wait: false })`).
   * The in-flight promise is recorded on {@link pendingAgentTask} so the next
   * {@link user} call can detect it and fire a mid-stream barge-in. Mirrors
   * Python's `agent(wait=False)` setting `_pending_agent_task`.
   *
   * Errors from the background turn are swallowed here (they surface via the
   * recorded segments / the recovery turn) — exactly as the previous
   * `void executor.agent().catch()` call sites did.
   */
  agentNonBlocking(content?: string | ModelMessage): void {
    const entry: { promise: Promise<void>; done: boolean; error: unknown | null } = {
      // Assigned in the same statement; the `.finally` below closes over
      // `entry` and only runs after this turn settles, by which point the field
      // holds the real promise (no dead Promise.resolve() placeholder — review
      // H6).
      promise: this.scriptCallAgent(AgentRole.AGENT, content)
        .then(() => undefined)
        .catch((err: unknown) => {
          entry.error = err; // capture, don't swallow — re-thrown at drain/interrupt time
        })
        .finally(() => {
          entry.done = true;
        }),
      done: false,
      error: null,
    };
    this.pendingAgentTask = entry;
  }

  /**
   * Invokes the judge agent to evaluate the current state of the conversation.
   *
   * The judge agent analyzes the conversation history and determines whether the
   * scenario criteria have been met. This can result in either:
   * - A final scenario result (success/failure) if the judge makes a decision
   * - Null if the judge needs more information or conversation to continue
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param options - Optional options with inline criteria to evaluate as a checkpoint.
   * @returns A promise that resolves with:
   *   - ScenarioResult if the judge makes a final decision, or
   *   - Null if the conversation should continue
   *
   * @example
   * ```typescript
   * // Let judge evaluate with its configured criteria
   * const result = await execution.judge();
   *
   * // Evaluate inline criteria as a checkpoint
   * const result = await execution.judge({ criteria: ["Agent responded helpfully"] });
   *
   * // Provide additional context for tool-call-heavy conversations
   * const result = await execution.judge({
   *   criteria: ["Agent installed the dependency"],
   *   additionalContext: "The agent ran `npm install -g git-orchard` which exited 0.",
   * });
   * ```
   */
  async judge(options?: {
    criteria?: string[];
    additionalContext?: string;
    /** @deprecated Use `additionalContext` instead. */
    context?: string;
  }): Promise<ScenarioResult | null> {
    return await this.scriptCallAgent(
      AgentRole.JUDGE,
      undefined,
      { criteria: options?.criteria, additionalContext: options?.additionalContext ?? options?.context }
    );
  }

  /**
   * Lets the scenario proceed automatically for a specified number of turns.
   *
   * This method is a script step that simulates natural conversation flow by allowing
   * agents to interact automatically without explicit script steps. It can trigger
   * multiple agent interactions across multiple turns, making it useful for testing
   * scenarios where you want to see how agents behave in extended conversations.
   *
   * Unlike other script steps that typically trigger one agent interaction each,
   * this step can trigger many agent interactions depending on the number of turns
   * and the agents' behavior.
   *
   * The method will continue until:
   * - The specified number of turns is reached
   * - A final scenario result is determined
   * - The maximum turns limit is reached
   *
   * @param turns - The number of turns to proceed. If undefined, runs until a conclusion
   *               or max turns is reached
   * @param onTurn - Optional callback executed at the end of each turn. Receives the
   *                current execution state
   * @param onStep - Optional callback executed after each agent interaction. Receives
   *                the current execution state
   * @returns A promise that resolves with:
   *   - ScenarioResult if a conclusion is reached during the proceeding, or
   *   - Null if the specified turns complete without conclusion
   *
   * @example
   * ```typescript
   * // Proceed for 5 turns
   * const result = await execution.proceed(5);
   *
   * // Proceed until conclusion with callbacks
   * const result = await execution.proceed(
   *   undefined,
   *   (state) => console.log(`Turn ${state.currentTurn} completed`),
   *   (state) => console.log(`Agent interaction completed, ${state.messages.length} messages`)
   * );
   * ```
   */
  async proceed(
    turns?: number,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<ScenarioResult | null> {
    this.logger.debug(`[${this.config.id}] proceed called`, {
      turns,
      currentTurn: this.state.currentTurn,
    });

    let initialTurn = this.state.currentTurn;

    while (true) {
      const goToNextTurn =
        turns === void 0 ||
        initialTurn === null ||
        (this.state.currentTurn != null &&
          this.state.currentTurn + 1 < initialTurn + turns);

      // Voice path (PRD §4.4 / §4.2 — Gap #8): BEFORE _step, roll the
      // interruption probability against the upcoming AGENT role. On a hit,
      // the agent turn is dispatched non-blocking and AGENT is popped from
      // pendingRolesOnTurn, so _step advances to USER. The USER turn's audio
      // is then delivered as a real mid-stream barge-in via callAgent's
      // pendingAgentTask check. Mirrors Python's proceed loop calling
      // _maybe_schedule_interrupted_agent_turn() before _step().
      // Text-only runs: maybeScheduleInterruptedAgentTurn bails; the
      // post-step maybeInjectInterruption handles that path.
      await this.maybeScheduleInterruptedAgentTurn();

      await this._step(goToNextTurn, onTurn);

      if (initialTurn === null) initialTurn = this.state.currentTurn;

      if (this.result) {
        return this.result;
      }

      if (onStep) await onStep(this.state);

      // Text-only fallback (Gap #8): for runs without a voice adapter, inject
      // a canned-phrase turn post-step. Voice runs use the pre-step path above
      // (maybeScheduleInterruptedAgentTurn) — this is a no-op for them.
      await this.maybeInjectInterruption();
      if (this.result) {
        return this.result;
      }

      if (!goToNextTurn) {
        return null;
      }
    }
  }

  /**
   * Single override bag for all test-injectable interrupt seams.
   *
   * Consolidates the three formerly scattered `@internal` public fields into
   * one named gateway (issue #575). Tests assign this directly — no
   * `as unknown as` cast needed:
   *
   * ```ts
   * exec.interruptOverrides = { rng: () => 0 };
   * ```
   *
   * Fields:
   * - `rng` — RNG for interruption decisions (defaults to `Math.random`).
   * - `waitForSpeechMs` — per-barge-in wait bound in {@link fireUserInterrupt}
   *   (overrides `DEFAULT_WAIT_FOR_SPEECH_MS`). Same value that the
   *   `interrupt()` step threads through `waitForSpeechTimeout`.
   * - `bargeInDelayMs` — post-speech delay in {@link fireUserInterrupt} (set
   *   by {@link prepareAndFireBargeIn} from `InterruptionConfig.sampleDelay`).
   *
   * @internal
   */
  interruptOverrides?: {
    rng?: () => number;
    waitForSpeechMs?: number;
    bargeInDelayMs?: number;
  };

  /**
   * Effective RNG for interruption decisions.
   *
   * Reads `interruptOverrides.rng` when set; otherwise defaults to
   * `Math.random`. Internal call sites call `this.interruptRng()` — this
   * getter makes the override transparent to those sites.
   *
   * @internal
   */
  private get interruptRng(): () => number {
    return this.interruptOverrides?.rng ?? Math.random;
  }

  /**
   * Optional per-barge-in wait override (ms) for {@link fireUserInterrupt}.
   * Threaded by the `interrupt()` step from `waitForSpeechTimeout` so the
   * step and the executor agree on ONE timeout. Consumed (reset to
   * `undefined`) on each barge-in. See also `interruptOverrides.waitForSpeechMs`.
   *
   * @internal Set by the `interrupt()` script step; consumed by {@link fireUserInterrupt}.
   */
  interruptWaitForSpeechMs?: number;

  /**
   * Optional delay (ms) applied AFTER the agent starts speaking in
   * {@link fireUserInterrupt}. Set by {@link prepareAndFireBargeIn} from
   * `InterruptionConfig.sampleDelay`. Consumed (reset to `undefined`) on each
   * barge-in. See also `interruptOverrides.bargeInDelayMs`.
   *
   * @internal Set by {@link prepareAndFireBargeIn}; consumed by {@link fireUserInterrupt}.
   */
  interruptBargeInDelayMs?: number;

  /**
   * Pre-step voice interruption scheduling (issue #372 proceed-loop fix).
   *
   * Mirrors Python's `_maybe_schedule_interrupted_agent_turn`. If an
   * {@link InterruptionConfig} is active and the NEXT runnable role is AGENT,
   * samples the probability and — on a hit — dispatches the agent turn as a
   * non-blocking background task (setting {@link pendingAgentTask}) then fires
   * the barge-in inline (without waiting for the user-sim's full LLM call).
   *
   * ## Why inline rather than delegating to the USER role in `callAgent`
   *
   * Delegating to USER (`callAgent` line 990-994) requires the user-sim's
   * full `call()` chain: LLM text generation (~1-2 s) + TTS synthesis (~0.5-1 s)
   * ≈ 1.5-3 s. The pipecat bot's audio reply completes in ~1-3 s. The two
   * windows overlap non-deterministically — in practice the bot often finishes
   * before the user-sim, so `pendingAgentTask.done` is already `true` by the
   * time the USER check fires, and the interrupt never happens.
   *
   * Inline firing bypasses the LLM step: pick a phrase → TTS only (~0.5-1 s) →
   * `fireUserInterrupt` (which itself waits for the bot to start speaking before
   * sending audio). TTS alone is reliably faster than the bot's full reply
   * duration, so the interrupt lands while the bot is still streaming.
   *
   * ## delayRange sleep (issue #372 follow-up)
   *
   * After dispatching AGENT non-blocking, the method samples a delay from
   * {@link InterruptionConfig.delayRange} and stores it on
   * {@link interruptBargeInDelayMs}. {@link fireUserInterrupt} applies the
   * sleep AFTER `agentSpeakingEvent` fires — NOT before `voiceifyText` — so:
   *   (a) the delay is measured from when the bot starts speaking (matching the
   *       spec "sleep between speech start and barge-in fire"); and
   *   (b) burst-TTS bots (e.g. pipecat stub) that drain their receive queue
   *       instantly don't drain to completion before the interrupt window opens
   *       (placing the sleep before `voiceifyText` causes `entry.done=true`
   *       for those adapters, silently skipping the barge-in).
   * Without this delay, `fireUserInterrupt` fires on the bot's very first audio
   * chunk — truncating replies to ~110 ms and collapsing multi-turn demos to
   * a 10 s recording. Mirrors the same sleep in the text-only fallback
   * {@link maybeInjectInterruption}. Callers that need fast, deterministic
   * unit tests should set `delayRange: [0, 0]` on their
   * {@link InterruptionConfig}.
   *
   * Returns `true` if an interruption was scheduled and fired (the proceed loop
   * should advance to JUDGE, which runs a non-final check). Returns `false`
   * (no-op) for:
   * - text-only runs (no {@link VoiceAgentAdapter})
   * - no voice-capable user simulator (no `voiceifyText`)
   * - when the next runnable role is not AGENT
   * - when a task is already in-flight
   * - when the RNG roll declines
   */
  private async maybeScheduleInterruptedAgentTurn(): Promise<boolean> {
    const config = this.resolveInterruptionConfig();
    if (!config) return false;
    if (this.findVoiceAgentAdapter() === null) return false;
    const voiceUserSim = this.findVoiceUserSim();
    if (!voiceUserSim) return false;
    const existing = this.pendingAgentTask;
    if (existing && !existing.done) return false;
    if (this.interruptRng() >= config.probability) return false;

    const agentLookup = this.resolveNextAgentForInlineBarge();
    if (!agentLookup) return false;

    this.consumePendingRolesUntilAgent(agentLookup.agent);
    const entry = this.dispatchAgentBackground(agentLookup.idx);
    return this.prepareAndFireBargeIn(config, voiceUserSim, entry);
  }

  /**
   * Verify the bail conditions for an inline barge-in and return the AGENT
   * index + adapter when the pre-conditions are met.
   *
   * Walks `pendingRolesOnTurn` to confirm AGENT is the next runnable role
   * (mirrors Python's `_pending_roles_on_turn` walk). Returns `null` to
   * bail when AGENT is not next.
   *
   * @internal Extracted from {@link maybeScheduleInterruptedAgentTurn}.
   */
  private resolveNextAgentForInlineBarge(): {
    idx: number;
    agent: AgentAdapter;
  } | null {
    // Walk pendingRolesOnTurn to find the next role that will actually run.
    let nextRole: AgentRole | null = null;
    for (const r of this.pendingRolesOnTurn) {
      const { agent } = this.nextAgentForRole(r);
      if (agent !== null) {
        nextRole = r;
        break;
      }
    }
    if (nextRole !== AgentRole.AGENT) return null;

    const { idx, agent } = this.nextAgentForRole(AgentRole.AGENT);
    if (!agent) return null;
    return { idx, agent };
  }

  /**
   * Queue surgery: remove `agent` from `pendingAgentsOnTurn` and consume
   * all roles from `pendingRolesOnTurn` up to and including AGENT so the
   * next `_step` call advances to JUDGE cleanly. Mirrors Python's while-loop
   * in `_maybe_schedule_interrupted_agent_turn`.
   *
   * @internal Extracted from {@link maybeScheduleInterruptedAgentTurn}.
   */
  private consumePendingRolesUntilAgent(agent: AgentAdapter): void {
    this.removePendingAgent(agent);
    while (
      this.pendingRolesOnTurn.length > 0 &&
      this.pendingRolesOnTurn[0] !== AgentRole.AGENT
    ) {
      this.pendingRolesOnTurn.shift();
    }
    if (
      this.pendingRolesOnTurn.length > 0 &&
      this.pendingRolesOnTurn[0] === AgentRole.AGENT
    ) {
      this.pendingRolesOnTurn.shift();
    }
  }

  /**
   * Dispatch the agent at `idx` as a non-blocking background task, record it
   * on `pendingAgentTask`, and return the entry so the caller can poll
   * `entry.done` before firing the barge-in.
   *
   * Uses `callAgent` directly (NOT `agentNonBlocking` / `scriptCallAgent`)
   * because the role has already been popped from `pendingRolesOnTurn` by
   * {@link consumePendingRolesUntilAgent}; `scriptCallAgent` would try a new
   * turn. Mirrors Python's
   * `asyncio.create_task(self._call_agent(idx, role=AGENT))`.
   *
   * @internal Extracted from {@link maybeScheduleInterruptedAgentTurn}.
   */
  private dispatchAgentBackground(idx: number): {
    promise: Promise<void>;
    done: boolean;
    error: unknown | null;
  } {
    const entry: { promise: Promise<void>; done: boolean; error: unknown | null } = {
      promise: this.callAgent(idx, AgentRole.AGENT)
        .then(() => undefined)
        .catch((err: unknown) => {
          entry.error = err; // captured, re-thrown by fireUserInterrupt/drain
        })
        .finally(() => {
          entry.done = true;
        }),
      done: false,
      error: null,
    };
    this.pendingAgentTask = entry;
    return entry;
  }

  /**
   * Sample the barge-in delay, TTS the interrupt phrase, fire the inline
   * barge-in, and record the user message in the conversation.
   *
   * Returns `true` in all cases (AGENT was dispatched; barge-in either fired
   * or was skipped because the bot finished first / TTS failed).
   *
   * @internal Extracted from {@link maybeScheduleInterruptedAgentTurn}.
   */
  private async prepareAndFireBargeIn(
    config: InterruptionConfig,
    voiceUserSim: VoiceUserSimulator,
    entry: { promise: Promise<void>; done: boolean; error: unknown | null },
  ): Promise<boolean> {
    // Sample the delay BEFORE voiceifyText so it is applied AFTER
    // agentSpeakingEvent fires (in fireUserInterrupt) — not before TTS.
    // Placing the sleep before TTS causes burst-TTS bots (pipecat stub) to
    // drain to entry.done=true and silently skip the barge-in window.
    const delaySeconds = config.sampleDelay(this.interruptRng);
    if (delaySeconds > 0) {
      this.interruptBargeInDelayMs = Math.floor(delaySeconds * 1000);
    }

    const phrase = config.pickRandomPhrase(this.interruptRng);
    let voicedMessage: ModelMessage | null = null;
    try {
      voicedMessage = await voiceUserSim.voiceifyText(
        phrase,
        this.config.voice,
      );
    } catch {
      // Best-effort: if TTS fails, skip the barge-in for this turn.
      // Clear the sampled delay so a later successful barge-in does not
      // inherit the stale value from this failed attempt (P2 fix).
      this.interruptBargeInDelayMs = undefined;
      return true; // AGENT is still dispatched; proceed continues normally.
    }

    if (entry.done) {
      // Bot finished before TTS completed — nothing to interrupt.
      return true;
    }
    await this.fireUserInterrupt(voicedMessage);

    // Record the user interrupt message in the conversation so the judge
    // and subsequent turns see it in context. Mirrors scriptCallAgent's
    // message recording path.
    this.state.addMessage(voicedMessage);
    this.broadcastMessage(voicedMessage);

    return true;
  }

  /**
   * Resolve the active {@link InterruptionConfig} for the run:
   * - `voiceProceed({ interruptions })` config (on the executor state) wins.
   * - else, when a user simulator declares `interruptProbability > 0`, build
   *   a default config from it.
   * - else `null` (no interruptions).
   */
  private resolveInterruptionConfig(): InterruptionConfig | null {
    if (this.voiceInterruptions instanceof InterruptionConfig) {
      return this.voiceInterruptions;
    }
    if (this.voiceInterruptions) {
      // A plain InterruptionConfigInit-shaped object was recorded — wrap it.
      return new InterruptionConfig(this.voiceInterruptions);
    }
    const prob = this.userSimulatorInterruptProbability();
    if (prob > 0) {
      return new InterruptionConfig({ probability: prob });
    }
    return null;
  }

  /** Read `interruptProbability` off a user-simulator agent, if any declares it. */
  private userSimulatorInterruptProbability(): number {
    for (const agent of this.agents) {
      const p = (agent as { interruptProbability?: unknown })
        .interruptProbability;
      if (typeof p === "number" && p > 0) return p;
    }
    return 0;
  }

  /**
   * Text-only fallback for proceed-loop interruptions (Gap #8).
   *
   * For voice runs, {@link maybeScheduleInterruptedAgentTurn} handles the
   * interruption PRE-step via the real barge-in path. This method is a
   * POST-step fallback that handles text-only runs (no {@link VoiceAgentAdapter})
   * — it injects a canned user turn after the agent responds. Voice runs bail
   * immediately to avoid double injection.
   *
   * Deterministic with the injected `interruptRng`. Returns immediately for
   * voice runs (handled by pre-step path) or when the config declines.
   */
  private async maybeInjectInterruption(): Promise<void> {
    // Voice runs: the pre-step maybeScheduleInterruptedAgentTurn handles the
    // real barge-in. This post-step injection would double-fire — skip it.
    if (this.findVoiceAgentAdapter() !== null) return;

    const config = this.resolveInterruptionConfig();
    if (!config) return;
    if (!config.shouldInterrupt(this.interruptRng)) return;

    // Honour the configured delayRange (PRD §4.4): wait a sampled delay before
    // barging in, so the interruption lands partway into the agent's turn
    // rather than instantly. Deterministic via the injected `interruptRng`.
    // No Math.floor here: the value goes directly to setTimeout (which accepts
    // fractional ms and clamps internally). The floor in
    // maybeScheduleInterruptedAgentTurn is intentional — that path stores the
    // value as an integer-ms field before consuming it in fireUserInterrupt.
    const delaySeconds = config.sampleDelay(this.interruptRng);
    if (delaySeconds > 0) {
      await sleep(delaySeconds * 1000);
    }

    // Record the interruption on the voice timeline when a recording exists.
    // Timestamp on the byte-accurate audio cursor — the SAME clock segments
    // ride (adapter.runtime `layNextSegment`) — so `markTruncatedAgentSegments`
    // compares like-for-like (review BLOCKER). The agent turn for this proceed
    // iteration was just recorded, so the cursor sits at that segment's
    // `endTime`; the inclusive containment check marks it as truncated.
    if (this.voiceRecording || this.voiceTimeline || this.onVoiceEvent) {
      const time = this.voiceAudioCursor ?? 0;
      const event: VoiceEvent = {
        time,
        type: "user_interrupt",
        metadata: { source: "proceed-interruption", strategy: config.strategy },
      };
      appendEvent(this, event);
    }

    // Inject the interruption turn. `random_phrase` sends a canned phrase as
    // explicit content; `contextual` lets the user simulator generate one.
    if (config.strategy === "random_phrase") {
      await this.user(config.pickRandomPhrase(this.interruptRng));
    } else {
      await this.user();
    }
  }

  /**
   * Find the first {@link VoiceAgentAdapter} on the scenario, if any — by
   * convention the agent-under-test. Used by the barge-in path to push the
   * interrupting user audio onto the wire directly. Mirrors Python's
   * `_find_voice_adapter`.
   *
   * Reuses {@link voiceAdapters} (populated by the duck-typed
   * `pickVoiceAdapters` at scenario start) rather than re-deriving a third
   * type-guard (review m1/H2) — `findVoiceAgentAdapter` only ever runs during
   * the script loop, after that population.
   */
  private findVoiceAgentAdapter(): VoiceAgentAdapter | null {
    return this.voiceAdapters[0] ?? null;
  }

  /**
   * Mid-stream interrupt: fire the transport-native cancel (if the adapter
   * advertises `capabilities.interruption`), push the new user audio onto the
   * wire so the bot's VAD detects the overlap, record a `user_interrupt`
   * timeline event + a user segment for the interrupting turn, then let the
   * in-flight agent task settle. Mirrors Python's `_fire_user_interrupt`
   * (issue #466/#467): be PROMPT, not POLITE — push audio whether or not the
   * agent has started speaking; the provider VADs handle the rest.
   *
   * PRECONDITION: only invoked by {@link maybeFireUserInterrupt}, which has
   * already verified an in-flight, un-settled {@link pendingAgentTask} exists —
   * so there is no `pending_done` outcome here (the guard lives at the single
   * call site, not duplicated).
   *
   * Records `metadata.outcome`:
   *  - `no_adapter` — text-only path, nothing to barge in on;
   *  - `fired_after_speech` — the agent had started speaking (true mid-stream);
   *  - `fired_before_speech` — barge-in landed in the bot's pre-reply window.
   *
   * The `user_interrupt` event is timestamped on the byte-accurate audio cursor
   * (`voiceAudioCursor`) — the SAME clock segments ride — captured at the
   * barge-in instant. The truncated agent segment is laid either just BEFORE
   * (fast transport: already recorded → cursor == its `endTime`) or just AFTER
   * (slow transport: recorded during settle → cursor == its `startTime`) this
   * capture; either way the cursor lands on a segment boundary, and the
   * inclusive containment in {@link markTruncatedAgentSegments} marks it. This
   * is why we no longer carry a clock-agnostic last-segment workaround AND a
   * cross-clock post-hoc pass (review BLOCKER): one cursor-based mechanism.
   */
  private async fireUserInterrupt(voicedMessage: ModelMessage): Promise<void> {
    // Consume the per-barge-in wait override up front (cleared so a later
    // raw `user()` barge-in can't inherit a stale `interrupt()` budget).
    // Priority: per-barge-in field (set by interrupt() step) → override bag
    // (set by tests via interruptOverrides.waitForSpeechMs) → module default.
    const waitMs =
      this.interruptWaitForSpeechMs ??
      this.interruptOverrides?.waitForSpeechMs ??
      DEFAULT_WAIT_FOR_SPEECH_MS;
    this.interruptWaitForSpeechMs = undefined;
    // Consume the post-speech delay (set by prepareAndFireBargeIn from
    // InterruptionConfig.sampleDelay). Override bag provides a test seam.
    const bargeInDelayMs =
      this.interruptBargeInDelayMs ?? this.interruptOverrides?.bargeInDelayMs;
    this.interruptBargeInDelayMs = undefined;

    const pending = this.pendingAgentTask;
    // Precondition (see jsdoc): the sole caller guarantees a live task. Guard
    // defensively rather than emit a bogus event if that ever changes.
    if (!pending || pending.done) return;
    const adapter = this.findVoiceAgentAdapter();

    // Byte-cursor timestamp for the barge-in. Default for the proceed/raw path;
    // refreshed at the actual barge-in instant in the adapter branch below.
    let interruptTime = this.voiceAudioCursor ?? 0;
    let outcome: string;
    let nativeFired = false;

    if (adapter === null) {
      outcome = "no_adapter";
      await pending.promise;
      this.pendingAgentTask = null;
      if (pending.error) throw pending.error;
    } else {
      // Best-effort wait for the agent to start speaking so the barge-in lands
      // mid-utterance. Bounded so a hung bot can't stall the script — the bound
      // is the step's `waitForSpeechTimeout` when threaded by `interrupt()`,
      // else the module default.
      const speaking = adapter.agentSpeakingEvent;
      if (speaking && !speaking.isSet()) {
        await Promise.race([speaking.wait(), sleep(waitMs)]);
      }
      const agentWasSpeaking = Boolean(speaking?.isSet());
      outcome = agentWasSpeaking ? "fired_after_speech" : "fired_before_speech";

      // Honour the configured delayRange: sleep between speech start and barge-in
      // fire so the agent gets to say something substantive before being cut off.
      // Applied here — AFTER agentSpeakingEvent fires — so that:
      //   (a) the delay is measured from when the bot starts speaking, not from
      //       when AGENT was dispatched (matching the spec "delayRange = sleep
      //       between speech start and barge-in fire");
      //   (b) burst-TTS bots (e.g. pipecat stub) don't drain their full audio
      //       queue before the interrupt fires; placing the sleep before
      //       voiceifyText causes entry.done=true for those adapters.
      // Mirrors maybeInjectInterruption (scenario-execution.ts, text-only path).
      if (bargeInDelayMs !== undefined && bargeInDelayMs > 0) {
        await sleep(bargeInDelayMs);
      }

      // Capture the cursor at the barge-in instant. If the fast transport
      // already recorded the agent segment, the cursor sits at its `endTime`;
      // otherwise it sits where the about-to-be-recorded agent segment starts.
      interruptTime = this.voiceAudioCursor ?? 0;

      // 1. Native cancel first (Twilio clear / OpenAI Realtime response.cancel).
      if (adapter.capabilities.interruption) {
        try {
          await adapter.interrupt();
          nativeFired = true;
        } catch {
          // Best-effort: step 2 (push audio) is the load-bearing barge-in.
        }
      }

      // 2. Push the user audio — the bot's VAD detects the overlap and cuts its
      //    reply, even without a native cancel (EL ConvAI, Gemini Live). The
      //    wire send is PROMPT (now); recording the user segment is DEFERRED to
      //    step 4 so the interrupted agent segment (laid during settle on a slow
      //    transport) lands on the cursor BEFORE the barge-in user segment.
      const chunk = extractAudio(voicedMessage);
      let audioSent = false;
      if (chunk) {
        try {
          await adapter.sendAudio(chunk);
          audioSent = true;
        } catch {
          // Best-effort: the adapter may have torn down mid-flight.
        }
        if (audioSent) {
          // The audio went out of band (hand-delivered), so drop it from this
          // adapter's pending queue — otherwise the recovery agent() re-sends
          // it. Mirrors Python's `_clear_adapter_pending_messages`.
          this.clearAdapterPendingMessages(adapter);
        }
      }

      // 3. Let the in-flight agent task settle (JS promises aren't cancelable;
      //    the agent's call() finishes/errors naturally once we've barged in).
      //    The interrupted agent segment is recorded HERE on a slow transport.
      await pending.promise;
      this.pendingAgentTask = null;
      if (pending.error) throw pending.error;

      // 4. Now record the interrupting user turn on the byte cursor — AFTER the
      //    agent segment so the manifest reads agent-(truncated)→user-barge-in
      //    (issue #466 — Gemini emitted the event but no user segment without
      //    this). Truncation marking is the post-hoc cursor pass in
      //    `markTruncatedAgentSegments`; no inline marking here.
      if (audioSent && chunk && this.voiceRecording) {
        writeUserSegment(this, chunk);
      }
    }

    appendEvent(this, {
      time: interruptTime,
      type: "user_interrupt",
      metadata: { source: "barge-in", outcome, native: nativeFired },
    });
  }

  /**
   * Drop all queued pending messages for the given adapter's index. Called
   * after {@link fireUserInterrupt} hand-delivers the interrupting audio, so
   * the recovery `agent()` turn does not re-send it. Mirrors Python's
   * `_clear_adapter_pending_messages`.
   */
  private clearAdapterPendingMessages(adapter: VoiceAgentAdapter): void {
    const idx = this.agents.indexOf(adapter as unknown as AgentAdapter);
    if (idx >= 0) this.pendingMessages.set(idx, []);
  }

  /**
   * Immediately ends the scenario with a success verdict.
   *
   * This method forces the scenario to end successfully, regardless of the current
   * conversation state. It's useful for scenarios where you want to explicitly
   * mark success based on specific conditions or external factors.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param reasoning - Optional explanation for why the scenario is being marked as successful
   * @returns A promise that resolves with the final successful scenario result
   *
   * @example
   * ```typescript
   * // Mark success with default reasoning
   * const result = await execution.succeed();
   *
   * // Mark success with custom reasoning
   * const result = await execution.succeed(
   *   "User successfully completed the onboarding flow"
   * );
   * ```
   */
  async succeed(reasoning?: string): Promise<ScenarioResult> {
    return this.setResult({
      success: true,
      reasoning:
        reasoning || "Scenario marked as successful with Scenario.succeed()",
      metCriteria: [],
      unmetCriteria: [],
    });
  }

  /**
   * Immediately ends the scenario with a failure verdict.
   *
   * This method forces the scenario to end with failure, regardless of the current
   * conversation state. It's useful for scenarios where you want to explicitly
   * mark failure based on specific conditions or external factors.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param reasoning - Optional explanation for why the scenario is being marked as failed
   * @returns A promise that resolves with the final failed scenario result
   *
   * @example
   * ```typescript
   * // Mark failure with default reasoning
   * const result = await execution.fail();
   *
   * // Mark failure with custom reasoning
   * const result = await execution.fail(
   *   "Agent failed to provide accurate weather information"
   * );
   * ```
   */
  async fail(reasoning?: string): Promise<ScenarioResult> {
    return this.setResult({
      success: false,
      reasoning: reasoning || "Scenario marked as failed with Scenario.fail()",
      metCriteria: [],
      unmetCriteria: [],
    });
  }

  /**
   * Adds execution time for a specific agent to the performance tracking.
   *
   * This method is used internally to track how long each agent takes to respond,
   * which is included in the final scenario result for performance analysis.
   * The accumulated time for each agent is used to calculate total agent response
   * times in the scenario result.
   *
   * @param agentIdx - The index of the agent in the agents array
   * @param time - The execution time in milliseconds to add to the agent's total
   *
   * @example
   * ```typescript
   * // This is typically called internally by the execution engine
   * execution.addAgentTime(0, 1500); // Agent at index 0 took 1.5 seconds
   * ```
   */
  addAgentTime(agentIdx: number, time: number): void {
    const currentTime = this.agentTimes.get(agentIdx) || 0;

    this.agentTimes.set(agentIdx, currentTime + time);
  }

  /**
   * Internal method to handle script step calls to agents.
   *
   * This method is the core logic for executing script steps that involve agent
   * interactions. It handles finding the appropriate agent for the given role,
   * managing turn progression, and executing the agent's response.
   *
   * The method will:
   * - Find the next available agent for the specified role
   * - Progress to a new turn if no agent is available
   * - Execute the agent with the provided content or let it generate content
   * - Handle judgment requests for judge agents
   * - Set the result if the agent makes a decision
   *
   * @param role - The role of the agent to call (USER, AGENT, or JUDGE)
   * @param content - Optional content to use instead of letting the agent generate it
   * @param judgmentRequest - Whether this is a judgment request (for judge agents)
   * @returns A promise that resolves with a ScenarioResult if the agent makes a final
   *          decision, or null if the conversation should continue
   * @throws Error if no agent is found for the specified role
   */
  private async scriptCallAgent(
    role: AgentRole,
    content?: string | ModelMessage,
    judgmentRequest?: JudgmentRequest
  ): Promise<ScenarioResult | null> {
    this.logger.debug(`[${this.config.id}] scriptCallAgent`, {
      role,
      hasContent: content !== undefined,
      judgmentRequest: judgmentRequest != null,
      hasInlineCriteria: judgmentRequest?.criteria != null,
    });

    this.consumeUntilRole(role);

    let nextAgent = this.getNextAgentForRole(role);
    if (!nextAgent) {
      this.newTurn();
      this.consumeUntilRole(role);

      nextAgent = this.getNextAgentForRole(role);
    }

    if (!nextAgent) {
      let roleClass = "";
      switch (role) {
        case AgentRole.USER:
          roleClass = "a scenario.userSimulatorAgent()";
          break;
        case AgentRole.AGENT:
          roleClass = "a scenario.agent()";
          break;
        case AgentRole.JUDGE:
          roleClass = "a scenario.judgeAgent()";
          break;

        default:
          roleClass = "your agent";
      }

      if (content)
        throw new Error(
          `Cannot generate a message for role \`${role}\` with content \`${content}\` because no agent with this role was found, please add ${roleClass} to the scenario \`agents\` list`
        );

      throw new Error(
        `Cannot generate a message for role \`${role}\` because no agent with this role was found, please add ${roleClass} to the scenario \`agents\` list`
      );
    }

    const index = nextAgent.index;
    const agent = nextAgent.agent;

    this.removePendingAgent(agent);

    if (content) {
      const message =
        typeof content === "string"
          ? ({
              role: role === AgentRole.USER ? "user" : "assistant",
              content,
            } as ModelMessage)
          : content;
      this.state.addMessage(message);
      this.broadcastMessage(message, index);

      return null;
    }

    await this.callAgent(index, role, judgmentRequest);

    // Handle inline criteria checkpoint semantics
    if (this.result && judgmentRequest?.criteria != null) {
      this.checkpointResults.push({
        metCriteria: this.result.metCriteria,
        unmetCriteria: this.result.unmetCriteria,
      });

      if (this.result.success) {
        // Checkpoint passed: clear result, continue script
        this._result = undefined;
        return null;
      } else {
        // Checkpoint failed: compile all results into the failing result.
        const cp = this.compiledCheckpoints;
        this.result.metCriteria = cp.metCriteria;
        this.result.unmetCriteria = cp.unmetCriteria;
        return this.result;
      }
    }

    // Final judge evaluation — merge prior checkpoint criteria
    if (this.result) {
      const cp = this.compiledCheckpoints;
      this.result.metCriteria = [...cp.metCriteria, ...this.result.metCriteria];
    }

    return this.result ?? null;
  }

  /**
   * Resets the scenario execution to its initial state.
   *
   * This method is called at the beginning of each execution to ensure a clean
   * state. It creates a new execution state, initializes agents, sets up the
   * first turn, and clears any pending messages or partial results.
   *
   * The reset process:
   * - Creates a new ScenarioExecutionState with the current config
   * - Sets up the thread ID (generates new one if not provided)
   * - Initializes all agents
   * - Initializes turn state (pending agents/roles) without creating a trace span
   * - Records the start time for performance tracking
   * - Clears any pending messages
   * - Clears the result from any previous execution
   */
  private reset(): void {
    this.logger.debug(`[${this.config.id}] Resetting scenario execution`);

    // End any existing turn span
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }

    this.state = new ScenarioExecutionState(this.config);
    // Re-establish the voice runtime's back-reference — the new state
    // object loses the linkage from the constructor's setExecutor call,
    // so adapters reaching `input.scenarioState._executor` would see
    // `null` for the rest of the run otherwise.
    this.state.setExecutor(this);
    this.state.threadId = this.config.threadId || generateThreadId();
    this.setAgents(this.config.agents);
    // Initialize turn state without creating a span yet. execute() calls
    // newTurn() immediately after reset() to create the Turn 1 span.
    this.pendingAgentsOnTurn = new Set(this.agents);
    this.pendingRolesOnTurn = [AgentRole.USER, AgentRole.AGENT, AgentRole.JUDGE];
    this.state.currentTurn = 0;
    this.totalStartTime = Date.now();
    this.pendingMessages.clear();
    this._result = undefined;
    this.checkpointResults = [];

    this.logger.debug(`[${this.config.id}] Reset complete`, {
      threadId: this.state.threadId,
      agentCount: this.agents.length,
    });
  }

  /** Compiles all accumulated checkpoint results into aggregated met/unmet criteria. */
  private get compiledCheckpoints(): { metCriteria: string[]; unmetCriteria: string[] } {
    const metCriteria: string[] = [];
    const unmetCriteria: string[] = [];
    for (const cp of this.checkpointResults) {
      metCriteria.push(...cp.metCriteria);
      unmetCriteria.push(...cp.unmetCriteria);
    }
    return { metCriteria, unmetCriteria };
  }

  private nextAgentForRole(role: AgentRole): {
    idx: number;
    agent: AgentAdapter | null;
  } {
    for (const agent of this.agents) {
      if (
        agent.role === role &&
        this.pendingAgentsOnTurn.has(agent) &&
        this.pendingRolesOnTurn.includes(role)
      ) {
        return { idx: this.agents.indexOf(agent), agent };
      }
    }

    return { idx: -1, agent: null };
  }

  /**
   * Starts a new turn in the scenario execution.
   *
   * This method is called when transitioning to a new turn. It resets the pending
   * agents and roles for the turn, allowing all agents to participate again in
   * the new turn. The turn counter is incremented to track the current turn number.
   *
   * A turn represents a cycle where agents can take actions. Each turn can involve
   * multiple agent interactions as agents respond to each other's messages.
   */
  private newTurn(): void {
    const previousTurn = this.state.currentTurn;

    // End previous turn span if it exists
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }

    this.pendingAgentsOnTurn = new Set(this.agents);
    this.pendingRolesOnTurn = [
      AgentRole.USER,
      AgentRole.AGENT,
      AgentRole.JUDGE,
    ];

    if (this.state.currentTurn === null) {
      this.state.currentTurn = 1;
    } else {
      this.state.currentTurn++;
    }

    this.logger.debug(`[${this.config.id}] New turn started`, {
      previousTurn,
      currentTurn: this.state.currentTurn,
      agentCount: this.agents.length,
    });

    // Create new turn trace context (equivalent to Python's langwatch.trace())
    this.currentTurnSpan = this.tracer.startSpan("Scenario Turn", {
      attributes: {
        "langwatch.origin": "simulation",
        // Identify which @langwatch/scenario build produced this run so a
        // trace can be triaged without asking the user to re-derive it (#733).
        [ATTR_SCENARIO_SDK_NAME]: SCENARIO_SDK_NAME,
        [ATTR_SCENARIO_SDK_VERSION]: SCENARIO_SDK_VERSION,
        "scenario.run_id": this.scenarioRunId ?? "",
        "scenario.name": this.config.name,
        "scenario.id": this.config.id,
        [attributes.ATTR_LANGWATCH_THREAD_ID]: this.state.threadId,
        "scenario.turn": this.state.currentTurn,
      },
    });
  }

  private removePendingRole(role: AgentRole): void {
    const index = this.pendingRolesOnTurn.indexOf(role);
    if (index > -1) {
      this.pendingRolesOnTurn.splice(index, 1);
    }
  }

  private removePendingAgent(agent: AgentAdapter): void {
    this.pendingAgentsOnTurn.delete(agent);
  }

  private getNextAgentForRole(
    role: AgentRole
  ): { index: number; agent: AgentAdapter } | null {
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      if (agent.role === role && this.pendingAgentsOnTurn.has(agent)) {
        return { index: i, agent };
      }
    }
    return null;
  }

  private setAgents(agents: AgentAdapter[]): void {
    this.agents = agents;
    this.agentTimes.clear();
  }

  private consumeUntilRole(role: AgentRole): void {
    while (this.pendingRolesOnTurn.length > 0) {
      const nextRole = this.pendingRolesOnTurn[0];
      if (nextRole === role) break;
      this.pendingRolesOnTurn.shift();
    }
  }

  /**
   * Creates a failure result when the maximum number of turns is reached.
   *
   * This method is called when the scenario execution reaches the maximum number
   * of turns without reaching a conclusion. It creates a failure result with
   * appropriate reasoning and includes performance metrics, then sets it on this.result.
   *
   * The result includes:
   * - All messages from the conversation
   * - Failure reasoning explaining the turn limit was reached
   * - Empty met criteria (since no conclusion was reached)
   * - All judge criteria as unmet (since no evaluation was completed)
   * - Total execution time and agent response times
   *
   * @param errorMessage - Optional custom error message to use instead of the default
   */
  private reachedMaxTurns(errorMessage?: string): ScenarioResult {
    return this.setResult({
      success: false,
      reasoning:
        errorMessage ||
        `Reached maximum turns (${
          this.config.maxTurns || 10
        }) without conclusion`,
      metCriteria: [],
      unmetCriteria: this.getJudgeAgent()?.criteria ?? [],
    });
  }


  private getJudgeAgent(): JudgeAgentAdapter | null {
    return (
      this.agents.find((agent) => agent instanceof JudgeAgentAdapter) ?? null
    );
  }

  /**
   * Emits an event to the event stream for external consumption.
   */
  private emitEvent(event: ScenarioEvent): void {
    this.eventSubject.next(event);
  }

  /**
   * Creates base event properties shared across all scenario events.
   */
  private makeBaseEvent({ scenarioRunId }: { scenarioRunId: string }) {
    return {
      type: "placeholder", // This will be replaced by the specific event type
      timestamp: Date.now(),
      batchRunId: this.batchRunId,
      scenarioId: this.config.id,
      scenarioRunId,
      scenarioSetId: this.config.setId ?? "default",
    };
  }

  /**
   * Emits a run started event to indicate scenario execution has begun.
   */
  private emitRunStarted({ scenarioRunId }: { scenarioRunId: string }) {
    this.emitEvent({
      ...this.makeBaseEvent({ scenarioRunId }),
      type: ScenarioEventType.RUN_STARTED,
      metadata: {
        ...this.config.metadata,
        name: this.config.name,
        description: this.config.description,
      },
    } as ScenarioRunStartedEvent);
  }

  /**
   * Emits a message snapshot event containing current conversation history.
   */
  private emitMessageSnapshot({ scenarioRunId }: { scenarioRunId: string }) {
    this.emitEvent({
      ...this.makeBaseEvent({ scenarioRunId }),
      type: ScenarioEventType.MESSAGE_SNAPSHOT,
      messages: convertModelMessagesToAguiMessages(this.state.messages),
      // Add any other required fields from MessagesSnapshotEventSchema
    } as ScenarioMessageSnapshotEvent);
  }

  /**
   * Emits a run finished event with the final execution status.
   */
  private emitRunFinished({
    scenarioRunId,
    status,
    result,
  }: {
    scenarioRunId: string;
    status: ScenarioRunStatus;
    result?: ScenarioResult;
  }) {
    const event: ScenarioRunFinishedEvent = {
      ...this.makeBaseEvent({ scenarioRunId }),
      type: ScenarioEventType.RUN_FINISHED,
      status: status,
      results: {
        verdict: result?.success ? Verdict.SUCCESS : Verdict.FAILURE,
        metCriteria: result?.metCriteria ?? [],
        unmetCriteria: result?.unmetCriteria ?? [],
        reasoning: result?.reasoning,
        error: result?.error,
      },
    };

    this.emitEvent(event);
    this.eventSubject.complete();

    // End the final turn span
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }
  }

  /**
   * Distributes a message to all other agents in the scenario.
   *
   * This method implements the message broadcasting system that allows agents to
   * "hear" messages from other agents. When an agent sends a message, it needs to
   * be distributed to all other agents so they can respond appropriately.
   *
   * The broadcasting process:
   * 1. Iterates through all agents in the scenario
   * 2. Skips the agent that sent the message (to avoid echo)
   * 3. Adds the message to each agent's pending message queue
   * 4. Agents will receive these messages when they're called next
   *
   * This creates a realistic conversation environment where agents can see
   * the full conversation history and respond contextually.
   *
   * @param message - The message to broadcast to all other agents
   * @param fromAgentIdx - The index of the agent that sent the message (to avoid echoing back to sender)
   *
   * @example
   * ```typescript
   * // When agent 0 sends a message, it gets broadcast to agents 1 and 2
   * execution.broadcastMessage(
   *   { role: "user", content: "Hello" },
   *   0 // fromAgentIdx
   * );
   * // Now agents 1 and 2 have this message in their pendingMessages queue
   * ```
   */
  private broadcastMessage(message: ModelMessage, fromAgentIdx?: number): void {
    const recipients: number[] = [];

    for (let idx = 0; idx < this.agents.length; idx++) {
      if (idx === fromAgentIdx) continue;

      let bucket = this.pendingMessages.get(idx);
      if (!bucket) {
        bucket = [];
        this.pendingMessages.set(idx, bucket);
      }
      bucket.push(message);
      recipients.push(idx);
    }

    this.logger.debug(`[${this.config.id}] Broadcast message`, {
      role: message.role,
      fromAgentIdx,
      recipients,
    });
  }

  /**
   * Executes a single script step with proper error handling and logging.
   *
   * This method is responsible for executing each script step function with
   * comprehensive error handling and logging. It provides the execution context
   * to the script step and handles any errors that occur during execution.
   *
   * The method:
   * - Logs the start of script step execution
   * - Calls the script step function with the current state and execution context
   * - Logs the completion of the script step
   * - Handles and logs any errors that occur
   * - Re-throws errors to maintain the original error context
   *
   * @param scriptStep - The script step function to execute (user, agent, judge, etc.)
   * @param stepIndex - The index of the script step for logging and debugging context
   * @returns The result of the script step execution (void, ScenarioResult, or null)
   * @throws Error if the script step throws an error (preserves original error)
   */
  private async executeScriptStep(
    scriptStep: ScriptStep,
    stepIndex: number
  ): Promise<void | ScenarioResult | null> {
    const functionString = scriptStep.toString();

    try {
      this.logger.debug(
        `[${this.config.id}] Executing script step ${stepIndex + 1}`,
        {
          stepIndex,
          function: functionString,
        }
      );

      const result = await scriptStep(this.state, this);

      this.logger.debug(
        `[${this.config.id}] Script step ${stepIndex + 1} completed`,
        {
          stepIndex,
          hasResult: result !== null && result !== undefined,
          resultType: typeof result,
        }
      );

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `[${this.config.id}] Script step ${stepIndex + 1} failed`,
        {
          stepIndex,
          error: errorMessage,
          function: functionString,
        }
      );

      // Re-throw the error in case it was a vitest assertion error
      throw error;
    }
  }
}

/**
 * Converts agent return types to ModelMessage format.
 *
 * This utility function handles the various return types that agents can return
 * and converts them to a standardized ModelMessage format. Agents can return:
 * - A string (converted to a message with the specified role)
 * - An array of ModelMessage objects (returned as-is)
 * - A single ModelMessage object (wrapped in an array)
 * - Any other type (returns empty array)
 *
 * @param response - The response from an agent (string, ModelMessage, or array of ModelMessage)
 * @param role - The role to assign if the response is a string ("user" or "assistant")
 * @returns An array of ModelMessage objects
 */
function convertAgentReturnTypesToMessages(
  response: AgentReturnTypes,
  role: "user" | "assistant"
): ModelMessage[] {
  if (typeof response === "string")
    return [{ role, content: response } as ModelMessage];

  if (Array.isArray(response)) return response;

  if (response && typeof response === "object" && "role" in response)
    return [response];

  return [];
}

/**
 * Extracts structured error information for logging and reporting.
 *
 * This function takes any thrown error (unknown type) and returns an object
 * containing the error's name, message, and stack trace if available.
 * If the input is not an instance of Error, it provides a generic name and
 * stringified value for message.
 *
 * @param error - The error object or value to extract information from.
 * @returns An object with 'name', optional 'message', and optional 'stack' properties.
 */
function extractErrorInfo(error: unknown): {
  name: string;
  message?: string;
  stack?: string;
} {
  // Extracts error information in a structured way for logging and reporting.
  // Returns an object with name, message, and stack if available.
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  // If not an Error instance, provide a generic name and stringified value.
  return {
    name: typeof error,
    message: String(error),
  };
}
