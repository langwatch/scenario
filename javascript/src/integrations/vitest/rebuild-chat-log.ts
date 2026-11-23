import { ScenarioEventType, type ScenarioEvent } from "../../events/schema";

/** One message of the rebuilt log: an AG-UI row as the run reported it. */
export type ChatLogRow = Record<string, unknown> & { id: string; role: string };

type Slot = { id: string; row?: ChatLogRow };

/**
 * One run's conversation, rebuilt from its event log the way LangWatch folds
 * it: a MESSAGE_SNAPSHOT replaces the list, a TEXT_MESSAGE_START inserts a
 * row at its messageIndex, and a TEXT_MESSAGE_END fills the row with its id,
 * or takes the row at its messageIndex when no START came. An index past the
 * end pads with empty rows first, as the platform does. Rows that never
 * ended (and padding) are left out. Works for snapshot-only and granular runs.
 *
 * @see specs/granular-message-events.feature
 */
export function rebuildChatLog(events: readonly ScenarioEvent[]): ChatLogRow[] {
  let slots: Slot[] = [];

  for (const event of events) {
    if (event.type === ScenarioEventType.MESSAGE_SNAPSHOT) {
      slots = event.messages.map((message) => {
        const row: ChatLogRow = { ...message };
        return { id: message.id, row };
      });
    } else if (event.type === ScenarioEventType.TEXT_MESSAGE_START) {
      if (slots.some((slot) => slot.id === event.messageId)) continue;
      const slot: Slot = { id: event.messageId };
      if (event.messageIndex === undefined) {
        slots.push(slot);
      } else {
        padTo(slots, event.messageIndex);
        slots.splice(event.messageIndex, 0, slot);
      }
    } else if (event.type === ScenarioEventType.TEXT_MESSAGE_END) {
      const row: ChatLogRow = {
        content: event.content ?? "",
        ...event.message,
        id: event.messageId,
        role: event.role,
      };
      const existing = slots.find((slot) => slot.id === event.messageId);
      if (existing) {
        existing.row = row;
      } else if (event.messageIndex === undefined) {
        slots.push({ id: row.id, row });
      } else {
        padTo(slots, event.messageIndex);
        slots[event.messageIndex] = { id: row.id, row };
      }
    }
  }

  return slots.flatMap((slot) => (slot.row ? [slot.row] : []));
}

/** Empty rows up to `index`, so a row can be placed there. */
function padTo(slots: Slot[], index: number): void {
  while (slots.length < index) slots.push({ id: "" });
}
