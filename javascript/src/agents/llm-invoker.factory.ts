import { generateText } from "ai";

import { InvokeLLMParams, InvokeLLMResult } from "./types";
import { Logger } from "../utils/logger";

/**
 * Creates an LLM invoker function with error logging and telemetry enabled.
 * @internal
 * @param logger - Logger instance for error reporting
 * @returns Function that invokes the LLM via generateText
 */
export const createLLMInvoker = (
  logger: Logger
): ((params: InvokeLLMParams) => Promise<InvokeLLMResult>) => {
  return async (params) => {
    try {
      return await generateText({
        ...params,
        experimental_telemetry: { isEnabled: true },
      });
    } catch (error) {
      logger.error("Error generating text", { error });
      throw error;
    }
  };
};
