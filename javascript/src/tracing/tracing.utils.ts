import { CoreMessage } from "ai";

/**
 * Formats messages into a minimal transcript for judge evaluation.
 * @param messages - Array of CoreMessage from conversation
 * @returns Plain text transcript with one message per line
 */
function formatTranscript(messages: CoreMessage[]): string {
  return messages
    .map((msg) => `${msg.role}: ${JSON.stringify(msg.content)}`)
    .join("\n");
}

/**
 * Content part in span-compatible format (snake_case types).
 */
type SpanContentPart =
  | { type: "text"; text?: string }
  | { type: "tool_call"; toolName?: string; toolCallId?: string; args?: string }
  | {
      type: "tool_result";
      toolName?: string;
      toolCallId?: string;
      result?: unknown;
    };

/**
 * Simple chat message compatible with span output.
 * Matches LangWatch SDK's SimpleChatMessage interface.
 */
interface SpanChatMessage {
  role: string;
  content: unknown;
}

/**
 * Converts Vercel AI SDK messages to LangWatch span chat message format.
 */
function vercelMessagesToLangwatchSpanChatMessagesFormat(
  messages: CoreMessage[],
): SpanChatMessage[] {
  return messages.map((msg): SpanChatMessage => {
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
      return { role: msg.role, content: msg.content };
    }

    const convertedContent = msg.content.map((part): SpanContentPart => {
      if (part.type === "tool-call") {
        return {
          type: "tool_call",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          args:
            typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input),
        };
      }
      if (part.type === "tool-result") {
        return {
          type: "tool_result",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          result: part.output,
        };
      }
      return part as SpanContentPart;
    });

    return { role: msg.role, content: convertedContent };
  });
}

/**
 * Tracing utilities for span operations.
 */
export const TracingUtils = {
  /**
   * Converts a base64 encoded trace id to a hex string.
   * @see https://github.com/langwatch/langwatch/pull/861
   * @param base64 - The base64 encoded trace id.
   * @returns The hex string.
   */
  toHex: (base64: string): string => {
    return Buffer.from(base64, "base64").toString("hex");
  },

  /**
   * Converts Vercel AI SDK messages to LangWatch span chat message format.
   *
   * Transforms:
   * - `type: "tool-call"` → `type: "tool_call"`
   * - `type: "tool-result"` → `type: "tool_result"`
   * - `input` → `args` (stringified)
   * - `output` → `result`
   *
   * @param messages - Array of CoreMessage from Vercel AI SDK
   * @returns Messages formatted for span output
   */
  vercelMessagesToLangwatchSpanChatMessagesFormat,

  /**
   * Formats messages into a minimal transcript for judge evaluation.
   * @param messages - Array of CoreMessage from conversation
   * @returns Plain text transcript with one message per line
   */
  formatTranscript,
};
