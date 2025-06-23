import { CoreMessage, CoreToolMessage } from "ai";
import { ScenarioExecutionStateLike } from "../domain";
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
  private _pendingMessages: Map<number, CoreMessage[]> = new Map();

  get messages(): CoreMessage[] {
    return this._messages;
  }

  get history(): CoreMessage[] {
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

  addMessage(message: CoreMessage, agentCount?: number, fromAgentIdx?: number): void {
    this._messages.push({ ...message, id: generateMessageId() });

    if (agentCount === void 0) return;

    for (let idx = 0; idx < agentCount; idx++) {
      if (idx === fromAgentIdx) continue;

      if (!this._pendingMessages.has(idx)) {
        this._pendingMessages.set(idx, []);
      }
      this._pendingMessages.get(idx)!.push(message);
    }
  }

  appendMessage(role: CoreMessage["role"], content: string): void {
    const message: CoreMessage = { role, content } as CoreMessage;
    this._messages.push({ ...message, id: generateMessageId() });
  }

  appendUserMessage(content: string): void {
    this.appendMessage("user", content);
  }

  appendAssistantMessage(content: string): void {
    this.appendMessage("assistant", content);
  }

  getPendingMessages(agentIdx: number): CoreMessage[] {
    return this._pendingMessages.get(agentIdx) || [];
  }

  clearPendingMessages(agentIdx: number): void {
    this._pendingMessages.set(agentIdx, []);
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

  lastAssistantMessage(): CoreMessage {
    if (this._messages.length === 0) {
      throw new Error("No messages in history");
    }

    const lastMessage = this._messages.findLast(message => message.role === "assistant");

    if (!lastMessage) {
      throw new Error("No assistant message in history");
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
