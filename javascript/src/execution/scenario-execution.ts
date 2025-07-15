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
  ScenarioConfigFinal,
  DEFAULT_MAX_TURNS,
  DEFAULT_VERBOSE,
} from "../domain";
import {
  ScenarioEvent,
  ScenarioEventType,
  ScenarioMessageSnapshotEvent,
  ScenarioRunFinishedEvent,
  ScenarioRunStartedEvent,
  ScenarioRunStatus,
  Verdict,
} from "../events/schema";
import convertCoreMessagesToAguiMessages from "../utils/convert-core-messages-to-agui-messages";
import {
  generateScenarioId,
  generateScenarioRunId,
  generateThreadId,
  getBatchRunId,
} from "../utils/ids";
import { Logger } from "../utils/logger";

/**
 * Manages the execution of a single scenario.
 *
 * This class orchestrates the interaction between agents, executes the script,
 * and manages the scenario's state. It also emits events that can be subscribed to
 * for observing the scenario's progress.
 *
 * Note: This is an internal class. Most users will interact with the higher-level
 * `scenario.run()` function instead of instantiating this class directly.
 *
 * @example
 * ```typescript
 * import scenario from "@langwatch/scenario";
 *
 * // This is a simplified example of what `scenario.run` does internally.
 * const result = await scenario.run({
 *   name: "My First Scenario",
 *   description: "A simple test of the agent's greeting.",
 *   agents: [
 *     scenario.userSimulatorAgent(),
 *     scenario.judgeAgent({
 *       criteria: ["Agent should respond with a greeting"],
 *     }),
 *   ],
 *   script: [
 *     scenario.user("Hello"),
 *     scenario.agent(),
 *     scenario.judge(),
 *   ]
 * });
 *
 * console.log("Scenario result:", result.success);
 * ```
 */
export class ScenarioExecution implements ScenarioExecutionLike {
  private state: ScenarioExecutionState;
  private eventSubject = new Subject<ScenarioEvent>();
  private logger = new Logger("scenario.execution.ScenarioExecution");
  private config: ScenarioConfigFinal;
  private agents: AgentAdapter[] = [];
  private pendingRolesOnTurn: AgentRole[] = [];
  private pendingAgentsOnTurn: Set<AgentAdapter> = new Set();
  private pendingMessages: Map<number, CoreMessage[]> = new Map();
  private partialResult: Omit<ScenarioResult, "messages"> | null = null;
  private agentTimes: Map<number, number> = new Map();
  private totalStartTime: number = 0;

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
  constructor(config: ScenarioConfig, script: ScriptStep[]) {
    this.config = {
      id: config.id ?? generateScenarioId(),
      name: config.name,
      description: config.description,
      agents: config.agents,
      script: script,
      verbose: config.verbose ?? DEFAULT_VERBOSE,
      maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
      threadId: config.threadId ?? generateThreadId(),
      setId: config.setId,
    } satisfies ScenarioConfigFinal;

    this.state = new ScenarioExecutionState(this.config);

    this.reset();
  }

  /**
   * The history of messages in the conversation.
   */
  get messages(): CoreMessage[] {
    return this.state.messages;
  }

  /**
   * The unique identifier for the conversation thread.
   */
  get threadId(): string {
    return this.state.threadId;
  }

  /**
   * The total elapsed time for the scenario execution.
   */
  private get totalTime(): number {
    return Date.now() - this.totalStartTime;
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
      for (let i = 0; i < this.config.script.length; i++) {
        const scriptStep = this.config.script[i];

        const result = await this.executeScriptStep(scriptStep, i);

        this.emitMessageSnapshot({ scenarioRunId });

        if (result && typeof result === "object" && "success" in result) {
          this.emitRunFinished({
            scenarioRunId,
            status: result.success
              ? ScenarioRunStatus.SUCCESS
              : ScenarioRunStatus.FAILED,
            result: result as ScenarioResult,
          });

          return result as ScenarioResult;
        }
      }

      this.emitRunFinished({ scenarioRunId, status: ScenarioRunStatus.FAILED });

      // If no conclusion reached, return max turns error
      return this.reachedMaxTurns(
        [
          "Reached end of script without conclusion, add one of the following to the end of the script:",
          "- `Scenario.proceed()` to let the simulation continue to play out",
          "- `Scenario.judge()` to force criteria judgement",
          "- `Scenario.succeed()` or `Scenario.fail()` to end the test with an explicit result",
        ].join("\n")
      );
    } catch (error) {
      const errorResult: ScenarioResult = {
        success: false,
        messages: this.state.messages,
        reasoning: `Scenario failed with error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        metCriteria: [],
        unmetCriteria: [],
        error: error instanceof Error ? error.message : String(error),
      };
      this.emitRunFinished({
        scenarioRunId,
        status: ScenarioRunStatus.ERROR,
        result: errorResult,
      });
      return errorResult;
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
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<CoreMessage[] | ScenarioResult | null> {
    if (this.pendingRolesOnTurn.length === 0) {
      if (!goToNextTurn) return null;

      this.newTurn();

      if (onTurn) await onTurn(this.state);

      if (this.state.currentTurn >= this.config.maxTurns)
        return this.reachedMaxTurns();
    }

    const currentRole = this.pendingRolesOnTurn[0];
    const { idx, agent: nextAgent } = this.nextAgentForRole(currentRole);
    if (!nextAgent) {
      this.removePendingRole(currentRole);
      return this._step(goToNextTurn, onTurn);
    }

    this.removePendingAgent(nextAgent);

    return await this.callAgent(idx, currentRole);
  }

  private async callAgent(
    idx: number,
    role: AgentRole,
    judgmentRequest: boolean = false
  ): Promise<CoreMessage[] | ScenarioResult> {
    const agent = this.agents[idx];
    const startTime = Date.now();
    const agentInput: AgentInput = {
      threadId: this.state.threadId,
      messages: this.state.messages,
      newMessages: this.pendingMessages.get(idx) ?? [],
      requestedRole: role,
      judgmentRequest: judgmentRequest,
      scenarioState: this.state,
      scenarioConfig: this.config,
    };

    try {
      const agentResponse = await agent.call(agentInput);
      const endTime = Date.now();

      this.addAgentTime(idx, endTime - startTime);
      this.pendingMessages.delete(idx);

      if (
        agentResponse &&
        typeof agentResponse === "object" &&
        "success" in agentResponse
      ) {
        return agentResponse as ScenarioResult;
      }

      const currentAgentTime = this.agentTimes.get(idx) ?? 0;
      this.agentTimes.set(idx, currentAgentTime + (Date.now() - startTime));

      const messages = convertAgentReturnTypesToMessages(
        agentResponse,
        role === AgentRole.USER ? "user" : "assistant"
      );

      for (const message of messages) {
        this.state.addMessage(message);
        this.broadcastMessage(message, idx);
      }

      return messages;
    } catch (error) {
      this.logger.error(
        `[${this.config.id}] Error calling agent ${agent.constructor.name}`,
        {
          error: error instanceof Error ? error.message : String(error),
          agent: agent.constructor.name,
          agentInput,
        }
      );

      throw error;
    }
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
      this.broadcastMessage(message);
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
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<ScenarioResult | null> {
    let initialTurn = this.state.currentTurn;

    while (true) {
      const goToNextTurn =
        turns === void 0 ||
        initialTurn === null ||
        (this.state.currentTurn != null &&
          this.state.currentTurn + 1 < initialTurn + turns);
      const nextMessage = await this._step(goToNextTurn, onTurn);

      if (initialTurn === null) initialTurn = this.state.currentTurn;

      if (nextMessage === null) {
        return null;
      }

      if (onStep) await onStep(this.state);

      if (
        nextMessage !== null &&
        typeof nextMessage === "object" &&
        "success" in nextMessage
      )
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
      messages: this.state.messages,
      reasoning:
        reasoning || "Scenario marked as successful with Scenario.succeed()",
      metCriteria: [],
      unmetCriteria: [],
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
      messages: this.state.messages,
      reasoning: reasoning || "Scenario marked as failed with Scenario.fail()",
      metCriteria: [],
      unmetCriteria: [],
    };
  }

  addAgentTime(agentIdx: number, time: number): void {
    const currentTime = this.agentTimes.get(agentIdx) || 0;

    this.agentTimes.set(agentIdx, currentTime + time);
  }

  hasResult(): boolean {
    return this.partialResult !== null;
  }

  setResult(result: Omit<ScenarioResult, "messages">): void {
    this.partialResult = result;
  }

  private async scriptCallAgent(
    role: AgentRole,
    content?: string | CoreMessage,
    judgmentRequest: boolean = false
  ): Promise<ScenarioResult | null> {
    this.consumeUntilRole(role);

    let index = -1;
    let agent: AgentAdapter | null = null;

    let nextAgent = this.getNextAgentForRole(role);
    if (!nextAgent) {
      this.newTurn();
      this.consumeUntilRole(role);

      nextAgent = this.getNextAgentForRole(role);
    }

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

    this.removePendingAgent(agent);

    if (content) {
      const message =
        typeof content === "string"
          ? ({
              role: role === AgentRole.USER ? "user" : "assistant",
              content,
            } as CoreMessage)
          : content;
      this.state.addMessage(message);
      this.broadcastMessage(message, index);

      return null;
    }

    const result = await this.callAgent(index, role, judgmentRequest);
    if (result && typeof result === "object" && "success" in result) {
      return result as ScenarioResult;
    }

    // The result is a set of messages, which have already been added to the state
    // by callAgent, so we don't need to do anything with them here.

    return null;
  }

  private reset(): void {
    this.state = new ScenarioExecutionState(this.config);
    this.state.threadId = this.config.threadId || generateThreadId();
    this.setAgents(this.config.agents);
    this.newTurn();
    this.state.currentTurn = 0;
    this.totalStartTime = Date.now();
    this.pendingMessages.clear();
  }

  private nextAgentForRole(role: AgentRole): {
    idx: number;
    agent: AgentAdapter | null;
  } {
    for (const agent of this.agents) {
      if (
        agent.role === role &&
        this.pendingAgentsOnTurn.has(agent) &&
        this.pendingRolesOnTurn.includes(role)
      ) {
        return { idx: this.agents.indexOf(agent), agent };
      }
    }

    return { idx: -1, agent: null };
  }

  private newTurn(): void {
    this.pendingAgentsOnTurn = new Set(this.agents);
    this.pendingRolesOnTurn = [
      AgentRole.USER,
      AgentRole.AGENT,
      AgentRole.JUDGE,
    ];

    if (this.state.currentTurn === null) {
      this.state.currentTurn = 1;
    } else {
      this.state.currentTurn++;
    }
  }

  private removePendingRole(role: AgentRole): void {
    const index = this.pendingRolesOnTurn.indexOf(role);
    if (index > -1) {
      this.pendingRolesOnTurn.splice(index, 1);
    }
  }

  private removePendingAgent(agent: AgentAdapter): void {
    this.pendingAgentsOnTurn.delete(agent);
  }

  private getNextAgentForRole(
    role: AgentRole
  ): { index: number; agent: AgentAdapter } | null {
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      if (agent.role === role && this.pendingAgentsOnTurn.has(agent)) {
        return { index: i, agent };
      }
    }
    return null;
  }

  private setAgents(agents: AgentAdapter[]): void {
    this.agents = agents;
    this.agentTimes.clear();
  }

  private consumeUntilRole(role: AgentRole): void {
    while (this.pendingRolesOnTurn.length > 0) {
      const nextRole = this.pendingRolesOnTurn[0];
      if (nextRole === role) break;
      this.pendingRolesOnTurn.pop();
    }
  }

  private reachedMaxTurns(errorMessage?: string): ScenarioResult {
    const agentRoleAgentsIdx = this.agents
      .map((agent, i) => ({ agent, idx: i }))
      .filter(({ agent }) => agent.role === AgentRole.AGENT)
      .map(({ idx }) => idx);

    const agentTimes = agentRoleAgentsIdx.map(
      (i) => this.agentTimes.get(i) || 0
    );

    const totalAgentTime = agentTimes.reduce((sum, time) => sum + time, 0);

    return {
      success: false,
      messages: this.state.messages,
      reasoning:
        errorMessage ||
        `Reached maximum turns (${
          this.config.maxTurns || 10
        }) without conclusion`,
      metCriteria: [],
      unmetCriteria: this.getJudgeAgent()?.criteria ?? [],
      totalTime: this.totalTime,
      agentTime: totalAgentTime,
    };
  }

  private getJudgeAgent(): JudgeAgentAdapter | null {
    return (
      this.agents.find((agent) => agent instanceof JudgeAgentAdapter) ?? null
    );
  }

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
      type: "placeholder", // This will be replaced by the specific event type
      timestamp: Date.now(),
      batchRunId: getBatchRunId(),
      scenarioId: this.config.id,
      scenarioRunId,
      scenarioSetId: this.config.setId,
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
      messages: convertCoreMessagesToAguiMessages(this.state.messages),
      // Add any other required fields from MessagesSnapshotEventSchema
    } as ScenarioMessageSnapshotEvent);
  }

  /**
   * Emits a run finished event with the final execution status.
   */
  private emitRunFinished({
    scenarioRunId,
    status,
    result,
  }: {
    scenarioRunId: string;
    status: ScenarioRunStatus;
    result?: ScenarioResult;
  }) {
    const event: ScenarioRunFinishedEvent = {
      ...this.makeBaseEvent({ scenarioRunId }),
      scenarioSetId: this.config.setId ?? "default",
      type: ScenarioEventType.RUN_FINISHED,
      status: status,
      results: {
        verdict: result?.success ? Verdict.SUCCESS : Verdict.FAILURE,
        metCriteria: result?.metCriteria ?? [],
        unmetCriteria: result?.unmetCriteria ?? [],
        reasoning: result?.reasoning,
        error: result?.error,
      },
    };

    this.emitEvent(event);
    this.eventSubject.complete();
  }

  /**
   * Distributes a message to all other agents in the scenario.
   *
   * @param message - The message to broadcast.
   * @param fromAgentIdx - The index of the agent that sent the message, to avoid echoing.
   */
  private broadcastMessage(message: CoreMessage, fromAgentIdx?: number): void {
    for (let idx = 0; idx < this.agents.length; idx++) {
      if (idx === fromAgentIdx) continue;

      if (!this.pendingMessages.has(idx)) {
        this.pendingMessages.set(idx, []);
      }
      this.pendingMessages.get(idx)!.push(message);
    }
  }

  /**
   * Executes a single script step with proper error handling and logging.
   * @param scriptStep The script step function to execute
   * @param stepIndex The index of the script step for logging context
   * @returns The result of the script step execution
   * @private
   */
  private async executeScriptStep(
    scriptStep: ScriptStep,
    stepIndex: number
  ): Promise<void | ScenarioResult | null> {
    const functionString = scriptStep.toString();

    try {
      this.logger.debug(
        `[${this.config.id}] Executing script step ${stepIndex + 1}`,
        {
          stepIndex,
          function: functionString,
        }
      );

      const result = await scriptStep(this.state, this);

      this.logger.debug(
        `[${this.config.id}] Script step ${stepIndex + 1} completed`,
        {
          stepIndex,
          hasResult: result !== null && result !== undefined,
          resultType: typeof result,
        }
      );

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `[${this.config.id}] Script step ${stepIndex + 1} failed`,
        {
          stepIndex,
          error: errorMessage,
          function: functionString,
        }
      );

      // Re-throw the error with additional context
      throw new Error(`Script step ${stepIndex + 1} failed: ${errorMessage}`);
    }
  }
}

function convertAgentReturnTypesToMessages(
  response: AgentReturnTypes,
  role: "user" | "assistant"
): CoreMessage[] {
  if (typeof response === "string")
    return [{ role, content: response } as CoreMessage];

  if (Array.isArray(response)) return response;

  if (typeof response === "object" && "role" in response) return [response];

  return [];
}
