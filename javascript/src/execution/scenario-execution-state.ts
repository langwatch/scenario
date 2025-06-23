import { CoreMessage, CoreToolMessage } from "ai";
import { ScenarioExecutionStateLike, ScenarioConfig } from "../domain";
import { generateMessageId } from "../utils/ids";

/**
 * Manages the state of a scenario execution.
 * This class implements the ScenarioExecutionStateLike interface and provides
 * the internal logic for tracking conversation history, turns, results, and
 * other related information.
 */
export class ScenarioExecutionState implements ScenarioExecutionStateLike {
  private _messages: (CoreMessage & { id: string })[] = [];
  private _currentTurn: number = 0;
  private _threadId: string = "";
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
   */
  addMessage(message: CoreMessage): void {
    this._messages.push({ ...message, id: generateMessageId() });
  }

  lastMessage(): CoreMessage {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    return this._messages[this._messages.length - 1]
  }

  lastUserMessage(): CoreMessage {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    const lastMessage = this._messages.findLast(message => message.role === "user");

    if (!lastMessage) {
      throw new Error("No user message in history");
    }

    return lastMessage;
  }

  lastToolCall(toolName: string): CoreToolMessage {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    const lastMessage = this._messages.findLast(message => message.role === "tool" && message.content.find(
      part => part.type === "tool-result" && part.toolName === toolName
    ));

    if (!lastMessage) {
      throw new Error("No tool call message in history");
    }

    return lastMessage as CoreToolMessage;
  }

  hasToolCall(toolName: string): boolean {
    return this._messages.some(message =>
      message.role === "tool" && message.content.find(
        part => part.type === "tool-result" && part.toolName === toolName
      ),
    );
  }
}
