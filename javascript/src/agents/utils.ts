import { UserMessage } from "@ag-ui/core";
import { CoreAssistantMessage, CoreMessage, CoreToolMessage } from "ai";

const toolMessageRole: CoreToolMessage["role"] = "tool";
const assistantMessageRole: CoreAssistantMessage["role"] = "assistant";
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
const groupMessagesByToolBoundaries = (messages: CoreMessage[]): CoreMessage[][] => {
  const segments: CoreMessage[][] = [];
  let currentSegment: CoreMessage[] = [];

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

/**
 * Checks if a message segment contains any tool messages or tool calls.
 * Tool interactions include:
 * - Messages with role 'tool' (tool result messages)
 * - Assistant messages with tool-call parts in their content array
 *
 * @param segment - Array of messages to check for tool interactions
 * @returns True if the segment contains tool messages or tool calls, false otherwise
 */
const segmentHasToolMessages = (segment: CoreMessage[]): boolean => {
  return segment.some(message => {
    if (message.role === toolMessageRole) return true;

    if (message.role === assistantMessageRole && Array.isArray(message.content)) {
      return message.content.some(part => part.type === 'tool-call');
    }

    return false;
  });
};

/**
 * Reverses the roles of user and assistant messages within a single segment.
 * Only processes messages with string content (including empty strings) - other message types are preserved unchanged.
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
 * //   { role: 'assistant', content: 'Hello' },    // Reversed (string content)
 * //   { role: 'user', content: 'Hi there' },      // Reversed (string content)
 * //   { role: 'user', content: null }              // Preserved (non-string content)
 * // ]
 * ```
 */
const reverseSegmentRoles = (segment: CoreMessage[]): CoreMessage[] => {
  return segment.map(message => {
    const hasStringContent = typeof message.content === "string";
    if (!hasStringContent) return message;

    const roleMap = {
      [userMessageRole]: assistantMessageRole,
      [assistantMessageRole]: userMessageRole,
    };

    const newRole = roleMap[message.role as keyof typeof roleMap];
    if (!newRole) return message;

    return {
      role: newRole,
      content: message.content as string,
    };
  });
};

/**
 * Reverses message roles in segments that don't contain tool messages.
 * This maintains proper conversation flow by only reversing roles when it's safe to do so.
 * Segments containing tool interactions are preserved unchanged to maintain the
 * assistant → tool → assistant flow required by language models.
 *
 * @param messages - Array of core messages to process
 * @returns New array with roles reversed in tool-free segments, tool segments unchanged
 *
 * @example
 * ```ts
 * const messages = [
 *   { role: 'user', content: 'Hello' },
 *   { role: 'assistant', content: 'Hi!' },
 *   { role: 'user', content: 'Calculate 2+2' },
 *   { role: 'assistant', content: [{ type: 'tool-call', ... }] },
 *   { role: 'tool', content: [{ type: 'tool-result', result: 4 }] },
 *   { role: 'assistant', content: 'The answer is 4' }
 * ];
 *
 * const reversed = messageRoleReversal(messages);
 * // Returns:
 * // [
 * //   { role: 'user', content: 'Hello' },                    // Preserved (tool segment)
 * //   { role: 'assistant', content: 'Hi!' },                 // Preserved (tool segment)
 * //   { role: 'user', content: 'Calculate 2+2' },            // Preserved (tool segment)
 * //   { role: 'assistant', content: [{ type: 'tool-call', ... }] }, // Preserved (tool segment)
 * //   { role: 'tool', content: [{ type: 'tool-result', result: 4 }] }, // Preserved (tool segment)
 * //   { role: 'user', content: 'The answer is 4' }           // Reversed (new segment after tool)
 * // ]
 * ```
 */
export const messageRoleReversal = (messages: CoreMessage[]): CoreMessage[] => {
  const segments = groupMessagesByToolBoundaries(messages);

  const processedSegments = segments.map(segment =>
    segmentHasToolMessages(segment) ? segment : reverseSegmentRoles(segment)
  );

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
