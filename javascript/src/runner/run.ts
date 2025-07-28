/**
 * Scenario execution engine for agent testing.
 *
 * This file contains the core `run` function that orchestrates the execution
 * of scenario tests, managing the interaction between user simulators, agents under test,
 * and judge agents to determine test success or failure.
 */
import { AssistantContent, ToolContent, CoreMessage } from "ai";
import { Subscription } from "rxjs";
import { getEnv } from "../config";
import {
  allAgentRoles,
  AgentRole,
  ScenarioConfig,
  ScenarioResult,
} from "../domain";
import { EventBus } from "../events/event-bus";
import { ScenarioExecution } from "../execution";
import { proceed } from "../script";
import { generateThreadId } from "../utils/ids";

/**
 * High-level interface for running a scenario test.
 *
 * This is the main entry point for executing scenario tests. It creates a
 * ScenarioExecution instance and runs it.
 *
 * @param cfg Configuration for the scenario test.
 * @param cfg.name Human-readable name for the scenario.
 * @param cfg.description Detailed description of what the scenario tests.
 * @param cfg.agents List of agent adapters (agent under test, user simulator, judge).
 * @param cfg.maxTurns Maximum conversation turns before timeout (default: 10).
 * @param cfg.verbose Show detailed output during execution.
 * @param cfg.script Optional script steps to control scenario flow.
 * @param cfg.threadId Optional ID for the conversation thread.
 * @returns A promise that resolves with the ScenarioResult containing the test outcome,
 *          conversation history, success/failure status, and detailed reasoning.
 *
 * @example
 * ```typescript
 * import { run, AgentAdapter, AgentRole, user, agent } from '@langwatch/scenario';
 *
 * const myAgent: AgentAdapter = {
 *   role: AgentRole.AGENT,
 *   async call(input) {
 *     return `The user said: ${input.messages.at(-1)?.content}`;
 *   }
 * };
 *
 * async function main() {
 *   const result = await run({
 *     name: "Customer Service Test",
 *     description: "A simple test to see if the agent responds.",
 *     agents: [myAgent],
 *     script: [
 *       user("Hello, world!"),
 *       agent(),
 *     ],
 *   });
 *
 *   if (result.success) {
 *     console.log("Scenario passed!");
 *   } else {
 *     console.error(`Scenario failed: ${result.reasoning}`);
 *   }
 * }
 *
 * main();
 * ```
 */
export async function run(cfg: ScenarioConfig): Promise<ScenarioResult> {
  if (!cfg.name) {
    throw new Error("Scenario name is required");
  }
  if (!cfg.description) {
    throw new Error("Scenario description is required");
  }
  if ((cfg.maxTurns || 10) < 1) {
    throw new Error("Max turns must be at least 1");
  }
  if (cfg.agents.length === 0) {
    throw new Error("At least one agent is required");
  }
  if (!cfg.agents.find((agent) => agent.role === AgentRole.AGENT)) {
    throw new Error("At least one non-user/non-judge agent is required");
  }

  cfg.agents.forEach((agent, i) => {
    if (!allAgentRoles.includes(agent.role)) {
      throw new Error(`Agent ${i} has invalid role: ${agent.role}`);
    }
  });

  if (!cfg.threadId) {
    cfg.threadId = generateThreadId();
  }

  const steps = cfg.script || [proceed()];
  const execution = new ScenarioExecution(cfg, steps);

  let eventBus: EventBus | null = null;
  let subscription: Subscription | null = null;

  try {
    const envConfig = getEnv();
    eventBus = new EventBus({
      endpoint: envConfig.LANGWATCH_ENDPOINT,
      apiKey: envConfig.LANGWATCH_API_KEY,
    });
    eventBus.listen();

    subscription = eventBus.subscribeTo(execution.events$);

    const result = await execution.execute();
    if (cfg.verbose && !result.success) {
      console.log(`Scenario failed: ${cfg.name}`);
      console.log(`Reasoning: ${result.reasoning}`);
      console.log("--------------------------------");
      console.log(`Met criteria: ${result.metCriteria.join("\n- ")}`);
      console.log(`Unmet criteria: ${result.unmetCriteria.join("\n- ")}`);
      console.log(result.messages.map(formatMessage).join("\n"));
    }

    return result;
  } finally {
    await eventBus?.drain();
    subscription?.unsubscribe();
  }
}

function formatMessage(m: CoreMessage): string {
  switch (m.role) {
    case "user":
      return `User: ${m.content}`;
    case "assistant":
      return `Assistant: ${formatParts(m.content)}`;
    case "tool":
      return `Tool: ${formatParts(m.content)}`;

    default:
      return `${m.role}: ${m.content}`;
  }
}

function formatParts(part: AssistantContent | ToolContent): string {
  if (typeof part === "string") {
    return part;
  }

  if (Array.isArray(part)) {
    if (part.length === 1) {
      return formatPart(part[0]);
    }

    return `\n${part.map(formatPart).join("\n")}`;
  }

  return "Unknown content: " + JSON.stringify(part);
}

function formatPart(
  part: (Exclude<AssistantContent, string> | ToolContent)[number]
): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "file":
      return `(file): ${part.filename} ${
        typeof part.data === "string" ? `url:${part.data}` : "base64:omitted"
      }`;
    case "tool-call":
      return `(tool call): ${part.toolName} id:${
        part.toolCallId
      } args:(${JSON.stringify(part.args)})`;
    case "tool-result":
      return `(tool result): ${part.toolName} id:${
        part.toolCallId
      } result:(${JSON.stringify(part.result)})`;
    case "reasoning":
      return `(reasoning): ${part.text}`;
    case "redacted-reasoning":
      return `(redacted reasoning): ${part.data}`;
    default:
      return `Unknown content: ${JSON.stringify(part)}`;
  }
}
