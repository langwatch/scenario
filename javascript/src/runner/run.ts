/**
 * Scenario execution engine for agent testing.
 *
 * Orchestrates the execution of scenario tests, managing user simulators,
 * agents under test, and judge agents. Each `run()` call creates an isolated
 * EventBus, enabling safe concurrent execution with different configs.
 *
 * @see docs/adr/001-scenario-concurrency-model.md
 */
import { AssistantContent, ToolContent, ModelMessage } from "ai";
import { Subscription } from "rxjs";
import { getEnv } from "../config";
import {
  allAgentRoles,
  AgentRole,
  LangwatchConfig,
  ScenarioConfig,
  ScenarioResult,
} from "../domain";
import type { VoiceConfig } from "../voice/config";
import { EventBus } from "../events/event-bus";
import { ScenarioExecution } from "../execution";
import { proceed } from "../script";
import { generateThreadId, getBatchRunId } from "../utils/ids";
import { judgeSpanCollector } from "../agents/judge/judge-span-collector";
import { ensureTracingInitialized } from "../tracing/setup";
import { getProjectConfig } from "../config/get-project-config";
/**
 * Options for running a scenario.
 */
export interface RunOptions {
  /** LangWatch configuration for event reporting. Overrides environment variables. */
  langwatch?: LangwatchConfig;
  /** Batch run ID for grouping scenario runs. Overrides SCENARIO_BATCH_RUN_ID env var. */
  batchRunId?: string;
  /**
   * Pre-assigned run ID for the scenario execution.
   * When provided, the SDK uses this ID instead of generating a new one.
   *
   * @internal Platform use only — not part of the public API.
   */
  runId?: string;

  /**
   * Per-invocation voice config override (ADR-002). Seeds `cfg.voice` at the
   * `run()` boundary (`options?.voice ?? cfg.voice`) so the carrier that
   * reaches every `call()` — `ScenarioConfig.voice` — reflects the override.
   * Unlike `langwatch` (read once here), voice config must ride on
   * `ScenarioConfig` because its consumers (judge STT / simulator TTS) run
   * inside `call()`.
   */
  voice?: VoiceConfig;
}

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
export async function run(cfg: ScenarioConfig, options?: RunOptions): Promise<ScenarioResult> {
  if (!cfg.name) {
    throw new Error("Scenario name is required");
  }
  if (!cfg.description) {
    throw new Error("Scenario description is required");
  }
  if (cfg.maxTurns && cfg.maxTurns < 1) {
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

  // Seed the per-run voice carrier (ADR-002): the optional RunOptions.voice
  // override wins field-by-field over ScenarioConfig.voice, and the merged
  // result lives on cfg.voice — the only per-run object that reaches every
  // call() (via AgentInput.scenarioConfig). The provider/format/judge knobs
  // are then resolved per-run by the executor via resolveVoiceConfig().
  if (options?.voice || cfg.voice) {
    cfg.voice = { ...cfg.voice, ...options?.voice };
  }

  const steps = cfg.script || [proceed()];

  const batchRunId = options?.batchRunId ?? getBatchRunId();
  const execution = new ScenarioExecution(cfg, steps, batchRunId, options?.runId);

  let eventBus: EventBus | null = null;
  let subscription: Subscription | null = null;

  try {
    // Lazily initialize tracing using project config observability options
    const projectConfig = await getProjectConfig();
    ensureTracingInitialized(projectConfig?.observability);

    const envConfig = getEnv();
    // Priority: options.langwatch > cfg.langwatch > env vars
    eventBus = new EventBus({
      endpoint: options?.langwatch?.endpoint ?? cfg.langwatch?.endpoint ?? envConfig.LANGWATCH_ENDPOINT,
      apiKey: options?.langwatch?.apiKey ?? cfg.langwatch?.apiKey ?? envConfig.LANGWATCH_API_KEY,
      projectId: options?.langwatch?.projectId ?? cfg.langwatch?.projectId,
    });
    eventBus.listen();

    subscription = eventBus.subscribeTo(execution.events$);

    const startedAt = Date.now();
    const result = await execution.execute();
    if (cfg.verbose && !result.success) {
      console.log(`Scenario failed: ${cfg.name}`);
      console.log(`Reasoning: ${result.reasoning}`);
      console.log("--------------------------------");
      console.log(`Met criteria: ${result.metCriteria.join("\n- ")}`);
      console.log(`Unmet criteria: ${result.unmetCriteria.join("\n- ")}`);
      console.log(result.messages.map(formatMessage).join("\n"));
    }

    // Auto-save red-team report when a RedTeamAgent participated.
    // Opt out with SCENARIO_REDTEAM_REPORT=0. See docs for details.
    try {
      const { isRedTeamAgent, saveRedTeamReport } = await import(
        "../red-team-report"
      );
      const redTeam = cfg.agents.find((a) => isRedTeamAgent(a));
      if (redTeam) {
        saveRedTeamReport({
          result,
          redTeam: redTeam as Parameters<typeof saveRedTeamReport>[0]["redTeam"],
          testName: cfg.name,
          scenarioConfig: cfg,
          elapsedSeconds: (Date.now() - startedAt) / 1000,
        });
      }
    } catch (e) {
      // Don't let reporting failures break the scenario run.
      // eslint-disable-next-line no-console
      console.warn(`[scenario] red-team auto-save skipped: ${(e as Error).message}`);
    }

    return result;
  } finally {
    await eventBus?.drain();
    subscription?.unsubscribe();
    if (cfg.threadId) {
      judgeSpanCollector.clearSpansForThread(cfg.threadId);
    }
  }
}

function formatMessage(m: ModelMessage): string {
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
      } args:(${JSON.stringify(part.input)})`;
    case "tool-result":
      return `(tool result): ${part.toolName} id:${
        part.toolCallId
      } result:(${JSON.stringify(part.output)})`;
    case "reasoning":
      return `(reasoning): ${part.text}`;
    default:
      return `Unknown content: ${JSON.stringify(part)}`;
  }
}
