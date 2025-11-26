import { CoreAssistantMessage, CoreMessage, CoreToolMessage } from "ai";
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
  private _messages: (CoreMessage & { id: string; traceId?: string })[] = [];
  private _currentTurn: number = 0;
  private _threadId: string = "";

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

  get messages(): CoreMessage[] {
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
  addMessage(message: CoreMessage & { traceId?: string }): void {
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

  lastAgentMessage(): CoreAssistantMessage & { traceId?: string } {
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

  lastToolCall(toolName: string): CoreToolMessage & { traceId?: string } {
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

    return lastMessage as CoreToolMessage;
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
}
