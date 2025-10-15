import { z } from "zod/v4";

export const testingAgentInferenceConfigSchema = z.object({
  model: z
    .string()
    .optional()
    .describe("The language model to use for generating responses."),
  temperature: z
    .number()
    .optional()
    .describe("The temperature for the language model."),
  maxTokens: z
    .number()
    .optional()
    .describe("The maximum number of tokens to generate."),
});

export type TestingAgentInferenceConfig = z.infer<
  typeof testingAgentInferenceConfigSchema
>;
