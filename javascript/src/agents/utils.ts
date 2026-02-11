import { UserMessage } from "@ag-ui/core";
import { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

const toolMessageRole: ToolModelMessage["role"] = "tool";
const assistantMessageRole: AssistantModelMessage["role"] = "assistant";
const userMessageRole: UserMessage["role"] = "user";

type ContentPart = {
  input?: unknown;
  output?: unknown;
  result?: unknown;
  toolName?: string;
  type?: string;
};

/**
 * Checks if a message contains tool-related content (tool-call or tool-result parts,
 * or has the 'tool' role). These messages need to be summarized as plain text
 * rather than role-reversed, because sending raw tool content on a 'user' message
 * breaks both OpenAI and Anthropic APIs.
 */
const hasToolContent = (message: ModelMessage): boolean => {
  if (message.role === toolMessageRole) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(part => {
    if (!part || typeof part !== "object") return false;
    const partType = "type" in part ? (part as { type?: string }).type : undefined;
    return partType === "tool-call" || partType === "tool-result";
  });
};

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
};

/**
 * Converts a tool message into a plain-text summary so the user simulator
 * understands what the agent did without receiving raw tool protocol messages.
 */
const summarizeToolMessage = (message: ModelMessage): string | null => {
  if (message.role === toolMessageRole && !Array.isArray(message.content)) {
    return `[Tool message: ${stringifyValue(message.content)}]`;
  }

  if (message.role === toolMessageRole) {
    const toolResults = message.content
      .filter(part => part.type === "tool-result")
      .map(part => {
        const contentPart = part as ContentPart;
        const name = contentPart.toolName ?? "unknown tool";
        const output = contentPart.output;
        const value =
          output &&
          typeof output === "object" &&
          "value" in output &&
          typeof (output as { value?: unknown }).value === "string"
            ? (output as { value: string }).value
            : output ?? contentPart.result;
        return `[Tool result from ${name}: ${stringifyValue(value)}]`;
      });

    return toolResults.length > 0 ? toolResults.join("\n") : null;
  }

  if (!Array.isArray(message.content)) return null;

  const toolCalls = message.content
    .filter(part => part.type === "tool-call")
    .map(part => {
      const contentPart = part as ContentPart;
      const name = contentPart.toolName ?? "unknown tool";
      return `[Called tool ${name} with: ${stringifyValue(contentPart.input)}]`;
    });

  return toolCalls.length > 0 ? toolCalls.join("\n") : null;
};

/**
 * Reverses user ↔ assistant roles for the user simulator agent.
 *
 * Every message is processed individually:
 * 1. Tool messages (role 'tool' or containing tool-call/tool-result parts)
 *    → summarized as plain text attributed to 'user' (the agent after reversal)
 * 2. User messages → become 'assistant' (so the LLM generates as "assistant")
 * 3. Assistant messages → become 'user' (the agent's words become context)
 * 4. System messages → preserved unchanged
 *
 * This flat per-message approach is correct because every non-tool message must
 * be reversed regardless of whether nearby messages contain tool calls. The old
 * segment-based approach incorrectly left non-tool messages unreversed in segments
 * that contained tools, causing the user simulator to see the wrong roles and
 * respond as an assistant instead of simulating a user.
 */
export const messageRoleReversal = (messages: ModelMessage[]): ModelMessage[] => {
  const roleMap = {
    [userMessageRole]: assistantMessageRole,
    [assistantMessageRole]: userMessageRole,
  };

  return messages
    .map(message => {
      if (hasToolContent(message)) {
        const summary = summarizeToolMessage(message);
        if (!summary) return null;
        return {
          role: userMessageRole,
          content: summary,
        } as ModelMessage;
      }

      const newRole = roleMap[message.role as keyof typeof roleMap];
      if (!newRole) return message;

      return {
        ...message,
        role: newRole,
      } as ModelMessage;
    })
    .filter((message): message is ModelMessage => message !== null);
};

/**
 * Converts a criterion string into a valid parameter name by sanitizing and formatting it.
 * Useful for converting human-readable criteria into code-safe parameter names.
 *
 * @param criterion - The original criterion string to convert
 * @returns Sanitized parameter name (lowercase, underscores, max 70 characters)
 *
 * @example
 * ```ts
 * criterionToParamName("Response Quality & Clarity")
 * // Returns: "response_quality___clarity"
 *
 * criterionToParamName('User"s Satisfaction Level')
 * // Returns: "users_satisfaction_level"
 *
 * criterionToParamName("Very Long Criterion Name That Exceeds Limits")
 * // Returns: "very_long_criterion_name_that_exceeds_limits" (truncated to 70 chars)
 * ```
 */
export const criterionToParamName = (criterion: string): string => {
  return criterion
    .replace(/"/g, "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/ /g, "_")
    .toLowerCase()
    .substring(0, 70);
};
