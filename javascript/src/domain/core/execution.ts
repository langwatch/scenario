import { CoreMessage, CoreToolMessage } from "ai";
import { AgentAdapter, AgentRole } from "..";

export interface ScenarioResult {
  success: boolean;
  messages: CoreMessage[];
  reasoning?: string;
  passedCriteria: string[];
  failedCriteria: string[];
  totalTime?: number;
  agentTime?: number;
}

export interface ScenarioExecutionStateLike {
  history: CoreMessage[];
  historyWithoutLastMessage: CoreMessage[];
  historyWithoutLastUserMessage: CoreMessage[];
  threadId: string;
  turn: number | null;
  agents: AgentAdapter[];
  pendingRolesOnTurn: AgentRole[];
  pendingAgentsOnTurn: AgentAdapter[];
  partialResult: Omit<ScenarioResult, "messages"> | null;
  totalTime: number;
  agentTimes: Map<number, number>;

  addMessage(message: CoreMessage, fromAgentIdx?: number): void;
  addMessages(messages: CoreMessage[], fromAgentIdx?: number): void;
  setThreadId(threadId: string): void;
  setAgents(agents: AgentAdapter[]): void;
  appendMessage(role: CoreMessage["role"], content: string): void;
  appendUserMessage(content: string): void;
  appendAssistantMessage(content: string): void;
  getPendingMessages(agentIdx: number): CoreMessage[];
  clearPendingMessages(agentIdx: number): void;
  newTurn(): void;
  removePendingRole(role: AgentRole): void;
  removeLastPendingRole(): void;
  removePendingAgent(agent: AgentAdapter): void;
  getNextAgentForRole(role: AgentRole): { index: number; agent: AgentAdapter } | null;
  addAgentTime(agentIdx: number, time: number): void;
  hasResult(): boolean;
  setResult(result: Omit<ScenarioResult, "messages">): void;
  readonly lastMessage: CoreMessage | undefined;
  readonly lastUserMessage: CoreMessage | undefined;
  readonly lastAssistantMessage: CoreMessage | undefined;
  readonly lastToolCall: CoreToolMessage | undefined;
  getLastToolCallByToolName(toolName: string): CoreToolMessage | undefined;
  hasToolCall(toolName: string): boolean;
}
