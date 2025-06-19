import { CoreMessage, CoreToolMessage } from "ai";
import { ScenarioResult, AgentRole, AgentAdapter, ScenarioExecutionStateLike } from "../domain";
import { generateMessageId } from "../utils/ids";

export class ScenarioExecutionState implements ScenarioExecutionStateLike {
  private _history: (CoreMessage & { id: string })[] = [];
  private _turn: number = 0;
  private _partialResult: Omit<ScenarioResult, "messages"> | null = null;
  private _threadId: string = "";
  private _agents: AgentAdapter[] = [];
  private _pendingMessages: Map<number, CoreMessage[]> = new Map();
  private _pendingRolesOnTurn: AgentRole[] = [];
  private _pendingAgentsOnTurn: Set<AgentAdapter> = new Set();
  private _agentTimes: Map<number, number> = new Map();
  private _totalStartTime: number = 0;

  constructor() {
    this._totalStartTime = Date.now();
  }

  setThreadId(threadId: string): void {
    this._threadId = threadId;
  }

  setAgents(agents: AgentAdapter[]): void {
    this._agents = agents;
    this._pendingMessages.clear();
    this._agentTimes.clear();
  }

  appendMessage(role: CoreMessage["role"], content: string): void {
    const message: CoreMessage = { role, content } as CoreMessage;
    this._history.push({ ...message, id: generateMessageId() });
  }

  appendUserMessage(content: string): void {
    this.appendMessage("user", content);
  }

  appendAssistantMessage(content: string): void {
    this.appendMessage("assistant", content);
  }

  addMessage(message: CoreMessage, fromAgentIdx?: number): void {
    this._history.push({ ...message, id: generateMessageId() });

    for (let idx = 0; idx < this._agents.length; idx++) {
      if (idx === fromAgentIdx) continue;

      if (!this._pendingMessages.has(idx)) {
        this._pendingMessages.set(idx, []);
      }
      this._pendingMessages.get(idx)!.push(message);
    }
  }

  addMessages(messages: CoreMessage[], fromAgentIdx?: number): void {
    for (const message of messages) {
      this.addMessage(message, fromAgentIdx);
    }
  }

  getPendingMessages(agentIdx: number): CoreMessage[] {
    return this._pendingMessages.get(agentIdx) || [];
  }

  clearPendingMessages(agentIdx: number): void {
    this._pendingMessages.set(agentIdx, []);
  }

  newTurn(): void {
    this._pendingAgentsOnTurn = new Set(this._agents);
    this._pendingRolesOnTurn = [
      AgentRole.USER,
      AgentRole.AGENT,
      AgentRole.JUDGE,
    ];

    if (this._turn === null) {
      this._turn = 1;
    } else {
      this._turn++;
    }
  }

  removePendingRole(role: AgentRole): void {
    const index = this._pendingRolesOnTurn.indexOf(role);
    if (index > -1) {
      this._pendingRolesOnTurn.splice(index, 1);
    }
  }

  removePendingAgent(agent: AgentAdapter): void {
    this._pendingAgentsOnTurn.delete(agent);
  }

  getNextAgentForRole(role: AgentRole): { index: number; agent: AgentAdapter } | null {
    for (let i = 0; i < this._agents.length; i++) {
      const agent = this._agents[i];
      if (agent.role === role && this._pendingAgentsOnTurn.has(agent)) {
        return { index: i, agent };
      }
    }
    return null;
  }

  addAgentTime(agentIdx: number, time: number): void {
    const currentTime = this._agentTimes.get(agentIdx) || 0;

    this._agentTimes.set(agentIdx, currentTime + time);
  }

  hasResult(): boolean {
    return this._partialResult !== null;
  }

  setResult(result: Omit<ScenarioResult, "messages">): void {
    this._partialResult = result;
  }

  get lastMessage(): CoreMessage | undefined {
    return this._history[this._history.length - 1];
  }

  get lastUserMessage(): CoreMessage | undefined {
    return this._history.findLast(message => message.role === "user");
  }

  get lastAssistantMessage(): CoreMessage | undefined {
    return this._history.findLast(message => message.role === "assistant");
  }

  get lastToolCall(): CoreToolMessage | undefined {
    return this._history.findLast(message => message.role === "tool");
  }

  getLastToolCallByToolName(toolName: string): CoreToolMessage | undefined {
    const toolMessage = this._history.findLast(message =>
      message.role === "tool" && message.content.find(
        part => part.type === "tool-result" && part.toolName === toolName
      ),
    );

    return toolMessage as CoreToolMessage | undefined;
  }

  hasToolCall(toolName: string): boolean {
    return this._history.some(message =>
      message.role === "tool" && message.content.find(
        part => part.type === "tool-result" && part.toolName === toolName
      ),
    );
  }

  get history(): CoreMessage[] {
    return this._history;
  }

  get historyWithoutLastMessage(): CoreMessage[] {
    return this._history.slice(0, -1);
  }

  get historyWithoutLastUserMessage(): CoreMessage[] {
    const lastUserMessageIndex = this._history.findLastIndex(message => message.role === "user");

    if (lastUserMessageIndex === -1) return this._history;

    return this._history.slice(0, lastUserMessageIndex);
  }

  get turn(): number | null {
    return this._turn;
  }

  set turn(turn: number) {
    this._turn = turn;
  }

  get threadId(): string {
    return this._threadId;
  }

  get agents(): AgentAdapter[] {
    return this._agents;
  }

  get pendingRolesOnTurn(): AgentRole[] {
    return this._pendingRolesOnTurn;
  }

  set pendingRolesOnTurn(roles: AgentRole[]) {
    this._pendingRolesOnTurn = roles;
  }

  get pendingAgentsOnTurn(): AgentAdapter[] {
    return Array.from(this._pendingAgentsOnTurn);
  }

  set pendingAgentsOnTurn(agents: AgentAdapter[]) {
    this._pendingAgentsOnTurn = new Set(agents);
  }

  get partialResult(): Omit<ScenarioResult, "messages"> | null {
    return this._partialResult;
  }

  get totalTime(): number {
    return Date.now() - this._totalStartTime;
  }

  get agentTimes(): Map<number, number> {
    return new Map(this._agentTimes);
  }

  removeLastPendingRole(): void {
    this._pendingRolesOnTurn.pop();
  }
}
