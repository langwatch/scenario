import { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import { Observable, Subject } from "rxjs";
import { ScenarioExecutionStateLike, ScenarioConfig } from "../domain";
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
  private _messages: (ModelMessage & { id: string; traceId?: string })[] = [];
  private _currentTurn: number = 0;
  private _threadId: string = "";
  private _onRollback?: (removedSet: Set<object>) => void;

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
