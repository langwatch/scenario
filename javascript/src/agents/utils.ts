import { UserMessage } from "@ag-ui/core";
import { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

const toolMessageRole: ToolModelMessage["role"] = "tool";
const assistantMessageRole: AssistantModelMessage["role"] = "assistant";
const userMessageRole: UserMessage["role"] = "user";

/**
 * Groups messages into segments based on tool message boundaries.
 * A segment is a continuous group of messages that ends when a tool message is encountered.
 * Each tool message creates a boundary, starting a new segment.
 *
 * @param messages - Array of core messages to group into segments
 * @returns Array of message segments, where each segment is an array of messages
 *
 * @example
 * ```ts
 * const messages = [user, assistant, user, assistantWithTool, tool, assistant];
 * const segments = groupMessagesByToolBoundaries(messages);
 * // Returns: [[user, assistant, user, assistantWithTool, tool], [assistant]]
 * ```
 */
const groupMessagesByToolBoundaries = (messages: ModelMessage[]): ModelMessage[][] => {
  const segments: ModelMessage[][] = [];
  let currentSegment: ModelMessage[] = [];

  for (const message of messages) {
    currentSegment.push(message);

    if (message.role === toolMessageRole) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
};

type ContentPart = {
  input?: unknown;
  output?: unknown;
  result?: unknown;
  toolName?: string;
  type?: string;
};

const hasToolContent = (message: ModelMessage): boolean => {
  if (message.role === toolMessageRole) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(part => {
    if (!part || typeof part !== "object") return false;
    const partType = "type" in part ? (part as { type?: string }).type : undefined;
    return partType === "tool-call" || partType === "tool-result";
  });
};

/**
 * Checks if a message segment contains any tool messages or tool calls.
 * Tool interactions include:
 * - Messages with role 'tool' (tool result messages)
 * - Assistant messages with tool-call/tool-result parts in their content array
 *
 * @param segment - Array of messages to check for tool interactions
 * @returns True if the segment contains tool messages or tool calls, false otherwise
 */
const segmentHasToolMessages = (segment: ModelMessage[]): boolean => {
  return segment.some(hasToolContent);
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
 * Reverses the roles of user and assistant messages within a single segment.
 * Preserves message content as-is while swapping roles.
 *
 * @param segment - Array of messages to reverse roles for
 * @returns New array with user ↔ assistant roles swapped for applicable messages
 *
 * @example
 * ```ts
 * const segment = [
 *   { role: 'user', content: 'Hello' },
 *   { role: 'assistant', content: 'Hi there' },
 *   { role: 'user', content: null }
 * ];
 * const reversed = reverseSegmentRoles(segment);
 * // Returns: [
 * //   { role: 'assistant', content: 'Hello' },
 * //   { role: 'user', content: 'Hi there' },
 * //   { role: 'assistant', content: null }
 * // ]
 * ```
 */
const reverseSegmentRoles = (segment: ModelMessage[]): ModelMessage[] => {
  const roleMap = {
    [userMessageRole]: assistantMessageRole,
    [assistantMessageRole]: userMessageRole,
  };

  return segment.map(message => {
    const newRole = roleMap[message.role as keyof typeof roleMap];
    if (!newRole) return message;

    return {
      ...message,
      role: newRole,
    } as ModelMessage;
  });
};

/**
 * Reverses message roles in segments that don't contain tool messages.
 * Segments with tool interactions keep non-tool messages unchanged, while tool
 * messages are wrapped as plain-text user messages so the simulator can process them.
 */
export const messageRoleReversal = (messages: ModelMessage[]): ModelMessage[] => {
  const segments = groupMessagesByToolBoundaries(messages);

  const processedSegments = segments.map(segment => {
    if (!segmentHasToolMessages(segment)) {
      return reverseSegmentRoles(segment);
    }

    return segment.flatMap(message => {
      if (hasToolContent(message)) {
        const summary = summarizeToolMessage(message);
        if (!summary) return [];
        return [{
          role: userMessageRole,
          content: summary,
        } as ModelMessage];
      }

      return [message];
    });
  });

  return processedSegments.flat();
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
