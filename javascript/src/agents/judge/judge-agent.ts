import { generateText, CoreMessage, ToolSet, Tool, ToolChoice, tool } from "ai";
import { z } from "zod/v4";
import { JudgeResult } from "./interfaces";
import { getProjectConfig } from "../../config";
import { AgentInput, IJudgeAgent, AgentRole } from "../../domain";
import { modelSchema } from "../../domain/core/schemas/model.schema";
import { Logger } from "../../utils/logger";
import {
  TestingAgentConfig,
  FinishTestArgs,
  InvokeLLMInput,
  InvokeLLMResult,
} from "../types";
import { criterionToParamName } from "../utils";

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
 * Base judge agent with extensible LLM invocation.
 *
 * This class handles all orchestration logic (system prompts, tool building, config merging).
 * To customize the LLM provider, override the `invokeLLM()` method.
 *
 * **DO NOT OVERRIDE `call()`** - Override `invokeLLM()` instead.
 *
 * @param cfg {JudgeAgentConfig} Configuration for the judge agent.
 */
export class JudgeAgent implements IJudgeAgent {
  readonly role = AgentRole.JUDGE;
  readonly criteria: string[];
  private logger = new Logger("JudgeAgent");

  constructor(private readonly cfg: JudgeAgentConfig) {
    this.criteria = cfg.criteria;
  }

  /**
   * Main orchestration - DO NOT OVERRIDE.
   * Override `invokeLLM()` to customize LLM provider.
   */
  async call(input: AgentInput): Promise<JudgeResult | null> {
    try {
      // 1. Check if we should judge
      if (!this.shouldJudge(input)) {
        return null;
      }

      // 2. Build messages with system prompt
      const systemPrompt = this.getSystemPrompt(input);
      const messages: CoreMessage[] = [
        { role: "system", content: systemPrompt },
        ...input.messages,
      ];

      // 3. Build tools
      const tools: ToolSet = {
        continue_test: buildContinueTestTool(),
        finish_test: buildFinishTestTool(this.cfg.criteria),
      };

      // 4. Determine tool choice
      const isLastTurn =
        input.scenarioState.currentTurn === input.scenarioConfig.maxTurns;
      const enforceJudgement = input.judgmentRequest;
      const hasCriteria = this.cfg.criteria.length > 0;

      const toolChoice: ToolChoice<typeof tools> =
        (isLastTurn || enforceJudgement) && hasCriteria
          ? { type: "tool", toolName: "finish_test" }
          : "required";

      // 5. Get config
      const config = await this.getModelConfig();

      // 6. Prepare LLM input - everything is ready
      const llmInput: InvokeLLMInput = {
        messages,
        model: config.model,
        temperature: config.temperature ?? 0.0,
        maxTokens: config.maxTokens,
        tools,
        toolChoice,
      };

      // 7. Invoke LLM - PURE API CALL (override this method to customize)
      const result = await this.invokeLLM(llmInput);

      // 8. Process tool calls
      return this.processToolCalls(result.completion);
    } catch (error) {
      this.logger.error("Error in judge agent", { error });
      throw error;
    }
  }

  /**
   * EXTENSION POINT - Override this to use different LLM providers.
   *
   * This method receives fully prepared input and should make a pure LLM API call.
   * All orchestration logic (system prompts, tools, config) is already done.
   *
   * Returns an object with raw completion for processing tool calls.
   *
   * @param input - Fully prepared LLM input with tools
   * @returns Result containing raw completion for tool call processing
   */
  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    // Default: Vercel AI SDK
    const completion = await generateText({
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
      tools: input.tools,
      toolChoice: input.toolChoice,
    });

    return {
      content: "", // Judge doesn't use text content, only tool calls
      completion,
    };
  }

  // All helpers are PRIVATE - internal implementation details

  private shouldJudge(input: AgentInput): boolean {
    const enforceJudgement = input.judgmentRequest;
    const hasCriteria = this.cfg.criteria.length > 0;

    if (enforceJudgement && !hasCriteria) {
      return false;
    }

    return true;
  }

  private getSystemPrompt(input: AgentInput): string {
    return (
      this.cfg.systemPrompt ??
      buildSystemPrompt(this.cfg.criteria, input.scenarioConfig.description)
    );
  }

  private async getModelConfig() {
    const projectConfig = await getProjectConfig();
    return modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...this.cfg,
    });
  }

  private processToolCalls(completion: any): JudgeResult | null {
    if (!completion.toolCalls?.length) {
      return {
        success: false,
        reasoning: `JudgeAgent: No tool call found in LLM output`,
        metCriteria: [],
        unmetCriteria: this.cfg.criteria,
      };
    }

    const toolCall = completion.toolCalls[0];

    switch (toolCall.toolName) {
      case "finish_test": {
        const args = toolCall.input as FinishTestArgs;
        const verdict = args.verdict || "inconclusive";
        const reasoning = args.reasoning || "No reasoning provided";
        const criteria = args.criteria || {};
        const criteriaValues = Object.values(criteria);
        const metCriteria = this.cfg.criteria.filter(
          (_, i) => criteriaValues[i] === "true"
        );
        const unmetCriteria = this.cfg.criteria.filter(
          (_, i) => criteriaValues[i] !== "true"
        );

        return {
          success: verdict === "success",
          reasoning,
          metCriteria,
          unmetCriteria,
        };
      }

      case "continue_test":
        return null;

      default:
        return {
          success: false,
          reasoning: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
          metCriteria: [],
          unmetCriteria: this.cfg.criteria,
        };
    }
  }
}

/**
 * Factory function for creating judge agents.
 *
 * Creates an agent that evaluates conversations against success criteria.
 * The judge watches conversations in real-time and makes decisions about
 * whether the agent under test is meeting the specified criteria.
 *
 * @param cfg Configuration for the judge agent.
 * @param cfg.criteria List of success criteria to evaluate against.
 * @param cfg.model Optional The language model to use for generating responses.
 * @param cfg.temperature Optional The temperature to use for the model.
 * @param cfg.maxTokens Optional The maximum number of tokens to generate.
 * @param cfg.systemPrompt Optional Custom system prompt to override default judge behavior.
 *
 * @returns IJudgeAgent instance
 *
 * @example
 * ```typescript
 * import { run, judgeAgent, AgentRole, user, agent, IAgent } from '@langwatch/scenario';
 *
 * // Basic judge
 * const judge = judgeAgent({
 *   criteria: ["The agent must respond to the user."],
 * });
 *
 * // Customized judge
 * const strictJudge = judgeAgent({
 *   criteria: ["Agent responds politely", "Agent provides accurate information"],
 *   model: "gpt-4",
 *   temperature: 0.0,
 *   systemPrompt: "You are a strict judge. Be very critical.",
 * });
 *
 * // Use in scenario
 * await run({
 *   name: "Test",
 *   description: "Testing agent behavior",
 *   agents: [myAgent, judge],
 *   script: [user("Hello!"), agent()],
 * });
 * ```
 *
 * **Extending with custom LLM:**
 * ```typescript
 * class CustomJudge extends JudgeAgent {
 *   protected async invokeLLM(input: InvokeLLMInput) {
 *     // Use custom LLM for judging
 *     const response = await myCustomLLM.generateWithTools({
 *       model: input.model,
 *       messages: input.messages,
 *       tools: input.tools,
 *     });
 *     return response;
 *   }
 * }
 * ```
 */
export const judgeAgent = (cfg: JudgeAgentConfig): IJudgeAgent => {
  return new JudgeAgent(cfg);
};
