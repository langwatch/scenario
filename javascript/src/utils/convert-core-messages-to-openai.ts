import { CoreMessage } from "ai";
import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.mjs";
import { MultimodalAudioMessage } from "../messages";

/**
 * Converts an array of CoreMessage objects (from 'ai') to an array of OpenAI ChatCompletionMessageParam objects.
 * Handles user, assistant, system, and tool roles, including multimodal and tool call content.
 *
 * @param coreMessages - Array of CoreMessage objects
 * @returns Array of ChatCompletionMessageParam objects for OpenAI API
 */
export function convertCoreMessagesToOpenAIMessages(
  coreMessages: (CoreMessage | MultimodalAudioMessage)[]
): ChatCompletionMessageParam[] {
  if (!Array.isArray(coreMessages)) {
    throw new Error("Input must be an array of CoreMessage objects");
  }

  return coreMessages.map((msg): ChatCompletionMessageParam => {
    if (
      !msg ||
      typeof msg.role !== "string" ||
      typeof msg.content === "undefined"
    ) {
      throw new Error("Invalid CoreMessage: missing role or content");
    }

    if (msg.role === "tool") {
      return {
        role: "tool",
        content:
          msg.content as unknown as ChatCompletionToolMessageParam["content"],
        tool_call_id: "id" in msg && typeof msg.id === "string" ? msg.id : "",
      } as ChatCompletionToolMessageParam;
    }

    return {
      role: msg.role as "user" | "assistant" | "system",
      content: msg.content,
    } as ChatCompletionMessageParam;
  });
}
