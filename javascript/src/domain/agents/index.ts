import { CoreMessage } from "ai";
import { ScenarioExecutionStateLike, ScenarioResult } from "../core/execution";
import { ScenarioConfig } from "../scenarios";

export enum AgentRole {
  USER = "User",
  AGENT = "Agent",
  JUDGE = "Judge",
}

export const allAgentRoles = [AgentRole.USER, AgentRole.AGENT, AgentRole.JUDGE] as const;

export interface AgentInput {
  threadId: string;
  messages: CoreMessage[];
  newMessages: CoreMessage[];
  requestedRole: AgentRole;
  judgmentRequest: boolean;
  scenarioState: ScenarioExecutionStateLike;
  scenarioConfig: ScenarioConfig;
}

export type AgentReturnTypes = string | CoreMessage | CoreMessage[] | ScenarioResult;

export abstract class AgentAdapter {
  role: AgentRole = AgentRole.AGENT;

  constructor(input: AgentInput) {
    void input;
  }

  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}

export abstract class UserSimulatorAgentAdapter implements AgentAdapter {
  role: AgentRole = AgentRole.USER;

  constructor(input: AgentInput) {
    void input;
  }

  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}

export abstract class JudgeAgentAdapter implements AgentAdapter {
  role: AgentRole = AgentRole.JUDGE;
  abstract criteria: string[];

  constructor(input: AgentInput) {
    void input;
  }

  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}
