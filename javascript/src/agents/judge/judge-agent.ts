import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  ModelMessage,
  ToolSet,
  Tool,
  ToolChoice,
  tool,
  stepCountIs,
  hasToolCall,
} from "ai";
import { z } from "zod/v4";

import { JudgeUtils } from "./judge-utils";
import { estimateTokens, DEFAULT_TOKEN_THRESHOLD } from "./estimate-tokens";
import { expandTrace, grepTrace } from "./trace-tools";
import { getProjectConfig } from "../../config";
import { AgentInput, JudgeAgentAdapter, AgentRole } from "../../domain";
import { modelSchema } from "../../domain/core/schemas/model.schema";
import { Logger } from "../../utils/logger";
import { createLLMInvoker } from "../llm-invoker.factory";
import {
  TestingAgentConfig,
  FinishTestArgs,
  InvokeLLMParams,
  InvokeLLMResult,
} from "../types";
import { criterionToParamName } from "../utils";

import { JudgeResult } from "./interfaces";
import { judgeSpanCollector, JudgeSpanCollector } from "./judge-span-collector";
import { judgeSpanDigestFormatter } from "./judge-span-digest-formatter";

/**
 * Configuration for the judge agent.
 */
export interface JudgeAgentConfig extends TestingAgentConfig {
  /**
   * A custom system prompt to override the default behavior of the judge.
   */
  systemPrompt?: string;
  /**
   * The criteria that the judge will use to evaluate the conversation.
   */
  criteria?: string[];
  /**
   * Optional span collector for telemetry. Defaults to global singleton.
   */
  spanCollector?: JudgeSpanCollector;
  /**
   * Token threshold for switching to structure-only trace rendering.
   * When the full trace digest exceeds this estimated token count,
   * the judge receives a structure-only view with expand_trace and
   * grep_trace tools for progressive discovery.
   *
   * @default 8192
   */
  tokenThreshold?: number;
  /**
   * Maximum number of tool-calling steps for progressive trace discovery.
   * Only applies when the trace exceeds the token threshold.
   *
   * @default 10
   */
  maxDiscoverySteps?: number;
}

function buildSystemPrompt(criteria: string[], description: string): string {
  const criteriaList =
    criteria?.map((criterion, idx) => `${idx + 1}. ${criterion}`).join("\n") ||
    "No criteria provided";

  return `
<role>
You are an LLM as a judge watching a simulated conversation as it plays out live to determine if the agent under test meets the criteria or not.
</role>

<goal>
Your goal is to determine if you already have enough information to make a verdict of the scenario below, or if the conversation should continue for longer.
If you do have enough information, use the finish_test tool to determine if all the criteria have been met, if not, use the continue_test tool to let the next step play out.
</goal>

<scenario>
${description}
</scenario>

<criteria>
${criteriaList}
</criteria>

<rules>
- Be strict, do not let the conversation continue if the agent already broke one of the "do not" or "should not" criteria.
- DO NOT make any judgment calls that are not explicitly listed in the success or failure criteria, withhold judgement if necessary
</rules>
`.trim();
}

function buildContinueTestTool(): Tool {
  return tool({
    description: "Continue the test with the next step",
    inputSchema: z.object({}),
  });
}

function buildFinishTestTool(criteria: string[]): Tool {
  const criteriaNames = criteria.map(criterionToParamName);

  return tool({
    description: "Complete the test with a final verdict",
    inputSchema: z.object({
      criteria: z
        .object(
          Object.fromEntries(
            criteriaNames.map((name, idx) => [
              name,
              z.enum(["true", "false", "inconclusive"]).describe(criteria[idx]),
            ])
          )
        )
        .strict()
        .describe("Strict verdict for each criterion"),
      reasoning: z
        .string()
        .describe("Explanation of what the final verdict should be"),
      verdict: z
        .enum(["success", "failure", "inconclusive"])
        .describe("The final verdict of the test"),
    }),
  });
}

/**
 * Builds the expand_trace and grep_trace tools for progressive trace discovery.
 * These tools allow the judge to drill into large traces on demand rather than
 * receiving the entire trace content upfront.
 *
 * @param spans - The full array of ReadableSpan objects for the trace
 * @returns ToolSet containing expand_trace and grep_trace tools
 */
function buildProgressiveDiscoveryTools(spans: ReadableSpan[]): ToolSet {
  return {
    expand_trace: tool({
      description:
        "Expand one or more spans to see their full details (attributes, events, content). Use a single index like 5 or a range like '10-15'.",
      inputSchema: z.object({
        index: z
          .number()
          .optional()
          .describe("Single span index to expand"),
        range: z
          .string()
          .optional()
          .describe('Range of span indices to expand, e.g. "10-15"'),
      }),
      execute: async ({ index, range }) => {
        return expandTrace(spans, { index, range });
      },
    }),
    grep_trace: tool({
      description:
        "Search across all span attributes, events, and content for a pattern (case-insensitive). Returns matching spans with context.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("Search pattern (case-insensitive)"),
      }),
      execute: async ({ pattern }) => {
        return grepTrace(spans, pattern);
      },
    }),
  };
}

/**
 * Agent that evaluates conversations against success criteria.
 *
 * This is the default judge agent that is used if no judge agent is provided.
 * It is a simple agent that uses function calling to make structured decisions
 * and provides detailed reasoning for its verdicts.
 *
 * @param cfg {JudgeAgentConfig} Configuration for the judge agent.
 */
class JudgeAgent extends JudgeAgentAdapter {
  private logger = new Logger("JudgeAgent");
  private readonly spanCollector: JudgeSpanCollector;
  private readonly tokenThreshold: number;
  private readonly maxDiscoverySteps: number;
  role: AgentRole = AgentRole.JUDGE;
  criteria: string[];

  /**
   * LLM invocation function. Can be overridden to customize LLM behavior.
   */
  invokeLLM: (params: InvokeLLMParams) => Promise<InvokeLLMResult> =
    createLLMInvoker(this.logger);

  constructor(private readonly cfg: JudgeAgentConfig) {
    super();
    this.criteria = cfg.criteria ?? [];
    this.spanCollector = cfg.spanCollector ?? judgeSpanCollector;
    this.tokenThreshold = cfg.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    this.maxDiscoverySteps = cfg.maxDiscoverySteps ?? 10;
  }

  async call(input: AgentInput): Promise<JudgeResult | null> {
    const criteria = input.judgmentRequest?.criteria ?? this.criteria;

    this.logger.debug("call() invoked", {
      threadId: input.threadId,
      currentTurn: input.scenarioState.currentTurn,
      maxTurns: input.scenarioConfig.maxTurns,
      judgmentRequest: input.judgmentRequest,
    });

    const spans = this.spanCollector.getSpansForThread(input.threadId);
    const { digest, isLargeTrace } = this.buildTraceDigest(spans);

    const transcript = JudgeUtils.buildTranscriptFromMessages(input.messages);

    const contentForJudge = `
    <transcript>
    ${transcript}
    </transcript>
    <opentelemetry_traces>
    ${digest}
    </opentelemetry_traces>
    `;

    const cfg = this.cfg;

    const systemPrompt =
      cfg.systemPrompt ??
      buildSystemPrompt(criteria, input.scenarioConfig.description);
    const messages: ModelMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: contentForJudge },
    ];

    const isLastMessage =
      input.scenarioState.currentTurn === input.scenarioConfig.maxTurns;

    const projectConfig = await getProjectConfig();
    const mergedConfig = modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...cfg,
    });

    const tools: ToolSet = {
      continue_test: buildContinueTestTool(),
      finish_test: buildFinishTestTool(criteria),
      ...(isLargeTrace ? buildProgressiveDiscoveryTools(spans) : {}),
    };

    const enforceJudgement = input.judgmentRequest != null;
    const hasCriteria = criteria.length && criteria.length > 0;

    if (enforceJudgement && !hasCriteria) {
      return {
        success: false,
        reasoning: "JudgeAgent: No criteria was provided to be judged against",
        metCriteria: [],
        unmetCriteria: [],
      };
    }

    const toolChoice: ToolChoice<typeof tools> =
      (isLastMessage || enforceJudgement) && hasCriteria
        ? { type: "tool", toolName: "finish_test" }
        : "required";

    this.logger.debug("Calling LLM", {
      model: mergedConfig.model,
      toolChoice,
      isLastMessage,
      enforceJudgement,
      isLargeTrace,
    });

    const completion = await this.invokeLLMWithDiscovery({
      model: mergedConfig.model,
      messages,
      temperature: mergedConfig.temperature ?? 0.0,
      maxOutputTokens: mergedConfig.maxTokens,
      tools,
      toolChoice,
      isLargeTrace,
    });

    return this.parseToolCalls(completion, criteria);
  }

  /**
   * Builds the trace digest, choosing between full inline rendering
   * and structure-only mode based on estimated token count.
   */
  private buildTraceDigest(spans: ReadableSpan[]): {
    digest: string;
    isLargeTrace: boolean;
  } {
    const fullDigest = judgeSpanDigestFormatter.format(spans);
    const isLargeTrace =
      spans.length > 0 && estimateTokens(fullDigest) > this.tokenThreshold;

    const digest = isLargeTrace
      ? judgeSpanDigestFormatter.formatStructureOnly(spans) +
        "\n\nUse expand_trace(spanIndex) to see span details or grep_trace(pattern) to search across spans."
      : fullDigest;

    this.logger.debug("Trace digest built", {
      isLargeTrace,
      estimatedTokens: estimateTokens(fullDigest),
    });

    return { digest, isLargeTrace };
  }

  /**
   * Invokes the LLM, enabling multi-step tool execution for large traces.
   * In multi-step mode, the AI SDK loops automatically: the judge can call
   * expand_trace/grep_trace tools multiple times before reaching a terminal
   * tool (finish_test/continue_test) or hitting the step limit.
   */
  private async invokeLLMWithDiscovery({
    isLargeTrace,
    ...params
  }: InvokeLLMParams & { isLargeTrace: boolean }): Promise<InvokeLLMResult> {
    if (isLargeTrace) {
      params.stopWhen = [
        stepCountIs(this.maxDiscoverySteps),
        hasToolCall("finish_test"),
        hasToolCall("continue_test"),
      ];
    }

    const completion = await this.invokeLLM(params);

    this.logger.debug("LLM response received", {
      toolCallCount: completion.toolCalls?.length ?? 0,
      toolCalls: completion.toolCalls?.map((tc) => ({
        toolName: tc.toolName,
        args: tc.input,
      })),
    });

    return completion;
  }

  private parseToolCalls(
    completion: InvokeLLMResult,
    criteria: string[]
  ): JudgeResult | null {
    let args: FinishTestArgs | undefined;
    if (completion.toolCalls?.length) {
      // In multi-step mode, find the terminal tool call (finish_test or continue_test)
      const terminalCall = completion.toolCalls.find(
        (tc) =>
          tc.toolName === "finish_test" || tc.toolName === "continue_test"
      );
      const toolCall = terminalCall ?? completion.toolCalls[0];

      switch (toolCall.toolName) {
        case "finish_test": {
          args = toolCall.input as FinishTestArgs;

          const verdict = args.verdict || "inconclusive";
          const reasoning = args.reasoning || "No reasoning provided";
          const criteriaArgs = args.criteria || {};
          const criteriaValues = Object.values(criteriaArgs);
          const metCriteria = criteria.filter(
            (_, i) => criteriaValues[i] === "true"
          );
          const unmetCriteria = criteria.filter(
            (_, i) => criteriaValues[i] !== "true"
          );

          const result = {
            success: verdict === "success",
            reasoning,
            metCriteria,
            unmetCriteria,
          };
          this.logger.debug("finish_test result", result);
          return result;
        }

        case "continue_test":
          this.logger.debug("continue_test - proceeding to next turn");
          return null;

        default:
          return {
            success: false,
            reasoning: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
            metCriteria: [],
            unmetCriteria: criteria,
          };
      }
    }

    return {
      success: false,
      reasoning: `JudgeAgent: No tool call found in LLM output`,
      metCriteria: [],
      unmetCriteria: criteria,
    };
  }
}

/**
 * Factory function for creating JudgeAgent instances.
 *
 * JudgeAgent evaluates conversations against success criteria.
 *
 * The JudgeAgent watches conversations in real-time and makes decisions about
 * whether the agent under test is meeting the specified criteria. It can either
 * allow the conversation to continue or end it with a success/failure verdict.
 *
 * The judge uses function calling to make structured decisions and provides
 * detailed reasoning for its verdicts. It evaluates each criterion independently
 * and provides comprehensive feedback about what worked and what didn't.
 *
 * @param cfg Configuration for the judge agent.
 * @param cfg.criteria List of success criteria to evaluate against.
 * @param cfg.model Optional The language model to use for generating responses.
 * @param cfg.temperature Optional The temperature to use for the model.
 * @param cfg.maxTokens Optional The maximum number of tokens to generate.
 * @param cfg.systemPrompt Optional Custom system prompt to override default judge behavior.
 *
 * @example
 * ```typescript
 * import { run, judgeAgent, AgentRole, user, agent, AgentAdapter } from '@langwatch/scenario';
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
 *     name: "Judge Agent Test",
 *     description: "A simple test to see if the judge agent works.",
 *     agents: [
 *       myAgent,
 *       judgeAgent({
 *         criteria: ["The agent must respond to the user."],
 *       }),
 *     ],
 *     script: [
 *       user("Hello!"),
 *       agent(),
 *     ],
 *   });
 * }
 * main();
 * ```
 */
export const judgeAgent = (cfg?: JudgeAgentConfig) => {
  return new JudgeAgent(cfg ?? {});
};
