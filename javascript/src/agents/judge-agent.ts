import { generateText, CoreMessage, ToolSet, Tool, ToolChoice, tool } from "ai";
import { z } from "zod";
import { AgentInput, JudgeAgentAdapter, AgentRole } from "../domain";
import { TestingAgentConfig, FinishTestArgs } from "./types";
import { criterionToParamName } from "./utils";
import { getProjectConfig } from "../config";
import { ScenarioResult } from "../domain/core/execution";
import { mergeAndValidateConfig } from "../utils/config";

interface JudgeAgentConfig extends TestingAgentConfig {
  systemPrompt?: string;
  criteria: string[];
}

function buildSystemPrompt(criteria: string[], description: string): string {
  const criteriaList = criteria
    ?.map((criterion, idx) => `${idx + 1}. ${criterion}`)
    .join("\n") || "No criteria provided";

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
      criteria: z.object(
        Object.fromEntries(
          criteriaNames.map((name, idx) => [
            name,
            z.enum(["true", "false", "inconclusive"]).describe(criteria[idx])
          ])
        )
      ).strict().describe("Strict verdict for each criterion"),
      reasoning: z.string().describe("Explanation of what the final verdict should be"),
      verdict: z.enum(["success", "failure", "inconclusive"]).describe("The final verdict of the test"),
    }),
  });
}

export const judgeAgent = (cfg: JudgeAgentConfig) => {
  return {
    role: AgentRole.JUDGE,
    criteria: cfg.criteria,

    call: async (input: AgentInput) => {
      const systemPrompt = cfg.systemPrompt ?? buildSystemPrompt(cfg.criteria, input.scenarioConfig.description);
      const messages: CoreMessage[] = [
        { role: "system", content: systemPrompt },
        ...input.messages,
      ];

      const isLastMessage = input.scenarioState.turn == input.scenarioConfig.maxTurns;

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
          passedCriteria: [],
          failedCriteria: [],
        } satisfies ScenarioResult;
      }

      const toolChoice: ToolChoice<typeof tools> = (isLastMessage || enforceJudgement) && hasCriteria
        ? { type: "tool", toolName: "finish_test" }
        : "required";

      const completion = await generateText({
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
            const passedCriteria = cfg.criteria.filter((_, i) => criteriaValues[i] === "true");
            const failedCriteria = cfg.criteria.filter((_, i) => criteriaValues[i] !== "true");

            return {
              success: verdict === "success",
              messages: input.messages,
              reasoning,
              passedCriteria,
              failedCriteria,
            } satisfies ScenarioResult;

          }

          case "continue_test":
            return [];

          default:
            return {
              success: false,
              messages: input.messages,
              reasoning: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
              passedCriteria: [],
              failedCriteria: cfg.criteria,
            } satisfies ScenarioResult;
        }
      }

      return {
        success: false,
        messages: input.messages,
        reasoning: `JudgeAgent: No tool call found in LLM output`,
        passedCriteria: [],
        failedCriteria: cfg.criteria,
      } satisfies ScenarioResult;
    },
  } satisfies JudgeAgentAdapter;
};
