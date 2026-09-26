import { generateText } from "ai";

import {
  adaptationFor,
  applyAdaptations,
  ProviderAdaptation,
} from "./provider-compat";
import { InvokeLLMParams, InvokeLLMResult } from "./types";
import { Logger } from "../utils/logger";

/**
 * Creates an LLM invoker function with error logging and telemetry enabled.
 *
 * A call the provider rejects for a parameter it does not accept (a forced
 * tool choice, a temperature) is re-sent once without it, and the invoker
 * remembers the change for its later calls, so a model pays for the
 * rejection once per agent, not once per turn.
 *
 * @internal
 * @param logger - Logger instance for error reporting
 * @param generate - The text generation function, generateText by default
 * @returns Function that invokes the LLM via generateText
 */
export const createLLMInvoker = (
  logger: Logger,
  generate: (
    params: InvokeLLMParams
  ) => Promise<InvokeLLMResult> = generateText as never
): ((params: InvokeLLMParams) => Promise<InvokeLLMResult>) => {
  const adaptations = new Set<ProviderAdaptation>();

  return async (params) => {
    for (;;) {
      const adapted = applyAdaptations(params, adaptations);
      try {
        return await generate({
          ...adapted,
          experimental_telemetry: { isEnabled: true },
        });
      } catch (error) {
        const adaptation = adaptationFor(error, adapted);
        if (adaptation && !adaptations.has(adaptation)) {
          logger.warn(
            `The model rejected the call, retrying with ${adaptation}`,
            { error: String((error as Error)?.message ?? error) }
          );
          adaptations.add(adaptation);
          continue;
        }
        logger.error("Error generating text", { error });
        throw error;
      }
    }
  };
};
