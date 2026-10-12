import type { MessagesSnapshotEvent } from "@ag-ui/core";

import {
  ScenarioEventType,
  type ScenarioTextMessageEndEvent,
  type ScenarioTextMessageStartEvent,
} from "../../events/schema";

/** One AG-UI row, as `convertModelMessagesToAguiMessages` makes it. */
export type AguiRow = MessagesSnapshotEvent["messages"][number] & {
  trace_id?: string;
};

/** The fields every event of one run carries, minus the timestamp. */
export interface RunEventBase {
  batchRunId: string;
  scenarioId: string;
  scenarioRunId: string;
  scenarioSetId: string;
}

/**
 * The text a row shows: its string content, or the text parts of array
 * content joined by newlines. Audio parts add nothing, so a voice turn shows
 * its transcript and the audio bytes travel only in the END's `message`.
 */
export function displayTextOf(row: AguiRow): string {
  const content: unknown = row.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : []
    )
    .join("\n");
}

export function textMessageStartEvent({
  base,
  timestamp,
  messageId,
  role,
  messageIndex,
}: {
  base: RunEventBase;
  timestamp: number;
  messageId: string;
  role: string;
  messageIndex: number;
}): ScenarioTextMessageStartEvent {
  return {
    ...base,
    timestamp,
    type: ScenarioEventType.TEXT_MESSAGE_START,
    messageId,
    role,
    messageIndex,
  };
}

/**
 * The END that settles a row. `message` is the whole AG-UI row, so array
 * content (`input_audio` parts the platform moves to storage) and
 * `toolCalls` reach the platform intact; `content` is display text only.
 */
export function textMessageEndEvent({
  base,
  timestamp,
  row,
  messageIndex,
}: {
  base: RunEventBase;
  timestamp: number;
  row: AguiRow;
  messageIndex: number;
}): ScenarioTextMessageEndEvent {
  return {
    ...base,
    timestamp,
    type: ScenarioEventType.TEXT_MESSAGE_END,
    messageId: row.id,
    role: row.role,
    content: displayTextOf(row),
    message: { ...row },
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    messageIndex,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
