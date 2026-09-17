import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import { Observable, Subject } from "rxjs";
import {
  JudgeAgentAdapter,
  type ScenarioConfig,
  type ScenarioExecutionStateLike,
  type ScenarioFieldValue,
} from "../domain";
import {
  messageText,
  runContexts,
  runToolCalls,
  runTraces,
  runTurns,
  sortSpans,
  transcript,
  type StateReadReporter,
  type StateReads,
  type StateViewSource,
  type ToolCalls,
  type TraceView,
  type TurnView,
} from "./state-views";
import { generateMessageId } from "../utils/ids";

// Generic enum - ready for extension
export enum StateChangeEventType {
  MESSAGE_ADDED = "MESSAGE_ADDED",
  // Future: TURN_CHANGED, THREAD_ID_CHANGED, etc.
}

// Generic discriminated union - extensible structure
export type StateChangeEvent = {
  type: StateChangeEventType.MESSAGE_ADDED;
};
// Future event types go here

/**
 * Manages the state of a scenario execution.
 * This class implements the ScenarioExecutionStateLike interface and provides
 * the internal logic for tracking conversation history, turns, results, and
 * other related information.
 */
export class ScenarioExecutionState implements ScenarioExecutionStateLike {
  private _messages: (ModelMessage & { id: string; traceId?: string; turn?: number })[] = [];
  private _currentTurn: number = 0;
  private _threadId: string = "";
  private _onRollback?: (removedSet: Set<object>) => void;
  private _spanProvider: () => ReadableSpan[] = () => [];
  private _reads: StateReads | null = null;

  /**
   * Back-reference to the {@link ScenarioExecution} that owns this state.
   *
   * The voice adapter runtime (see `voice/adapter.runtime.ts`) reads this
   * to reach the executor's {@link
   * import("../voice/voice-executor-state").VoiceExecutorState} surface
   * (`voiceRecording`, `voiceTimeline`, `voiceLatency`, etc.). Mirrors
   * Python `ScenarioState._executor`.
   *
   * Underscored to keep callers out of the internal coupling — only the
   * voice subsystem reaches in. Set once by the constructor of
   * {@link ScenarioExecution} via {@link setExecutor}.
   */
  _executor: object | null = null;

  /** Set the back-reference; called once by the executor's constructor. */
  setExecutor(executor: object): void {
    this._executor = executor;
  }

  /**
   * Sets where `spans` reads from: the executor points it at the judge span
   * collector for this thread. Reading never fetches remote traces.
   */
  setSpanProvider(provider: () => ReadableSpan[]): void {
    this._spanProvider = provider;
  }

  /**
   * Starts recording what the next reads touch, so the evaluator runner
   * knows whether a mapping read the trace and what it found missing.
   */
  startReadTracking(): void {
    this._reads = { trace: false, blankFields: [], missingToolCalls: [], emptyContexts: false };
  }

  /** Stops recording and returns what was read since tracking started. */
  takeReads(): StateReads {
    const reads = this._reads ?? {
      trace: false,
      blankFields: [],
      missingToolCalls: [],
      emptyContexts: false,
    };
    this._reads = null;
    return reads;
  }

  private readonly reporter: StateReadReporter = {
    noteTrace: () => {
      if (this._reads) this._reads.trace = true;
    },
    noteMissingToolCall: (name) => {
      if (this._reads && !this._reads.missingToolCalls.includes(name)) {
        this._reads.missingToolCalls.push(name);
      }
    },
    noteEmptyContexts: () => {
      if (this._reads) this._reads.emptyContexts = true;
    },
  };

  private get viewSource(): StateViewSource {
    return {
      messages: this._messages,
      spans: this._spanProvider(),
      reporter: this.reporter,
    };
  }

  /** Event stream for message additions */
  private eventSubject = new Subject<StateChangeEvent>();
  public readonly events$: Observable<StateChangeEvent> =
    this.eventSubject.asObservable();

  description: string;
  config: ScenarioConfig;

  constructor(config: ScenarioConfig) {
    this.config = config;
    this.description = config.description;
  }

  get messages(): ModelMessage[] {
    return this._messages;
  }

  get currentTurn(): number {
    return this._currentTurn;
  }

  set currentTurn(turn: number) {
    this._currentTurn = turn;
  }

  get threadId(): string {
    return this._threadId;
  }

  set threadId(value: string) {
    this._threadId = value;
  }

  /**
   * Adds a message to the conversation history.
   *
   * @param message - The message to add.
   * @param traceId - Optional trace ID to associate with the message.
   */
  addMessage(message: ModelMessage & { traceId?: string }): void {
    const messageWithId = {
      ...message,
      id: generateMessageId(),
      turn: this._currentTurn,
    };
    this._messages.push(messageWithId);
    // Emit event when message is added
    this.eventSubject.next({ type: StateChangeEventType.MESSAGE_ADDED });
  }

  lastMessage() {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    return this._messages[this._messages.length - 1];
  }

  lastUserMessage() {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    const lastMessage = this._messages.findLast(
      (message) => message.role === "user"
    );

    if (!lastMessage) {
      throw new Error("No user message in history");
    }

    return lastMessage;
  }

  lastAgentMessage(): AssistantModelMessage & { traceId?: string } {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    const lastMessage = this._messages.findLast(
      (message) => message.role === "assistant"
    );

    if (!lastMessage) {
      throw new Error("No agent message in history");
    }

    return lastMessage;
  }

  lastToolCall(toolName: string): ToolModelMessage & { traceId?: string } {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    const lastMessage = this._messages.findLast(
      (message) =>
        message.role === "tool" &&
        message.content.find(
          (part) => part.type === "tool-result" && part.toolName === toolName
        )
    );

    return lastMessage as ToolModelMessage;
  }

  hasToolCall(toolName: string): boolean {
    return this._messages.some(
      (message) =>
        message.role === "tool" &&
        message.content.find(
          (part) => part.type === "tool-result" && part.toolName === toolName
        )
    );
  }

  get fields(): Record<string, ScenarioFieldValue> {
    return this.config.fields ?? {};
  }

  field(name: string): ScenarioFieldValue | undefined {
    const value = this.fields[name];
    if (value === undefined || value === null || value === "") {
      if (this._reads && !this._reads.blankFields.includes(name)) {
        this._reads.blankFields.push(name);
      }
      return undefined;
    }
    return value;
  }

  get criteria(): string[] {
    return this.config.agents.flatMap((agent) =>
      agent instanceof JudgeAgentAdapter ? agent.criteria ?? [] : []
    );
  }

  firstUserMessage(): string {
    const message = this._messages.find((m) => m.role === "user");
    return message ? messageText(message) : "";
  }

  transcript(): string {
    return transcript(this._messages);
  }

  toolCalls(name?: string): ToolCalls {
    return runToolCalls(this.viewSource, name);
  }

  get contexts(): string[] {
    return runContexts(this.viewSource);
  }

  get spans(): ReadableSpan[] {
    this.reporter.noteTrace();
    return sortSpans(this._spanProvider());
  }

  get traces(): TraceView[] {
    return runTraces(this.viewSource);
  }

  get turns(): TurnView[] {
    return runTurns(this.viewSource);
  }

  /**
   * Register a callback that fires when messages are rolled back.
   * The executor uses this to clean up its pending message queues.
   */
  setOnRollback(handler: (removedSet: Set<object>) => void): void {
    this._onRollback = handler;
  }

  /**
   * Remove all messages from position `index` onward.
   *
   * Truncates the internal message list and notifies the executor
   * (via the registered rollback handler) to clean pending queues.
   *
   * **Note:** This method is safe to call only during an agent's `call()`
   * invocation.  The executor runs agents sequentially, so no other agent
   * can observe stale `newMessages` references.  Calling this from outside
   * that flow may leave already-delivered `newMessages` out of sync.
   *
   * @param index - Truncate point (clamped to `[0, messages.length]`).
   *   Messages at positions >= index are removed.
   * @returns The removed messages (empty array if nothing to remove).
   * @throws {RangeError} If `index` is negative.
   */
  rollbackMessagesTo(index: number): ModelMessage[] {
    if (index < 0) {
      throw new RangeError(
        `rollbackMessagesTo: index must be >= 0, got ${index}`
      );
    }
    // Clamp to message length — rolling back past the end is a no-op.
    const clamped = Math.min(index, this._messages.length);

    const removed = this._messages.splice(clamped);
    if (this._onRollback && removed.length > 0) {
      this._onRollback(new Set<object>(removed));
    }
    return removed;
  }
}
