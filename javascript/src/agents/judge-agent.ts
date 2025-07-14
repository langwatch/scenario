import { generateText, CoreMessage, ToolSet, Tool, ToolChoice, tool } from "ai";
import { z } from "zod";
import { AgentInput, JudgeAgentAdapter, AgentRole } from "../domain";
import { TestingAgentConfig, FinishTestArgs } from "./types";
import { criterionToParamName } from "./utils";
import { getProjectConfig } from "../config";
import { ScenarioResult } from "../domain/core/execution";
import { mergeAndValidateConfig } from "../utils/config";
import { Logger } from "../utils/logger";

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
  criteria: string[];
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
    parameters: z.object({}),
  });
}

function buildFinishTestTool(criteria: string[]): Tool {
  const criteriaNames = criteria.map(criterionToParamName);

  return tool({
    description: "Complete the test with a final verdict",
    parameters: z.object({
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
  role: AgentRole = AgentRole.JUDGE;
  criteria: string[];

  constructor(private readonly cfg: JudgeAgentConfig) {
    super();
    this.criteria = cfg.criteria;
    this.role = AgentRole.JUDGE;
  }

  async call(input: AgentInput) {
    const cfg = this.cfg;

    const systemPrompt =
      cfg.systemPrompt ??
      buildSystemPrompt(cfg.criteria, input.scenarioConfig.description);
    const messages: CoreMessage[] = [
      { role: "system", content: systemPrompt },
      ...input.messages,
    ];

    const isLastMessage =
      input.scenarioState.currentTurn === input.scenarioConfig.maxTurns;

    const projectConfig = await getProjectConfig();
    const mergedConfig = mergeAndValidateConfig(cfg, projectConfig);
    if (!mergedConfig.model) {
      throw new Error("Model is required for the judge agent");
    }

    const tools: ToolSet = {
      continue_test: buildContinueTestTool(),
      finish_test: buildFinishTestTool(cfg.criteria),
    };

    const enforceJudgement = input.judgmentRequest;
    const hasCriteria = cfg.criteria.length && cfg.criteria.length > 0;

    if (enforceJudgement && !hasCriteria) {
      return {
        success: false,
        messages: [],
        reasoning: "JudgeAgent: No criteria was provided to be judged against",
        metCriteria: [],
        unmetCriteria: [],
      } satisfies ScenarioResult;
    }

    const toolChoice: ToolChoice<typeof tools> =
      (isLastMessage || enforceJudgement) && hasCriteria
        ? { type: "tool", toolName: "finish_test" }
        : "required";

    const completion = await this.generateText({
      model: mergedConfig.model,
      messages: messages,
      temperature: mergedConfig.temperature ?? 0.0,
      maxTokens: mergedConfig.maxTokens,
      tools,
      toolChoice,
    });

    // Prefer tool call, fallback to JSON
    let args: FinishTestArgs | undefined;
    if (completion.toolCalls?.length) {
      const toolCall = completion.toolCalls[0];

      switch (toolCall.toolName) {
        case "finish_test": {
          args = toolCall.args as FinishTestArgs;

          const verdict = args.verdict || "inconclusive";
          const reasoning = args.reasoning || "No reasoning provided";
          const criteria = args.criteria || {};
          const criteriaValues = Object.values(criteria);
          const metCriteria = cfg.criteria.filter(
            (_, i) => criteriaValues[i] === "true"
          );
          const unmetCriteria = cfg.criteria.filter(
            (_, i) => criteriaValues[i] !== "true"
          );

          return {
            success: verdict === "success",
            messages: input.messages,
            reasoning,
            metCriteria,
            unmetCriteria,
          } satisfies ScenarioResult;
        }

        case "continue_test":
          return [];

        default:
          return {
            success: false,
            messages: input.messages,
            reasoning: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
            metCriteria: [],
            unmetCriteria: cfg.criteria,
          } satisfies ScenarioResult;
      }
    }

    return {
      success: false,
      messages: input.messages,
      reasoning: `JudgeAgent: No tool call found in LLM output`,
      metCriteria: [],
      unmetCriteria: cfg.criteria,
    } satisfies ScenarioResult;
  }

  private async generateText(input: Parameters<typeof generateText>[0]) {
    try {
      return await generateText(input);
    } catch (error) {
      this.logger.error("Error generating text", { error });
      throw error;
    }
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
export const judgeAgent = (cfg: JudgeAgentConfig) => {
  return new JudgeAgent(cfg);
};
