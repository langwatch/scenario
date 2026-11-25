import type { ModelMessage } from "ai";

import type { InvokeLLMParams } from "./types";

/**
 * A change to a model call that a provider asked for by rejecting it.
 *
 * - `relaxToolChoice`: models that think before answering (Claude Opus 5.5
 *   on Bedrock, Anthropic models with thinking on) refuse a tool choice that
 *   forces a tool. The call is re-sent with tool choice `auto` and an
 *   instruction to answer through the tools.
 * - `dropTemperature`: newer models refuse any temperature (Claude Sonnet 5)
 *   or any value but the default (GPT-5.5). The call is re-sent without it.
 *
 * The Python SDK recognises the same rejections; keep them in sync.
 */
export type ProviderAdaptation = "relaxToolChoice" | "dropTemperature";

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as { message?: unknown; responseBody?: unknown };
  return [record.message, record.responseBody]
    .filter((part) => typeof part === "string")
    .join(" ");
}

function forcesTool(toolChoice: InvokeLLMParams["toolChoice"]): boolean {
  return (
    toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice?.type === "tool")
  );
}

/**
 * The adaptation a provider rejection asks for, or null when the rejection
 * is anything else and must reach the caller unchanged.
 */
export function adaptationFor(
  error: unknown,
  params: InvokeLLMParams
): ProviderAdaptation | null {
  const text = errorText(error);
  if (
    forcesTool(params.toolChoice) &&
    /tool_choice/i.test(text) &&
    /(not supported|forces tool use)/i.test(text)
  ) {
    return "relaxToolChoice";
  }
  if (
    params.temperature !== undefined &&
    /temperature/i.test(text) &&
    /(deprecated|not support|unsupported|only the default)/i.test(text)
  ) {
    return "dropTemperature";
  }
  return null;
}

function toolInstruction(toolChoice: InvokeLLMParams["toolChoice"]): string {
  if (typeof toolChoice === "object" && toolChoice?.type === "tool") {
    return `Answer only by calling the ${toolChoice.toolName} tool, never with plain text.`;
  }
  return "Answer only by calling one of the provided tools, never with plain text.";
}

/** Applies the adaptations learned so far to a call. */
export function applyAdaptations(
  params: InvokeLLMParams,
  adaptations: ReadonlySet<ProviderAdaptation>
): InvokeLLMParams {
  let adapted = params;
  if (adaptations.has("dropTemperature") && adapted.temperature !== undefined) {
    const { temperature: _temperature, ...rest } = adapted;
    adapted = rest as InvokeLLMParams;
  }
  if (adaptations.has("relaxToolChoice") && forcesTool(adapted.toolChoice)) {
    const instruction: ModelMessage = {
      role: "user",
      content: toolInstruction(adapted.toolChoice),
    };
    adapted = {
      ...adapted,
      toolChoice: "auto",
      ...(adapted.messages
        ? { messages: [...adapted.messages, instruction] }
        : {}),
    } as InvokeLLMParams;
  }
  return adapted;
}
