import { CoreMessage } from "ai";
import { ScenarioExecutionState } from "./scenario-execution-state";
import {
  type ScenarioResult,
  type ScenarioConfig,
  AgentRole,
  type AgentInput,
  type ScriptStep,
  type AgentReturnTypes,
  type ScenarioExecutionLike,
  type AgentAdapter,
  JudgeAgentAdapter,
  ScenarioExecutionStateLike
} from "../domain";
import { generateThreadId } from "../utils/ids";

function convertAgentReturnTypesToMessages(response: AgentReturnTypes, role: "user" | "assistant"): CoreMessage[] {
  if (typeof response === "string")
    return [{ role, content: response } as CoreMessage];

  if (Array.isArray(response))
    return response;

  if (typeof response === "object" && "role" in response)
    return [response];

  return [];
}

export class ScenarioExecution implements ScenarioExecutionLike {
  private state: ScenarioExecutionStateLike = new ScenarioExecutionState();

  constructor(
    public readonly config: ScenarioConfig,
    public readonly steps: ScriptStep[],
  ) {
    this.reset();
  }

  get history(): CoreMessage[] {
    return this.state.history;
  }

  get threadId(): string {
    return this.state.threadId;
  }

  private reset(): void {
    this.state = new ScenarioExecutionState();
    this.state.setThreadId(this.config.threadId || generateThreadId());
    this.state.setAgents(this.config.agents);
    this.state.newTurn();
    this.state.turn = 0;
  }

  async execute(): Promise<ScenarioResult> {
    this.reset();

    // Execute script steps - pass the execution context (this), not just state
    for (const scriptStep of this.steps) {
      const result = await scriptStep(this.state, this);
      if (result && typeof result === "object" && "success" in result) {
        return result as ScenarioResult;
      }
    }

    // If no conclusion reached, return max turns error
    return this.reachedMaxTurns([
      "Reached end of script without conclusion, add one of the following to the end of the script:",
      "- `Scenario.proceed()` to let the simulation continue to play out",
      "- `Scenario.judge()` to force criteria judgement",
      "- `Scenario.succeed()` or `Scenario.fail()` to end the test with an explicit result",
    ].join("\n"));
  }

  async step(): Promise<CoreMessage[] | ScenarioResult> {
    const result = await this._step();
    if (result === null) throw new Error("No result from step");

    return result;
  }

  private async _step(
    goToNextTurn: boolean = true,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
  ): Promise<CoreMessage[] | ScenarioResult | null> {
    if (this.state.pendingRolesOnTurn.length === 0) {
      if (!goToNextTurn) return null;

      this.state.newTurn();

      if (onTurn) await onTurn(this.state);

      if (this.state.turn != null && this.state.turn >= (this.config.maxTurns || 10))
        return this.reachedMaxTurns();
    }

    const currentRole = this.state.pendingRolesOnTurn[0];
    const { idx, agent: nextAgent } = this.nextAgentForRole(currentRole);
    if (!nextAgent) {
      this.state.removePendingRole(currentRole);
      return this._step(goToNextTurn, onTurn);
    }

    this.state.removePendingAgent(nextAgent);

    return await this.callAgent(idx, currentRole);
  }

  private async callAgent(
    idx: number,
    role: AgentRole,
    judgmentRequest: boolean = false,
  ): Promise<CoreMessage[] | ScenarioResult> {
    const agent = this.state.agents[idx];
    const startTime = Date.now();

    const agentInput: AgentInput = {
      threadId: this.state.threadId,
      messages: this.state.history,
      newMessages: this.state.getPendingMessages(idx),
      requestedRole: role,
      judgmentRequest: judgmentRequest,
      scenarioState: this.state,
      scenarioConfig: this.config,
    };

    const agentResponse = await agent.call(agentInput);
    const endTime = Date.now();

    this.state.addAgentTime(idx, endTime - startTime);
    this.state.clearPendingMessages(idx);

    if (typeof agentResponse === "object" && agentResponse && "success" in agentResponse) {
      return agentResponse as ScenarioResult;
    }

    const messages = convertAgentReturnTypesToMessages(
      agentResponse,
      role === AgentRole.USER ? "user" : "assistant"
    );

    this.state.addMessages(messages, idx);

    return messages;
  }

  private nextAgentForRole(role: AgentRole): { idx: number; agent: AgentAdapter | null } {
    for (const agent of this.state.agents) {
      if (agent.role === role && this.state.pendingAgentsOnTurn.includes(agent) && this.state.pendingRolesOnTurn.includes(role)) {
        return { idx: this.state.agents.indexOf(agent), agent };
      }
    }
    return { idx: -1, agent: null };
  }

  private reachedMaxTurns(errorMessage?: string): ScenarioResult {
    const agentRoleAgentsIdx = this.state.agents
      .map((agent, i) => ({ agent, idx: i }))
      .filter(({ agent }) => agent.role === AgentRole.AGENT)
      .map(({ idx }) => idx);

    const agentTimes = agentRoleAgentsIdx
      .map(i => this.state.agentTimes.get(i) || 0);

    const totalAgentTime = agentTimes.reduce((sum, time) => sum + time, 0);

    return {
      success: false,
      messages: this.state.history,
      reasoning: errorMessage || `Reached maximum turns (${this.config.maxTurns || 10}) without conclusion`,
      passedCriteria: [],
      failedCriteria: this.getJudgeAgent()?.criteria ?? [],
      totalTime: this.state.totalTime,
      agentTime: totalAgentTime,
    };
  }

  private getJudgeAgent(): JudgeAgentAdapter | null {
    return this.state.agents.find(agent => agent instanceof JudgeAgentAdapter) ?? null;
  }

  private consumeUntilRole(role: AgentRole): void {
    while (this.state.pendingRolesOnTurn.length > 0) {
      const nextRole = this.state.pendingRolesOnTurn[0];
      if (nextRole === role) break;
      this.state.pendingRolesOnTurn.pop();
    }
  }

  private async scriptCallAgent(
    role: AgentRole,
    content?: string | CoreMessage,
    judgmentRequest: boolean = false,
  ): Promise<ScenarioResult | null> {
    this.consumeUntilRole(role);

    let index = -1;
    let agent: AgentAdapter | null = null;

    const nextAgent = this.state.getNextAgentForRole(role);
    if (!nextAgent) {
      this.state.newTurn();
      this.consumeUntilRole(role);

      const nextAgent = this.state.getNextAgentForRole(role);
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

      index = nextAgent.index;
      agent = nextAgent.agent;
    } else {
      index = nextAgent.index;
      agent = nextAgent.agent;
    }

    this.state.removePendingAgent(agent);

    if (content) {
      if (typeof content === "string") {
        if (role === AgentRole.USER) {
          this.state.addMessage({ role: "user", content } as CoreMessage);
        } else {
          this.state.addMessage({ role: "assistant", content } as CoreMessage);
        }
      } else {
        this.state.addMessage(content);
      }

      return null;
    }

    const result = await this.callAgent(index, role, judgmentRequest);
    if (Array.isArray(result))
      return null;

    return result;
  }

  async message(message: CoreMessage): Promise<void> {
    if (message.role === "user") {
      await this.scriptCallAgent(AgentRole.USER, message);
    } else if (message.role === "assistant") {
      await this.scriptCallAgent(AgentRole.AGENT, message);
    } else {
      this.state.addMessage(message);
    }
  }

  async user(content?: string | CoreMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.USER, content);
  }

  async agent(content?: string | CoreMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.AGENT, content);
  }

  async judge(content?: string | CoreMessage): Promise<ScenarioResult | null> {
    return await this.scriptCallAgent(AgentRole.JUDGE, content, true);
  }

  async proceed(
    turns?: number,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
  ): Promise<ScenarioResult | null> {
    let initialTurn = this.state.turn;

    while (true) {
      const goToNextTurn = turns === void 0 || initialTurn === null || this.state.turn != null && this.state.turn + 1 < initialTurn + turns;
      const nextMessage = await this._step(goToNextTurn, onTurn);

      if (initialTurn === null)
        initialTurn = this.state.turn;

      if (nextMessage === null) {
        return null;
      }

      if (onStep) await onStep(this.state);

      if (nextMessage !== null && typeof nextMessage === "object" && "success" in nextMessage)
        return nextMessage;
    }
  }

  async succeed(reasoning?: string): Promise<ScenarioResult> {
    return {
      success: true,
      messages: this.state.history,
      reasoning: reasoning || "Scenario marked as successful with Scenario.succeed()",
      passedCriteria: [],
      failedCriteria: [],
    };
  }

  async fail(reasoning?: string): Promise<ScenarioResult> {
    return {
      success: false,
      messages: this.state.history,
      reasoning: reasoning || "Scenario marked as failed with Scenario.fail()",
      passedCriteria: [],
      failedCriteria: [],
    };
  }
}
