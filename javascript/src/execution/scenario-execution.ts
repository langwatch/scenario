import { context, type Span } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { ModelMessage } from "ai";
import { getLangWatchTracer } from "langwatch";
import { attributes } from "langwatch/observability";
import { filter, Observable, Subject } from "rxjs";
import {
  ScenarioExecutionState,
  StateChangeEventType,
} from "./scenario-execution-state";
import {
  type ScenarioResult,
  type ScenarioConfig,
  AgentRole,
  type AgentInput,
  type JudgmentRequest,
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
import convertModelMessagesToAguiMessages from "../utils/convert-core-messages-to-agui-messages";
import {
  generateScenarioId,
  generateScenarioRunId,
  generateThreadId,
} from "../utils/ids";
import { Logger } from "../utils/logger";

/**
 * Manages the execution of a single scenario test.
 *
 * This class orchestrates the interaction between agents (user simulator, agent under test,
 * and judge), executes the test script step-by-step, and manages the scenario's state
 * throughout execution. It also emits events that can be subscribed to for real-time
 * monitoring of the scenario's progress.
 *
 * ## Execution Flow Overview
 *
 * The execution follows a turn-based system where agents take turns responding. The key
 * concepts are:
 * - **Script Steps**: Functions in the scenario script like `user()`, `agent()`, `proceed()`, etc.
 * - **Agent Interactions**: Individual agent responses that occur when an agent takes their turn
 * - **Turns**: Groups of agent interactions that happen in sequence
 *
 * ## Message Broadcasting System
 *
 * The class implements a sophisticated message broadcasting system that ensures all agents
 * can "hear" each other's messages:
 *
 * 1. **Message Creation**: When an agent sends a message, it's added to the conversation history
 * 2. **Broadcasting**: The message is immediately broadcast to all other agents via `broadcastMessage()`
 * 3. **Queue Management**: Each agent has a pending message queue (`pendingMessages`) that stores
 *    messages from other agents
 * 4. **Agent Input**: When an agent is called, it receives both the full conversation history
 *    and any new pending messages that have been broadcast to it
 * 5. **Queue Clearing**: After an agent processes its pending messages, its queue is cleared
 *
 * This creates a realistic conversation environment where agents can respond contextually
 * to the full conversation history and any new messages from other agents.
 *
 * ## Example Message Flow
 *
 * ```
 * Turn 1:
 * 1. User Agent sends: "Hello"
 *    - Added to conversation history
 *    - Broadcast to Agent and Judge (pendingMessages[1] = ["Hello"], pendingMessages[2] = ["Hello"])
 *
 * 2. Agent is called:
 *    - Receives: full conversation + pendingMessages[1] = ["Hello"]
 *    - Sends: "Hi there! How can I help you?"
 *    - Added to conversation history
 *    - Broadcast to User and Judge (pendingMessages[0] = ["Hi there!..."], pendingMessages[2] = ["Hello", "Hi there!..."])
 *    - pendingMessages[1] is cleared
 *
 * 3. Judge is called:
 *    - Receives: full conversation + pendingMessages[2] = ["Hello", "Hi there!..."]
 *    - Evaluates and decides to continue
 *    - pendingMessages[2] is cleared
 * ```
 *
 * Each script step can trigger one or more agent interactions depending on the step type.
 * For example, a `proceed(5)` step might trigger 10 agent interactions across 5 turns.
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
 *     scenario.user("Hello"),     // Script step 1: triggers 1 agent interaction
 *     scenario.agent(),           // Script step 2: triggers 1 agent interaction
 *     scenario.proceed(3),        // Script step 3: triggers multiple agent interactions
 *     scenario.judge(),           // Script step 4: triggers 1 agent interaction
 *   ]
 * });
 *
 * console.log("Scenario result:", result.success);
 * ```
 */
export class ScenarioExecution implements ScenarioExecutionLike {
  /** LangWatch tracer for scenario execution */
  private tracer = getLangWatchTracer("@langwatch/scenario");

  /** The current state of the scenario execution */
  private state: ScenarioExecutionState;

  /** The final result of the scenario execution, set when a conclusion is reached */
  private _result?: ScenarioResult;

  /** Logger for debugging and monitoring */
  private logger = new Logger("scenario.execution.ScenarioExecution");

  /** Finalized configuration with all defaults applied */
  private config: ScenarioConfigFinal;

  /** Array of all agents participating in the scenario */
  private agents: AgentAdapter[] = [];

  /** Roles that still need to act in the current turn (USER, AGENT, JUDGE) */
  private pendingRolesOnTurn: AgentRole[] = [];

  /** Agents that still need to act in the current turn */
  private pendingAgentsOnTurn: Set<AgentAdapter> = new Set();

  /**
   * Message queues for each agent. When an agent sends a message, it gets
   * broadcast to all other agents' pending message queues. When an agent
   * is called, it receives these pending messages as part of its input.
   *
   * Key: agent index, Value: array of pending messages for that agent
   */
  private pendingMessages: Map<number, ModelMessage[]> = new Map();

  /** Accumulated execution time for each agent (for performance tracking) */
  private agentTimes: Map<number, number> = new Map();

  /** Current turn span for trace context management */
  private currentTurnSpan?: Span;

  /** Timestamp when execution started (for total time calculation) */
  private totalStartTime: number = 0;

  /** Accumulated results from inline judge checkpoints */
  private checkpointResults: { metCriteria: string[]; unmetCriteria: string[] }[] = [];

  /** Event stream for monitoring scenario progress */
  private eventSubject = new Subject<ScenarioEvent>();

  /**
   * An observable stream of events that occur during the scenario execution.
   * Subscribe to this to monitor the progress of the scenario in real-time.
   *
   * Events include:
   * - RUN_STARTED: When scenario execution begins
   * - MESSAGE_SNAPSHOT: After each message is added to the conversation
   * - RUN_FINISHED: When scenario execution completes (success/failure/error)
   */
  public readonly events$: Observable<ScenarioEvent> =
    this.eventSubject.asObservable();

  /** Batch run ID for grouping scenario runs */
  private batchRunId: string;

  /** The run ID for the current execution */
  private scenarioRunId?: string;

  /** Pre-assigned run ID (provided externally, e.g. by the platform) */
  private preAssignedRunId?: string;

  /**
   * Creates a new ScenarioExecution instance.
   *
   * @param config - The scenario configuration containing agents, settings, and metadata
   * @param script - The ordered sequence of script steps that define the test flow
   * @param batchRunId - Batch run ID for grouping scenario runs
   * @param runId - Optional pre-assigned run ID. When provided, the execution uses this
   *   ID instead of generating a new one. This prevents duplicate entries when the
   *   platform pre-creates placeholder rows with a known ID.
   */
  constructor(config: ScenarioConfig, script: ScriptStep[], batchRunId: string, runId?: string) {
    if (!batchRunId) {
      throw new Error("batchRunId is required");
    }
    this.batchRunId = batchRunId;
    this.config = {
      id: config.id ?? generateScenarioId(),
      name: config.name,
      description: config.description,
      agents: config.agents,
      script: script,
      verbose: config.verbose ?? DEFAULT_VERBOSE,
      maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
      threadId: config.threadId ?? generateThreadId(),
      setId: config.setId || "default",
      metadata: config.metadata,
    } satisfies ScenarioConfigFinal;

    this.state = new ScenarioExecutionState(this.config);
    this.preAssignedRunId = runId;

    // Wire up rollback handler so the state can clean pending queues
    this.state.setOnRollback((removedSet: Set<object>) => {
      this.pendingMessages.forEach((queue, idx) => {
        this.pendingMessages.set(
          idx,
          queue.filter((m: ModelMessage) => !removedSet.has(m))
        );
      });
      this.logger.debug(`[${this.config.id}] rollbackMessagesTo removed ${removedSet.size} message(s)`);
    });

    this.reset();
  }

  /**
   * Gets the complete conversation history as an array of messages.
   *
   * @returns Array of ModelMessage objects representing the full conversation
   */
  get messages(): ModelMessage[] {
    return this.state.messages;
  }

  /**
   * Gets the unique identifier for the conversation thread.
   * This ID is used to maintain conversation context across multiple runs.
   *
   * @returns The thread identifier string
   */
  get threadId(): string {
    return this.state.threadId;
  }

  /**
   * Gets the result of the scenario execution if it has been set.
   *
   * @returns The scenario result or undefined if not yet set
   */
  get result(): ScenarioResult | undefined {
    return this._result;
  }

  /**
   * Sets the result of the scenario execution.
   * This is called when the scenario reaches a conclusion (success or failure).
   * Automatically includes messages, totalTime, and agentTime from the current execution context.
   *
   * @param result - The final scenario result (without messages/timing, which will be added automatically)
   */
  private setResult(
    result: Omit<ScenarioResult, "runId" | "messages" | "totalTime" | "agentTime">
  ): ScenarioResult {
    if (!this.scenarioRunId) {
      throw new Error("Cannot set result: scenarioRunId has not been initialized. This is a bug in ScenarioExecution.");
    }

    const agentRoleAgentsIdx = this.agents
      .map((agent, i) => ({ agent, idx: i }))
      .filter(({ agent }) => agent.role === AgentRole.AGENT)
      .map(({ idx }) => idx);

    const agentTimes = agentRoleAgentsIdx.map(
      (i) => this.agentTimes.get(i) || 0
    );

    const totalAgentTime = agentTimes.reduce((sum, time) => sum + time, 0);

    this._result = {
      runId: this.scenarioRunId,
      ...result,
      messages: this.state.messages,
      totalTime: this.totalTime,
      agentTime: totalAgentTime,
    };

    this.logger.debug(`[${this.config.id}] Result set`, {
      success: result.success,
      reasoning: result.reasoning,
      totalTime: this.totalTime,
      agentTime: totalAgentTime,
      messageCount: this.state.messages.length,
    });

    return this._result;
  }

  /**
   * The total elapsed time for the scenario execution.
   */
  private get totalTime(): number {
    return Date.now() - this.totalStartTime;
  }

  /**
   * Executes the entire scenario from start to finish.
   *
   * This method runs through all script steps sequentially until a final result
   * (success, failure, or error) is determined. Each script step can trigger one or
   * more agent interactions depending on the step type:
   * - `user()` and `agent()` steps typically trigger one agent interaction each
   * - `proceed()` steps can trigger multiple agent interactions across multiple turns
   * - `judge()` steps trigger the judge agent to evaluate the conversation
   * - `succeed()` and `fail()` steps immediately end the scenario
   *
   * The execution will stop early if:
   * - A script step returns a ScenarioResult
   * - The maximum number of turns is reached
   * - An error occurs during execution
   *
   * @returns A promise that resolves with the final result of the scenario
   * @throws Error if an unhandled exception occurs during execution
   *
   * @example
   * ```typescript
   * const execution = new ScenarioExecution(config, script);
   * const result = await execution.execute();
   * console.log(`Scenario ${result.success ? 'passed' : 'failed'}`);
   * ```
   */
  async execute(): Promise<ScenarioResult> {
    this.logger.debug(`[${this.config.id}] Starting scenario execution`, {
      name: this.config.name,
      maxTurns: this.config.maxTurns,
      scriptLength: this.config.script.length,
    });

    this.reset();

    const scenarioRunId = this.preAssignedRunId || generateScenarioRunId();
    this.scenarioRunId = scenarioRunId;

    // Create the initial turn span via newTurn() and then reset the counter
    // back to 0. This matches the original reset() behavior — newTurn() creates
    // the span and sets currentTurn=1, then we override to 0 so the first
    // newTurn() in the execution loop correctly advances to 1.
    this.newTurn();
    this.state.currentTurn = 0;
    this.logger.debug(`[${this.config.id}] ${this.preAssignedRunId ? "Using pre-assigned" : "Generated"} run ID: ${scenarioRunId}`);
    this.emitRunStarted({ scenarioRunId });

    // Create subscription with captured runId (closure)
    const subscription = this.state.events$
      .pipe(
        filter((event) => event.type === StateChangeEventType.MESSAGE_ADDED)
      )
      .subscribe(() => {
        this.emitMessageSnapshot({ scenarioRunId });
      });

    let checkFailure: Error | null = null;

    try {
      // Execute script steps - pass the execution context (this), not just state
      for (let i = 0; i < this.config.script.length; i++) {
        const scriptStep = this.config.script[i];

        try {
          await this.executeScriptStep(scriptStep, i);
        } catch (error) {
          if (error instanceof Error && error.name === "AssertionError") {
            checkFailure = error;
            break;
          }
          throw error;
        }

        if (this.result) {
          const cp = this.compiledCheckpoints;
          this.result.metCriteria = [...cp.metCriteria, ...this.result.metCriteria];

          this.emitRunFinished({
            scenarioRunId,
            status: this.result.success
              ? ScenarioRunStatus.SUCCESS
              : ScenarioRunStatus.FAILED,
            result: this.result,
          });

          return this.result;
        }

      }

      if (checkFailure) {
        const cp = this.compiledCheckpoints;
        let result = this.setResult({
          success: false,
          reasoning: `Scenario failed with error: ${checkFailure.message}`,
          metCriteria: cp.metCriteria,
          unmetCriteria: [...cp.unmetCriteria, checkFailure.message],
        });

        this.emitRunFinished({
          scenarioRunId,
          status: ScenarioRunStatus.ERROR,
          result,
        });

        throw checkFailure;
      }

      if (this.checkpointResults.length > 0) {
        const cp = this.compiledCheckpoints;
        const result = this.setResult({
          success: cp.unmetCriteria.length === 0,
          reasoning: "All inline criteria checkpoints passed",
          metCriteria: cp.metCriteria,
          unmetCriteria: cp.unmetCriteria,
        });

        this.emitRunFinished({
          scenarioRunId,
          status: result.success ? ScenarioRunStatus.SUCCESS : ScenarioRunStatus.FAILED,
          result,
        });

        return result;
      }

      const result = this.reachedMaxTurns(
        [
          "Reached end of script without conclusion, add one of the following:",
          "- Add `Scenario.judge()` to the script to force criteria judgement",
          "- Add `Scenario.succeed()` or `Scenario.fail()` to end the test with an explicit result",
          "- If your script already has a judge but is hitting maxTurns, increase `maxTurns` in your config",
        ].join("\n")
      );

      this.emitRunFinished({
        scenarioRunId,
        status: result.success ? ScenarioRunStatus.SUCCESS : ScenarioRunStatus.FAILED,
        result,
      });

      return result;
    } catch (error) {
      if (checkFailure) {
        // Already handled above — just propagate
        throw error;
      }

      const errorInfo = extractErrorInfo(error);

      const result = this.setResult({
        success: false,
        reasoning: `Scenario failed with error: ${errorInfo.message}`,
        metCriteria: [],
        unmetCriteria: [],
        error: JSON.stringify(errorInfo),
      });

      this.emitRunFinished({
        scenarioRunId,
        status: ScenarioRunStatus.ERROR,
        result,
      });

      // Re-throw the error in case it was a vitest assertion error
      throw error;
    } finally {
      // End the last turn span to prevent leaked/un-ended spans
      if (this.currentTurnSpan) {
        this.currentTurnSpan.end();
        this.currentTurnSpan = undefined;
      }
      // Clean up the subscription when execution is done
      subscription.unsubscribe();
    }
  }

  /**
   * Executes a single agent interaction in the scenario.
   *
   * This method is for manual step-by-step execution of the scenario, where each call
   * represents one agent taking their turn. This is different from script steps (like
   * `user()`, `agent()`, `proceed()`, etc.) which are functions in the scenario script.
   *
   * Each call to this method will:
   * - Progress to the next turn if needed
   * - Find the next agent that should act
   * - Execute that agent's response
   * - Set the result if the scenario concludes
   *
   * Note: This method is primarily for debugging or custom execution flows. Most users
   * will use `execute()` to run the entire scenario automatically.
   *
   * After calling this method, check `this.result` to see if the scenario has concluded.
   *
   * @example
   * ```typescript
   * const execution = new ScenarioExecution(config, script);
   *
   * // Execute one agent interaction at a time
   * await execution.step();
   * if (execution.result) {
   *   console.log('Scenario finished:', execution.result.success);
   * }
   * ```
   */
  async step(): Promise<void> {
    await this._step();
  }

  private async _step(
    goToNextTurn: boolean = true,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<void> {
    this.logger.debug(`[${this.config.id}] _step called`, {
      goToNextTurn,
      pendingRoles: this.pendingRolesOnTurn,
      currentTurn: this.state.currentTurn,
    });

    if (this.pendingRolesOnTurn.length === 0) {
      if (!goToNextTurn) {
        this.logger.debug(
          `[${this.config.id}] No pending roles, not advancing turn`
        );
        return;
      }

      this.newTurn();

      if (onTurn) await onTurn(this.state);

      if (this.state.currentTurn >= this.config.maxTurns) {
        this.logger.debug(
          `[${this.config.id}] Reached max turns: ${this.state.currentTurn}`
        );
        this.reachedMaxTurns();
        return;
      }
    }

    const currentRole = this.pendingRolesOnTurn[0];
    const { idx, agent: nextAgent } = this.nextAgentForRole(currentRole);
    if (!nextAgent) {
      this.logger.debug(
        `[${this.config.id}] No agent for role ${currentRole}, removing role`
      );
      this.removePendingRole(currentRole);
      return this._step(goToNextTurn, onTurn);
    }

    this.logger.debug(`[${this.config.id}] Calling agent`, {
      role: currentRole,
      agentIdx: idx,
      agentName: nextAgent.name ?? nextAgent.constructor.name,
    });

    this.removePendingAgent(nextAgent);

    await this.callAgent(idx, currentRole);
  }

  /**
   * Calls a specific agent to generate a response or make a decision.
   *
   * This method is the core of agent interaction. It prepares the agent's input
   * by combining the conversation history with any pending messages that have been
   * broadcast to this agent, then calls the agent and processes its response.
   *
   * The agent input includes:
   * - Full conversation history (this.state.messages)
   * - New messages that have been broadcast to this agent (this.pendingMessages.get(idx))
   * - The role the agent is being asked to play
   * - Whether this is a judgment request (for judge agents)
   * - Current scenario state and configuration
   *
   * After the agent responds:
   * - Performance timing is recorded
   * - Pending messages for this agent are cleared (they've been processed)
   * - If the agent returns a ScenarioResult, it's set on this.result
   * - Otherwise, the agent's messages are added to the conversation and broadcast
   *
   * @param idx - The index of the agent in the agents array
   * @param role - The role the agent is being asked to play (USER, AGENT, or JUDGE)
   * @param judgmentRequest - Whether this is a judgment request (for judge agents)
   * @throws Error if the agent call fails
   */
  private async callAgent(
    idx: number,
    role: AgentRole,
    judgmentRequest?: JudgmentRequest
  ): Promise<void> {
    const agent = this.agents[idx];
    const agentName = agent.name ?? agent.constructor.name;

    this.logger.debug(`[${this.config.id}] callAgent started`, {
      agentIdx: idx,
      role,
      judgmentRequest,
      agentName,
      pendingMessagesCount: this.pendingMessages.get(idx)?.length ?? 0,
    });

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

    // Create agent span as child of the turn span
    // Following OpenTelemetry docs: create context with parent span right before creating child
    const agentContext = this.currentTurnSpan
      ? trace.setSpan(context.active(), this.currentTurnSpan)
      : context.active();

    const agentSpanName = `${
      agentName !== Object.prototype.constructor.name
        ? agent.constructor.name
        : "Agent"
    }.call`;

    try {
      // Wrap in context.with() so that context.active() returns the turn span
      // context for ALL async continuations, including those created internally
      // by the Vercel AI SDK. Without this, detached spans lose their parent.
      await context.with(agentContext, () =>
        this.tracer.withActiveSpan(
          agentSpanName,
          {
            attributes: {
              [attributes.ATTR_LANGWATCH_THREAD_ID]: this.state.threadId,
              "scenario.role": role,
            },
          },
          agentContext,
          async (agentSpan) => {
          agentSpan.setType("agent");

          // Set input for the span
          agentSpan.setInput("chat_messages", this.state.messages);

          const agentResponse = await agent.call(agentInput);
          const endTime = Date.now();
          const duration = endTime - startTime;

          this.logger.debug(`[${this.config.id}] Agent responded`, {
            agentIdx: idx,
            duration,
            responseType: typeof agentResponse,
            isScenarioResult:
              agentResponse &&
              typeof agentResponse === "object" &&
              "success" in agentResponse,
          });

          this.addAgentTime(idx, duration);
          this.pendingMessages.delete(idx);

          if (
            agentResponse &&
            typeof agentResponse === "object" &&
            "success" in agentResponse
          ) {
            this.logger.debug(
              `[${this.config.id}] Agent returned ScenarioResult`,
              {
                success: (agentResponse as { success: boolean }).success,
              }
            );
            // JudgeResult is automatically augmented with messages by setResult
            this.setResult(agentResponse);
            return;
          }

          const messages = convertAgentReturnTypesToMessages(
            agentResponse,
            role === AgentRole.USER ? "user" : "assistant"
          );

          // Set output for the span
          if (messages.length > 0) {
            agentSpan.setOutput("chat_messages", messages);
          }

          // Set metrics if available (would need to be extracted from agent response)
          const metrics: Record<string, number> = {
            duration: endTime - startTime,
          };

          // Add token usage if available from agent response
          if (agentResponse && typeof agentResponse === "object") {
            const usage = (
              agentResponse as {
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                };
              }
            ).usage;
            if (usage) {
              if (usage.prompt_tokens !== undefined)
                metrics.promptTokens = usage.prompt_tokens;
              if (usage.completion_tokens !== undefined)
                metrics.completionTokens = usage.completion_tokens;
              if (usage.total_tokens !== undefined)
                metrics.totalTokens = usage.total_tokens;
            }
          }

          agentSpan.setMetrics(metrics);

          // Add traceId to each message for proper correlation
          const traceId = agentSpan.spanContext().traceId.toString();

          for (const message of messages) {
            this.state.addMessage({
              ...message,
              traceId,
            });
            this.broadcastMessage(message, idx);
          }
        }
        )
      );
    } catch (error) {
      throw new Error(`[${agentName}] ${error}`, { cause: error });
    }
  }

  /**
   * Adds a message to the conversation history.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   * It automatically routes the message to the appropriate agent based on the message role:
   * - "user" messages are routed to USER role agents
   * - "assistant" messages are routed to AGENT role agents
   * - Other message types are added directly to the conversation
   *
   * @param message - The ModelMessage to add to the conversation
   *
   * @example
   * ```typescript
   * await execution.message({
   *   role: "user",
   *   content: "Hello, how are you?"
   * });
   * ```
   */
  async message(message: ModelMessage): Promise<void> {
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
   * Executes a user turn in the conversation.
   *
   * If content is provided, it's used directly as the user's message. If not provided,
   * the user simulator agent is called to generate an appropriate response based on
   * the current conversation context.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param content - Optional content for the user's message. Can be a string or ModelMessage.
   *                 If not provided, the user simulator agent will generate the content.
   *
   * @example
   * ```typescript
   * // Use provided content
   * await execution.user("What's the weather like?");
   *
   * // Let user simulator generate content
   * await execution.user();
   *
   * // Use a ModelMessage object
   * await execution.user({
   *   role: "user",
   *   content: "Tell me a joke"
   * });
   * ```
   */
  async user(content?: string | ModelMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.USER, content);
  }

  /**
   * Executes an agent turn in the conversation.
   *
   * If content is provided, it's used directly as the agent's response. If not provided,
   * the agent under test is called to generate a response based on the current conversation
   * context and any pending messages.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param content - Optional content for the agent's response. Can be a string or ModelMessage.
   *                 If not provided, the agent under test will generate the response.
   *
   * @example
   * ```typescript
   * // Let agent generate response
   * await execution.agent();
   *
   * // Use provided content
   * await execution.agent("The weather is sunny today!");
   *
   * // Use a ModelMessage object
   * await execution.agent({
   *   role: "assistant",
   *   content: "I'm here to help you with weather information."
   * });
   * ```
   */
  async agent(content?: string | ModelMessage): Promise<void> {
    await this.scriptCallAgent(AgentRole.AGENT, content);
  }

  /**
   * Invokes the judge agent to evaluate the current state of the conversation.
   *
   * The judge agent analyzes the conversation history and determines whether the
   * scenario criteria have been met. This can result in either:
   * - A final scenario result (success/failure) if the judge makes a decision
   * - Null if the judge needs more information or conversation to continue
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param options - Optional options with inline criteria to evaluate as a checkpoint.
   * @returns A promise that resolves with:
   *   - ScenarioResult if the judge makes a final decision, or
   *   - Null if the conversation should continue
   *
   * @example
   * ```typescript
   * // Let judge evaluate with its configured criteria
   * const result = await execution.judge();
   *
   * // Evaluate inline criteria as a checkpoint
   * const result = await execution.judge({ criteria: ["Agent responded helpfully"] });
   *
   * // Provide additional context for tool-call-heavy conversations
   * const result = await execution.judge({
   *   criteria: ["Agent installed the dependency"],
   *   context: "The agent ran `npm install -g git-orchard` which exited 0.",
   * });
   * ```
   */
  async judge(options?: { criteria?: string[]; context?: string }): Promise<ScenarioResult | null> {
    return await this.scriptCallAgent(
      AgentRole.JUDGE,
      undefined,
      { criteria: options?.criteria, context: options?.context }
    );
  }

  /**
   * Lets the scenario proceed automatically for a specified number of turns.
   *
   * This method is a script step that simulates natural conversation flow by allowing
   * agents to interact automatically without explicit script steps. It can trigger
   * multiple agent interactions across multiple turns, making it useful for testing
   * scenarios where you want to see how agents behave in extended conversations.
   *
   * Unlike other script steps that typically trigger one agent interaction each,
   * this step can trigger many agent interactions depending on the number of turns
   * and the agents' behavior.
   *
   * The method will continue until:
   * - The specified number of turns is reached
   * - A final scenario result is determined
   * - The maximum turns limit is reached
   *
   * @param turns - The number of turns to proceed. If undefined, runs until a conclusion
   *               or max turns is reached
   * @param onTurn - Optional callback executed at the end of each turn. Receives the
   *                current execution state
   * @param onStep - Optional callback executed after each agent interaction. Receives
   *                the current execution state
   * @returns A promise that resolves with:
   *   - ScenarioResult if a conclusion is reached during the proceeding, or
   *   - Null if the specified turns complete without conclusion
   *
   * @example
   * ```typescript
   * // Proceed for 5 turns
   * const result = await execution.proceed(5);
   *
   * // Proceed until conclusion with callbacks
   * const result = await execution.proceed(
   *   undefined,
   *   (state) => console.log(`Turn ${state.currentTurn} completed`),
   *   (state) => console.log(`Agent interaction completed, ${state.messages.length} messages`)
   * );
   * ```
   */
  async proceed(
    turns?: number,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>
  ): Promise<ScenarioResult | null> {
    this.logger.debug(`[${this.config.id}] proceed called`, {
      turns,
      currentTurn: this.state.currentTurn,
    });

    let initialTurn = this.state.currentTurn;

    while (true) {
      const goToNextTurn =
        turns === void 0 ||
        initialTurn === null ||
        (this.state.currentTurn != null &&
          this.state.currentTurn + 1 < initialTurn + turns);
      await this._step(goToNextTurn, onTurn);

      if (initialTurn === null) initialTurn = this.state.currentTurn;

      if (this.result) {
        return this.result;
      }

      if (onStep) await onStep(this.state);

      if (!goToNextTurn) {
        return null;
      }
    }
  }

  /**
   * Immediately ends the scenario with a success verdict.
   *
   * This method forces the scenario to end successfully, regardless of the current
   * conversation state. It's useful for scenarios where you want to explicitly
   * mark success based on specific conditions or external factors.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param reasoning - Optional explanation for why the scenario is being marked as successful
   * @returns A promise that resolves with the final successful scenario result
   *
   * @example
   * ```typescript
   * // Mark success with default reasoning
   * const result = await execution.succeed();
   *
   * // Mark success with custom reasoning
   * const result = await execution.succeed(
   *   "User successfully completed the onboarding flow"
   * );
   * ```
   */
  async succeed(reasoning?: string): Promise<ScenarioResult> {
    return this.setResult({
      success: true,
      reasoning:
        reasoning || "Scenario marked as successful with Scenario.succeed()",
      metCriteria: [],
      unmetCriteria: [],
    });
  }

  /**
   * Immediately ends the scenario with a failure verdict.
   *
   * This method forces the scenario to end with failure, regardless of the current
   * conversation state. It's useful for scenarios where you want to explicitly
   * mark failure based on specific conditions or external factors.
   *
   * This method is part of the ScenarioExecutionLike interface used by script steps.
   *
   * @param reasoning - Optional explanation for why the scenario is being marked as failed
   * @returns A promise that resolves with the final failed scenario result
   *
   * @example
   * ```typescript
   * // Mark failure with default reasoning
   * const result = await execution.fail();
   *
   * // Mark failure with custom reasoning
   * const result = await execution.fail(
   *   "Agent failed to provide accurate weather information"
   * );
   * ```
   */
  async fail(reasoning?: string): Promise<ScenarioResult> {
    return this.setResult({
      success: false,
      reasoning: reasoning || "Scenario marked as failed with Scenario.fail()",
      metCriteria: [],
      unmetCriteria: [],
    });
  }

  /**
   * Adds execution time for a specific agent to the performance tracking.
   *
   * This method is used internally to track how long each agent takes to respond,
   * which is included in the final scenario result for performance analysis.
   * The accumulated time for each agent is used to calculate total agent response
   * times in the scenario result.
   *
   * @param agentIdx - The index of the agent in the agents array
   * @param time - The execution time in milliseconds to add to the agent's total
   *
   * @example
   * ```typescript
   * // This is typically called internally by the execution engine
   * execution.addAgentTime(0, 1500); // Agent at index 0 took 1.5 seconds
   * ```
   */
  addAgentTime(agentIdx: number, time: number): void {
    const currentTime = this.agentTimes.get(agentIdx) || 0;

    this.agentTimes.set(agentIdx, currentTime + time);
  }

  /**
   * Internal method to handle script step calls to agents.
   *
   * This method is the core logic for executing script steps that involve agent
   * interactions. It handles finding the appropriate agent for the given role,
   * managing turn progression, and executing the agent's response.
   *
   * The method will:
   * - Find the next available agent for the specified role
   * - Progress to a new turn if no agent is available
   * - Execute the agent with the provided content or let it generate content
   * - Handle judgment requests for judge agents
   * - Set the result if the agent makes a decision
   *
   * @param role - The role of the agent to call (USER, AGENT, or JUDGE)
   * @param content - Optional content to use instead of letting the agent generate it
   * @param judgmentRequest - Whether this is a judgment request (for judge agents)
   * @returns A promise that resolves with a ScenarioResult if the agent makes a final
   *          decision, or null if the conversation should continue
   * @throws Error if no agent is found for the specified role
   */
  private async scriptCallAgent(
    role: AgentRole,
    content?: string | ModelMessage,
    judgmentRequest?: JudgmentRequest
  ): Promise<ScenarioResult | null> {
    this.logger.debug(`[${this.config.id}] scriptCallAgent`, {
      role,
      hasContent: content !== undefined,
      judgmentRequest: judgmentRequest != null,
      hasInlineCriteria: judgmentRequest?.criteria != null,
    });

    this.consumeUntilRole(role);

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

    const index = nextAgent.index;
    const agent = nextAgent.agent;

    this.removePendingAgent(agent);

    if (content) {
      const message =
        typeof content === "string"
          ? ({
              role: role === AgentRole.USER ? "user" : "assistant",
              content,
            } as ModelMessage)
          : content;
      this.state.addMessage(message);
      this.broadcastMessage(message, index);

      return null;
    }

    await this.callAgent(index, role, judgmentRequest);

    // Handle inline criteria checkpoint semantics
    if (this.result && judgmentRequest?.criteria != null) {
      this.checkpointResults.push({
        metCriteria: this.result.metCriteria,
        unmetCriteria: this.result.unmetCriteria,
      });

      if (this.result.success) {
        // Checkpoint passed: clear result, continue script
        this._result = undefined;
        return null;
      } else {
        // Checkpoint failed: compile all results into the failing result.
        const cp = this.compiledCheckpoints;
        this.result.metCriteria = cp.metCriteria;
        this.result.unmetCriteria = cp.unmetCriteria;
        return this.result;
      }
    }

    // Final judge evaluation — merge prior checkpoint criteria
    if (this.result) {
      const cp = this.compiledCheckpoints;
      this.result.metCriteria = [...cp.metCriteria, ...this.result.metCriteria];
    }

    return this.result ?? null;
  }

  /**
   * Resets the scenario execution to its initial state.
   *
   * This method is called at the beginning of each execution to ensure a clean
   * state. It creates a new execution state, initializes agents, sets up the
   * first turn, and clears any pending messages or partial results.
   *
   * The reset process:
   * - Creates a new ScenarioExecutionState with the current config
   * - Sets up the thread ID (generates new one if not provided)
   * - Initializes all agents
   * - Initializes turn state (pending agents/roles) without creating a trace span
   * - Records the start time for performance tracking
   * - Clears any pending messages
   * - Clears the result from any previous execution
   */
  private reset(): void {
    this.logger.debug(`[${this.config.id}] Resetting scenario execution`);

    // End any existing turn span
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }

    this.state = new ScenarioExecutionState(this.config);
    this.state.threadId = this.config.threadId || generateThreadId();
    this.setAgents(this.config.agents);
    // Initialize turn state without creating a span yet. execute() calls
    // newTurn() immediately after reset() to create the Turn 1 span.
    this.pendingAgentsOnTurn = new Set(this.agents);
    this.pendingRolesOnTurn = [AgentRole.USER, AgentRole.AGENT, AgentRole.JUDGE];
    this.state.currentTurn = 0;
    this.totalStartTime = Date.now();
    this.pendingMessages.clear();
    this._result = undefined;
    this.checkpointResults = [];

    this.logger.debug(`[${this.config.id}] Reset complete`, {
      threadId: this.state.threadId,
      agentCount: this.agents.length,
    });
  }

  /** Compiles all accumulated checkpoint results into aggregated met/unmet criteria. */
  private get compiledCheckpoints(): { metCriteria: string[]; unmetCriteria: string[] } {
    const metCriteria: string[] = [];
    const unmetCriteria: string[] = [];
    for (const cp of this.checkpointResults) {
      metCriteria.push(...cp.metCriteria);
      unmetCriteria.push(...cp.unmetCriteria);
    }
    return { metCriteria, unmetCriteria };
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

  /**
   * Starts a new turn in the scenario execution.
   *
   * This method is called when transitioning to a new turn. It resets the pending
   * agents and roles for the turn, allowing all agents to participate again in
   * the new turn. The turn counter is incremented to track the current turn number.
   *
   * A turn represents a cycle where agents can take actions. Each turn can involve
   * multiple agent interactions as agents respond to each other's messages.
   */
  private newTurn(): void {
    const previousTurn = this.state.currentTurn;

    // End previous turn span if it exists
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }

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

    this.logger.debug(`[${this.config.id}] New turn started`, {
      previousTurn,
      currentTurn: this.state.currentTurn,
      agentCount: this.agents.length,
    });

    // Create new turn trace context (equivalent to Python's langwatch.trace())
    this.currentTurnSpan = this.tracer.startSpan("Scenario Turn", {
      attributes: {
        "langwatch.origin": "simulation",
        "scenario.run_id": this.scenarioRunId ?? "",
        "scenario.name": this.config.name,
        "scenario.id": this.config.id,
        [attributes.ATTR_LANGWATCH_THREAD_ID]: this.state.threadId,
        "scenario.turn": this.state.currentTurn,
      },
    });
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
      this.pendingRolesOnTurn.shift();
    }
  }

  /**
   * Creates a failure result when the maximum number of turns is reached.
   *
   * This method is called when the scenario execution reaches the maximum number
   * of turns without reaching a conclusion. It creates a failure result with
   * appropriate reasoning and includes performance metrics, then sets it on this.result.
   *
   * The result includes:
   * - All messages from the conversation
   * - Failure reasoning explaining the turn limit was reached
   * - Empty met criteria (since no conclusion was reached)
   * - All judge criteria as unmet (since no evaluation was completed)
   * - Total execution time and agent response times
   *
   * @param errorMessage - Optional custom error message to use instead of the default
   */
  private reachedMaxTurns(errorMessage?: string): ScenarioResult {
    return this.setResult({
      success: false,
      reasoning:
        errorMessage ||
        `Reached maximum turns (${
          this.config.maxTurns || 10
        }) without conclusion`,
      metCriteria: [],
      unmetCriteria: this.getJudgeAgent()?.criteria ?? [],
    });
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
      batchRunId: this.batchRunId,
      scenarioId: this.config.id,
      scenarioRunId,
      scenarioSetId: this.config.setId ?? "default",
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
        ...this.config.metadata,
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
      messages: convertModelMessagesToAguiMessages(this.state.messages),
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

    // End the final turn span
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }
  }

  /**
   * Distributes a message to all other agents in the scenario.
   *
   * This method implements the message broadcasting system that allows agents to
   * "hear" messages from other agents. When an agent sends a message, it needs to
   * be distributed to all other agents so they can respond appropriately.
   *
   * The broadcasting process:
   * 1. Iterates through all agents in the scenario
   * 2. Skips the agent that sent the message (to avoid echo)
   * 3. Adds the message to each agent's pending message queue
   * 4. Agents will receive these messages when they're called next
   *
   * This creates a realistic conversation environment where agents can see
   * the full conversation history and respond contextually.
   *
   * @param message - The message to broadcast to all other agents
   * @param fromAgentIdx - The index of the agent that sent the message (to avoid echoing back to sender)
   *
   * @example
   * ```typescript
   * // When agent 0 sends a message, it gets broadcast to agents 1 and 2
   * execution.broadcastMessage(
   *   { role: "user", content: "Hello" },
   *   0 // fromAgentIdx
   * );
   * // Now agents 1 and 2 have this message in their pendingMessages queue
   * ```
   */
  private broadcastMessage(message: ModelMessage, fromAgentIdx?: number): void {
    const recipients: number[] = [];

    for (let idx = 0; idx < this.agents.length; idx++) {
      if (idx === fromAgentIdx) continue;

      if (!this.pendingMessages.has(idx)) {
        this.pendingMessages.set(idx, []);
      }
      this.pendingMessages.get(idx)!.push(message);
      recipients.push(idx);
    }

    this.logger.debug(`[${this.config.id}] Broadcast message`, {
      role: message.role,
      fromAgentIdx,
      recipients,
    });
  }

  /**
   * Executes a single script step with proper error handling and logging.
   *
   * This method is responsible for executing each script step function with
   * comprehensive error handling and logging. It provides the execution context
   * to the script step and handles any errors that occur during execution.
   *
   * The method:
   * - Logs the start of script step execution
   * - Calls the script step function with the current state and execution context
   * - Logs the completion of the script step
   * - Handles and logs any errors that occur
   * - Re-throws errors to maintain the original error context
   *
   * @param scriptStep - The script step function to execute (user, agent, judge, etc.)
   * @param stepIndex - The index of the script step for logging and debugging context
   * @returns The result of the script step execution (void, ScenarioResult, or null)
   * @throws Error if the script step throws an error (preserves original error)
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

      // Re-throw the error in case it was a vitest assertion error
      throw error;
    }
  }
}

/**
 * Converts agent return types to ModelMessage format.
 *
 * This utility function handles the various return types that agents can return
 * and converts them to a standardized ModelMessage format. Agents can return:
 * - A string (converted to a message with the specified role)
 * - An array of ModelMessage objects (returned as-is)
 * - A single ModelMessage object (wrapped in an array)
 * - Any other type (returns empty array)
 *
 * @param response - The response from an agent (string, ModelMessage, or array of ModelMessage)
 * @param role - The role to assign if the response is a string ("user" or "assistant")
 * @returns An array of ModelMessage objects
 */
function convertAgentReturnTypesToMessages(
  response: AgentReturnTypes,
  role: "user" | "assistant"
): ModelMessage[] {
  if (typeof response === "string")
    return [{ role, content: response } as ModelMessage];

  if (Array.isArray(response)) return response;

  if (response && typeof response === "object" && "role" in response)
    return [response];

  return [];
}

/**
 * Extracts structured error information for logging and reporting.
 *
 * This function takes any thrown error (unknown type) and returns an object
 * containing the error's name, message, and stack trace if available.
 * If the input is not an instance of Error, it provides a generic name and
 * stringified value for message.
 *
 * @param error - The error object or value to extract information from.
 * @returns An object with 'name', optional 'message', and optional 'stack' properties.
 */
function extractErrorInfo(error: unknown): {
  name: string;
  message?: string;
  stack?: string;
} {
  // Extracts error information in a structured way for logging and reporting.
  // Returns an object with name, message, and stack if available.
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  // If not an Error instance, provide a generic name and stringified value.
  return {
    name: typeof error,
    message: String(error),
  };
}
