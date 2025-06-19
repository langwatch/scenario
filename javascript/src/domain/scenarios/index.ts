import { CoreMessage } from "ai";
import { AgentAdapter } from "../agents/index";
import { ScenarioExecutionStateLike, ScenarioResult } from "../core/execution";

export interface ScenarioConfig {
  id?: string;
  name: string;
  description: string;

  agents: AgentAdapter[];
  script?: ScriptStep[];

  verbose?: boolean | number;
  maxTurns?: number;

  threadId?: string;
}

export interface ScenarioExecutionLike {
  readonly history: CoreMessage[];
  readonly threadId: string;

  message(message: CoreMessage): Promise<void>;
  user(content?: string | CoreMessage): Promise<void>;
  agent(content?: string | CoreMessage): Promise<void>;
  judge(content?: string | CoreMessage): Promise<ScenarioResult | null>;
  proceed(
    turns?: number,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
  ): Promise<ScenarioResult | null>;
  succeed(reasoning?: string): Promise<ScenarioResult>;
  fail(reasoning?: string): Promise<ScenarioResult>;
}

export type ScriptStep = (
  state: ScenarioExecutionStateLike,
  executor: ScenarioExecutionLike,
) => Promise<void | ScenarioResult | null> | void | ScenarioResult | null;
