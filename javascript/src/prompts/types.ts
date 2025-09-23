import { type z } from "zod";
import {
  type corePromptDataSchema,
  type promptMetadataSchema,
  type promptDataSchema,
} from "./schema";

/**
 * Type for template variables - supporting common data types
 */
export type TemplateVariables = Record<
  string,
  string | number | boolean | object | null
>;

/**
 * Core data needed for prompt functionality
 */
export type CorePromptData = z.infer<typeof corePromptDataSchema>;

/**
 * Optional metadata for identification and tracing
 */
export type PromptMetadata = z.infer<typeof promptMetadataSchema>;

/**
 * Combined type for creating prompts
 */
export type PromptData = z.infer<typeof promptDataSchema>;
