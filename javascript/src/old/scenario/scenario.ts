import { generate } from "xksuid";
import { EventReporter } from "../../event-reporter";
import { ConversationRunner } from "../conversation";
import { MaxTurnsExceededError } from "../conversation/errors";
import { ScenarioEventBus } from "../event-bus";
import { getBatchId } from "../lib";
import {
  ScenarioEventType,
  ScenarioRunStatus,
  type ScenarioRunFinishedEvent,
  type ScenarioMessageSnapshotEvent,
} from "../schemas";
import {
  type ScenarioConfig,
  type ScenarioResult,
  type RunOptions,
  Verdict,
} from "../shared/types";
import { formatScenarioResult } from "../shared/utils/logging";
import { ScenarioTestingAgent } from "../testing-agent";

const PROCESS_BATCH_ID = getBatchId();

/**
 * Represents a test scenario for evaluating AI agent behavior.
 *
 * This class encapsulates the configuration and execution of a test scenario,
 * providing a way to run conversations between a testable agent and a testing agent
 * that simulates user behavior according to a defined strategy.
 */
export class Scenario {
  private _scenarioTestingAgent: ScenarioTestingAgent | null = null;

  private scenarioId = "scenario_" + generate();
  private eventReporter = new EventReporter();
  private eventBus = new ScenarioEventBus(this.eventReporter);

  /**
   * Creates a new scenario with the specified configuration.
   *
   * @param config - The configuration that defines the scenario's behavior,
   *                 including description, strategy, and success/failure criteria
   */
  constructor(public readonly config: ScenarioConfig) {}

  /**
   * Gets the testing agent instance, creating it if it doesn't exist yet.
   * Uses lazy initialization to avoid creating the agent until needed.
   *
   * @returns The ScenarioTestingAgent instance for this scenario
   */
  get scenarioTestingAgent(): ScenarioTestingAgent {
    return (this._scenarioTestingAgent ??= new ScenarioTestingAgent(
      this.config
    ));
  }

  public setScenarioTestingAgent(agent: ScenarioTestingAgent): Scenario {
    this._scenarioTestingAgent = agent;
    return this;
  }

  /**
   * Runs the scenario with the provided agent and options.
   *
   * @param options - Configuration for this specific run:
   *   - agent: The testable agent to evaluate
   *   - maxTurns: Maximum conversation turns before ending (defaults to 2)
   *
   * @returns A ScenarioResult containing the outcome of the test, including
   *          success/failure status, conversation history, and reasoning
   */
  public async run({
    agent,
    maxTurns = 2,
    onMessages,
    onFinish,
  }: RunOptions): Promise<ScenarioResult> {
    const scenarioRunId = "scenariorun_" + generate();

    // Start the event bus processing pipeline
    this.eventBus.listen();

    // Emit start event
    this.eventBus.publish({
      type: ScenarioEventType.RUN_STARTED,
      batchRunId: PROCESS_BATCH_ID,
      scenarioId: this.scenarioId,
      scenarioRunId,
      timestamp: Date.now(),
    });

    const testingAgent = this.scenarioTestingAgent;

    const forceFinishTestMessage = `System:
<finish_test>
This is the last message, conversation has reached the maximum number of turns, give your final verdict,
if you don't have enough information to make a verdict, say inconclusive with max turns reached.
</finish_test>`;

    const runner = new ConversationRunner({
      agent,
      testingAgent,
      maxTurns,
      forceFinishTestMessage,
    });

    runner.on("messages", (messages) => {
      const messageSnapshotEvent: ScenarioMessageSnapshotEvent = {
        type: ScenarioEventType.MESSAGE_SNAPSHOT,
        batchRunId: PROCESS_BATCH_ID,
        scenarioId: this.scenarioId,
        scenarioRunId,
        messages: messages.map((message) => ({
          id: `message_${generate()}`,
          role: message.role as "user" | "assistant",
          content: message.content as string,
        })),
        timestamp: Date.now(),
      };

      this.eventBus.publish(messageSnapshotEvent);

      onMessages?.(messages);
    });

    runner.on("finish", (result) => {
      const runFinishedEvent: ScenarioRunFinishedEvent = {
        type: ScenarioEventType.RUN_FINISHED,
        batchRunId: PROCESS_BATCH_ID,
        scenarioId: this.scenarioId,
        scenarioRunId,
        status:
          result.verdict === Verdict.Success
            ? ScenarioRunStatus.SUCCESS
            : ScenarioRunStatus.FAILED,
        timestamp: Date.now(),
      };

      this.eventBus.publish(runFinishedEvent);

      onFinish?.({
        ...result,
        ...this.config,
        ...testingAgent.getTestingAgentConfig(),
        forceFinishTestMessage,
      });
    });

    try {
      const result = await runner.run();

      if (process.env.VERBOSE === "true") {
        formatScenarioResult(result);
      }

      return result;
    } catch (error) {
      this.eventBus.publish({
        type: ScenarioEventType.RUN_FINISHED,
        batchRunId: PROCESS_BATCH_ID,
        scenarioId: this.scenarioId,
        scenarioRunId,
        status: ScenarioRunStatus.CANCELLED,
        timestamp: Date.now(),
      });

      if (error instanceof MaxTurnsExceededError) {
        if (process.env.VERBOSE === "true") {
          console.log(
            "Max turns exceeded. Conversation history:",
            runner.messages
          );
        }

        throw error;
      }

      throw error;
    } finally {
      // Wait for the final event to be processed and drain the event bus
      await this.eventBus.drain();
    }
  }

  public static user(prompt: string) {
    return null;
  }
}
