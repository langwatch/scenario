import { CoreMessage } from "ai";
import { Observable, Subject } from "rxjs";
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
  ScenarioExecutionStateLike,
  ScenarioConfigFinal
} from "../domain";
import { ScenarioEvent, ScenarioEventType, ScenarioMessageSnapshotEvent, ScenarioRunFinishedEvent, ScenarioRunStartedEvent, ScenarioRunStatus } from "../events/schema";
import { generateScenarioId, generateScenarioRunId, generateThreadId, getBatchRunId } from "../utils/ids";
import { Logger } from "../utils/logger";

const batchRunId = getBatchRunId();

function convertAgentReturnTypesToMessages(response: AgentReturnTypes, role: "user" | "assistant"): CoreMessage[] {
  if (typeof response === "string")
    return [{ role, content: response } as CoreMessage];

  if (Array.isArray(response))
    return response;

  if (typeof response === "object" && "role" in response)
    return [response];

  return [];
}

/**
 * Manages the execution of a single scenario.
 *
 * This class orchestrates the interaction between agents, executes the script,
 * and manages the scenario's state. It also emits events that can be subscribed to
 * for observing the scenario's progress.
 *
 * @example
 * ```typescript
 * import { scenario, user, agent, succeed, judge } from "@getscenario/scenario";
 *
 * const myScenario = scenario(
 *   {
 *     name: "My First Scenario",
 *     description: "A simple test of the agent's greeting.",
 *     agents: [
 *       scenario.userSimulatorAgent(),
 *       scenario.judgeAgent({
 *         criteria: [
 *           "Agent should respond with a greeting",
 *           "Agent should ask for the user's name",
 *           "Agent should respond with a farewell",
 *         ],
 *       }),
 *     ],
 *   },
 *   [
 *     user("Hello"),
 *     agent("Hi, how can I help you?"),
 *     succeed("Agent responded correctly."),
 *   ]
 * );
 *
 * const execution = new ScenarioExecution(myScenario.config, myScenario.script);
 *
 * execution.events$.subscribe(event => {
 *   console.log("Scenario event:", event);
 * });
 *
 * const result = await execution.execute();
 * console.log("Scenario result:", result.success);
 * ```
 */
export class ScenarioExecution implements ScenarioExecutionLike {
  private state: ScenarioExecutionStateLike = new ScenarioExecutionState();
  private eventSubject = new Subject<ScenarioEvent>();
  private logger = new Logger("scenario.execution.ScenarioExecution");
  private config: ScenarioConfigFinal;

  /**
   * An observable stream of events that occur during the scenario execution.
   * Subscribe to this to monitor the progress of the scenario in real-time.
   */
  public readonly events$: Observable<ScenarioEvent> =
    this.eventSubject.asObservable();

  /**
   * Creates a new ScenarioExecution instance.
   * @param config The scenario configuration.
   * @param script The script steps to execute.
   */
  constructor(config: ScenarioConfig, script: ScriptStep[],
  ) {
    this.config = {
      id: config.id ?? generateScenarioId(),
      name: config.name,
      description: config.description,
      agents: config.agents,
      script: script,
      verbose: config.verbose ?? false,
      maxTurns: config.maxTurns ?? 10,
      threadId: config.threadId ?? generateThreadId(),
    } satisfies ScenarioConfigFinal;

    this.reset();
  }

  /**
   * The history of messages in the conversation.
   */
  get history(): CoreMessage[] {
    return this.state.history;
  }

  /**
   * The unique identifier for the conversation thread.
   */
  get threadId(): string {
    return this.state.threadId;
  }

  /**
   * Executes the entire scenario from start to finish.
   * This will run through the script and any automatic proceeding logic until a
   * final result (success, failure, or error) is determined.
   * @returns A promise that resolves with the final result of the scenario.
   */
  async execute(): Promise<ScenarioResult> {
    this.reset();

    const scenarioRunId = generateScenarioRunId();
    this.emitRunStarted({ scenarioRunId });

    try {
      // Execute script steps - pass the execution context (this), not just state
      for (const scriptStep of this.config.script) {
        this.logger.debug(`[${this.config.id}] Executing script step`, {
          scriptStep,
        });

        const result = await scriptStep(this.state, this);

        this.emitMessageSnapshot({ scenarioRunId });

        if (result && typeof result === "object" && "success" in result) {
          this.emitRunFinished({
            scenarioRunId,
            status: result.success ? ScenarioRunStatus.SUCCESS : ScenarioRunStatus.FAILED,
          });

          return result as ScenarioResult;
        }
      }

      this.emitRunFinished({ scenarioRunId, status: ScenarioRunStatus.FAILED });

      // If no conclusion reached, return max turns error
      return this.reachedMaxTurns([
        "Reached end of script without conclusion, add one of the following to the end of the script:",
        "- `Scenario.proceed()` to let the simulation continue to play out",
        "- `Scenario.judge()` to force criteria judgement",
        "- `Scenario.succeed()` or `Scenario.fail()` to end the test with an explicit result",
      ].join("\n"));
    } catch (error) {
      this.emitRunFinished({
        scenarioRunId,
        status: ScenarioRunStatus.ERROR,
      });

      throw error;
    }
  }

  /**
   * Executes a single step in the scenario.
   * A step usually corresponds to a single agent's turn. This method is useful
   * for manually controlling the scenario's progress.
   * @returns A promise that resolves with the new messages added during the step, or a final scenario result if the step concludes the scenario.
   */
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

      if (this.state.turn != null && this.state.turn >= this.config.maxTurns)
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

  /**
   * Adds a message to the conversation history.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param message The message to add.
   */
  async message(message: CoreMessage): Promise<void> {
    if (message.role === "user") {
      await this.scriptCallAgent(AgentRole.USER, message);
    } else if (message.role === "assistant") {
      await this.scriptCallAgent(AgentRole.AGENT, message);
    } else {
      this.state.addMessage(message);
    }
  }

  /**
   * Executes a user turn.
   * If content is provided, it's used as the user's message.
   * If not, the user simulator agent is called to generate a message.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param content The optional content of the user's message.
   */
  async user(content?: string | CoreMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.USER, content);
  }

  /**
   * Executes an agent turn.
   * If content is provided, it's used as the agent's message.
   * If not, the agent under test is called to generate a response.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param content The optional content of the agent's message.
   */
  async agent(content?: string | CoreMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.AGENT, content);
  }

  /**
   * Invokes the judge agent to evaluate the current state of the conversation.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param content Optional message to pass to the judge.
   * @returns A promise that resolves with the scenario result if the judge makes a final decision, otherwise null.
   */
  async judge(content?: string | CoreMessage): Promise<ScenarioResult | null> {
    return await this.scriptCallAgent(AgentRole.JUDGE, content, true);
  }

  /**
   * Lets the scenario proceed automatically for a specified number of turns.
   * This simulates the natural flow of conversation between agents.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param turns The number of turns to proceed. If undefined, runs until a conclusion or max turns is reached.
   * @param onTurn A callback executed at the end of each turn.
   * @param onStep A callback executed after each agent interaction.
   * @returns A promise that resolves with the scenario result if a conclusion is reached.
   */
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

  /**
   * Immediately ends the scenario with a success verdict.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param reasoning An optional explanation for the success.
   * @returns A promise that resolves with the final successful scenario result.
   */
  async succeed(reasoning?: string): Promise<ScenarioResult> {
    return {
      success: true,
      messages: this.state.history,
      reasoning: reasoning || "Scenario marked as successful with Scenario.succeed()",
      passedCriteria: [],
      failedCriteria: [],
    };
  }

  /**
   * Immediately ends the scenario with a failure verdict.
   * This is part of the `ScenarioExecutionLike` interface used by script steps.
   * @param reasoning An optional explanation for the failure.
   * @returns A promise that resolves with the final failed scenario result.
   */
  async fail(reasoning?: string): Promise<ScenarioResult> {
    return {
      success: false,
      messages: this.state.history,
      reasoning: reasoning || "Scenario marked as failed with Scenario.fail()",
      passedCriteria: [],
      failedCriteria: [],
    };
  }

  private reset(): void {
    this.state = new ScenarioExecutionState();
    this.state.setThreadId(this.config.threadId || generateThreadId());
    this.state.setAgents(this.config.agents);
    this.state.newTurn();
    this.state.turn = 0;
  }

  // =====================================================
  // Event Emission Methods
  // =====================================================
  // These methods handle the creation and emission of
  // scenario events for external consumption and monitoring
  // =====================================================

  /**
   * Emits an event to the event stream for external consumption.
   */
  private emitEvent(event: ScenarioEvent): void {
    this.eventSubject.next(event);
  }

  /**
   * Creates base event properties shared across all scenario events.
   */
  private makeBaseEvent({ scenarioRunId }: { scenarioRunId: string }) {
    return {
      batchRunId: batchRunId,
      scenarioId: this.config.id!,
      scenarioRunId,
      timestamp: Date.now(),
      rawEvent: undefined,
    };
  }

  /**
   * Emits a run started event to indicate scenario execution has begun.
   */
  private emitRunStarted({ scenarioRunId }: { scenarioRunId: string }) {
    this.emitEvent({
      ...this.makeBaseEvent({ scenarioRunId }),
      type: ScenarioEventType.RUN_STARTED,
      metadata: {
        name: this.config.name,
        description: this.config.description,
      },
    } as ScenarioRunStartedEvent);
  }

  /**
   * Emits a message snapshot event containing current conversation history.
   */
  private emitMessageSnapshot({ scenarioRunId }: { scenarioRunId: string }) {
    this.emitEvent({
      ...this.makeBaseEvent({ scenarioRunId }),
      type: ScenarioEventType.MESSAGE_SNAPSHOT,
      messages: this.state.history,
      // Add any other required fields from MessagesSnapshotEventSchema
    } as ScenarioMessageSnapshotEvent);
  }

  /**
   * Emits a run finished event with the final execution status.
   */
  private emitRunFinished({
    scenarioRunId,
    status,
  }: {
    scenarioRunId: string;
    status: ScenarioRunStatus;
  }) {
    this.emitEvent({
      ...this.makeBaseEvent({ scenarioRunId }),
      type: ScenarioEventType.RUN_FINISHED,
      status,
      // Add error/metrics fields if needed
    } as ScenarioRunFinishedEvent);
  }
}
