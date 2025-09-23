// TODO: Move these to their own files
import { z } from "zod";

/**
 * Zod schema for message objects in prompts
 */
export const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

/**
 * Zod schema for core prompt data - the essential fields needed for functionality
 */
export const corePromptDataSchema = z.object({
  model: z.string().min(1, "Model cannot be empty"),
  messages: z.array(messageSchema).min(1, "At least one message is required"),
  prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
});

/**
 * Zod schema for prompt metadata - optional fields for identification and tracing
 */
export const promptMetadataSchema = z.object({
  handle: z.string().nullable().optional(),
});

/**
 * Combined schema for complete prompt data
 */
export const promptDataSchema = z.object({
  ...corePromptDataSchema.shape,
  ...promptMetadataSchema.shape,
});
