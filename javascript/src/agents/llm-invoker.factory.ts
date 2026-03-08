import { generateText, streamText } from "ai";

import {
  InvokeLLMParams,
  InvokeLLMResult,
  InvokeStreamLLMParams,
  StreamLLMResult,
} from "./types";
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

/**
 * Creates a streaming LLM invoker function with error logging and telemetry enabled.
 * @internal
 * @param logger - Logger instance for error reporting
 * @returns Function that invokes the LLM via streamText
 */
export const createStreamLLMInvoker = (
  logger: Logger
): ((params: InvokeStreamLLMParams) => StreamLLMResult) => {
  return (params) => {
    try {
      return streamText({
        ...params,
        experimental_telemetry: { isEnabled: true },
      });
    } catch (error) {
      logger.error("Error streaming text", { error });
      throw error;
    }
  };
};
