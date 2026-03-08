import { ModelMessage } from "ai";
import {
  ScenarioEvent,
  ScenarioEventType,
} from "../events/schema";

/**
 * Extracts text content from a ModelMessage regardless of format.
 */
function extractTextContent(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * Converts a single ModelMessage to an array of granular scenario events.
 * ALL roles use START/END events — no MESSAGE_SNAPSHOT.
 * This avoids triggering heavy refetch broadcasts for non-assistant messages.
 */
export function convertModelMessageToGranularEvents(
  message: ModelMessage & { id: string; traceId?: string },
  baseEvent: {
    batchRunId: string;
    scenarioId: string;
    scenarioRunId: string;
    scenarioSetId?: string;
  }
): ScenarioEvent[] {
  const events: ScenarioEvent[] = [];
  const timestamp = Date.now();

  const common = {
    ...baseEvent,
    timestamp,
  };

  // Assistant messages with content arrays may also contain tool calls
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text" && part.text.length > 0) {
        events.push({
          ...common,
          type: ScenarioEventType.TEXT_MESSAGE_START,
          messageId: message.id,
          role: "assistant",
        } as ScenarioEvent);

        events.push({
          ...common,
          type: ScenarioEventType.TEXT_MESSAGE_CONTENT,
          messageId: message.id,
          delta: part.text,
        } as ScenarioEvent);

        events.push({
          ...common,
          type: ScenarioEventType.TEXT_MESSAGE_END,
          messageId: message.id,
        } as ScenarioEvent);
      } else if (part.type === "tool-call") {
        events.push({
          ...common,
          type: ScenarioEventType.TOOL_CALL_START,
          toolCallId: part.toolCallId,
          toolCallName: part.toolName,
          parentMessageId: message.id,
        } as ScenarioEvent);

        events.push({
          ...common,
          type: ScenarioEventType.TOOL_CALL_ARGS,
          toolCallId: part.toolCallId,
          delta: JSON.stringify(part.input),
        } as ScenarioEvent);

        events.push({
          ...common,
          type: ScenarioEventType.TOOL_CALL_END,
          toolCallId: part.toolCallId,
        } as ScenarioEvent);
      }
    }
    return events;
  }

  // All other messages (assistant string, user, system, tool):
  // Use START + END with full content. No CONTENT delta needed —
  // these are complete messages, not streaming.
  const content = extractTextContent(message);

  events.push({
    ...common,
    type: ScenarioEventType.TEXT_MESSAGE_START,
    messageId: message.id,
    role: message.role,
  } as ScenarioEvent);

  events.push({
    ...common,
    type: ScenarioEventType.TEXT_MESSAGE_END,
    messageId: message.id,
    role: message.role,
    content,
    traceId: message.traceId,
  } as ScenarioEvent);

  return events;
}

export default convertModelMessageToGranularEvents;
