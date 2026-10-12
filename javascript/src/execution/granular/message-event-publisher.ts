import type { ModelMessage } from "ai";
import type { Observable, Subscription } from "rxjs";

import { AgentCallStream } from "./agent-call-stream";
import {
  textMessageEndEvent,
  textMessageStartEvent,
  type AguiRow,
  type RunEventBase,
} from "./message-row-events";
import { RunEventClock } from "./run-event-clock";
import {
  ScenarioEventType,
  type ScenarioEvent,
  type ScenarioMessageSnapshotEvent,
} from "../../events/schema";
import convertModelMessagesToAguiMessages, {
  countAguiRows,
} from "../../utils/convert-core-messages-to-agui-messages";
import {
  StateChangeEventType,
  type StateChangeEvent,
  type StoredMessage,
} from "../scenario-execution-state";

/**
 * Reports a run's messages to LangWatch, one of two ways.
 *
 * Snapshot mode (the default) posts the whole conversation after every
 * message, as the run always has. Granular mode posts each AG-UI row once as
 * TEXT_MESSAGE_START and TEXT_MESSAGE_END, and live progress from an agent
 * that writes to {@link AgentCallStream}.
 *
 * The platform keeps only the first END per message id and cannot delete a
 * row, so whatever granular events cannot express (a rollback, a row that
 * landed at another index than its START said, a streamed message the call
 * never returned) is repaired by one MESSAGE_SNAPSHOT, which replaces the
 * stored list.
 *
 * @see specs/granular-message-events.feature
 */
export class MessageEventPublisher {
  /** Rows reported as started and not yet ended, with the index their START gave. */
  private readonly started = new Map<string, number>();
  private readonly openStreams = new Set<AgentCallStream>();
  private repairPending = false;
  private readonly clock: RunEventClock;

  constructor(
    private readonly options: {
      granular: boolean;
      base: RunEventBase;
      emit: (event: ScenarioEvent) => void;
      messages: () => readonly ModelMessage[];
      clock?: RunEventClock;
      deltaFlushMs?: number;
    }
  ) {
    this.clock = options.clock ?? new RunEventClock();
  }

  get granular(): boolean {
    return this.options.granular;
  }

  /**
   * The timestamp for any event of the run. Granular mode keeps them in
   * emission order (see {@link RunEventClock}); snapshot mode is unchanged.
   */
  timestamp(): number {
    return this.options.granular ? this.clock.next() : Date.now();
  }

  /** Reports the state's message changes until the subscription ends. */
  follow(changes$: Observable<StateChangeEvent>): Subscription {
    return changes$.subscribe((change) => {
      if (change.type === StateChangeEventType.MESSAGE_ADDED) {
        if (this.options.granular) this.reportAdded(change.message);
        else this.emitSnapshot(Date.now());
      } else if (this.options.granular) {
        this.repairPending = true;
        this.repairWhenIdle();
      }
    });
  }

  /**
   * A stream for one agent call, or `undefined` in snapshot mode. The caller
   * settles it when the call returns and closes it once the call's messages
   * are added, on every path.
   */
  openStream({ role }: { role: "user" | "assistant" }): AgentCallStream | undefined {
    if (!this.options.granular) return undefined;
    const stream = new AgentCallStream({
      role,
      flushMs: this.options.deltaFlushMs,
      emit: (event) => this.options.emit(event),
      timestamp: () => this.clock.next(),
      base: this.options.base,
      startMessage: ({ messageId }) => this.startStreamedMessage({ messageId, role }),
      onClose: (startedIds) => this.closeStream(stream, startedIds),
    });
    this.openStreams.add(stream);
    return stream;
  }

  /** Stops every open stream; nothing a late agent writes is posted after this. */
  close(): void {
    for (const stream of Array.from(this.openStreams)) stream.close();
  }

  private startStreamedMessage({
    messageId,
    role,
  }: {
    messageId: string;
    role: string;
  }): void {
    // Rows already reported plus rows streamed and not yet added: where the
    // row lands if nothing else is added first. A miss is repaired on close.
    const messageIndex = this.rowCount(this.options.messages()) + this.started.size;
    this.started.set(messageId, messageIndex);
    this.options.emit(
      textMessageStartEvent({
        base: this.options.base,
        timestamp: this.clock.next(),
        messageId,
        role,
        messageIndex,
      })
    );
  }

  private closeStream(stream: AgentCallStream, startedIds: string[]): void {
    this.openStreams.delete(stream);
    for (const id of startedIds) {
      // Started but never returned by the call: only a snapshot removes it.
      if (this.started.delete(id)) this.repairPending = true;
    }
    this.repairWhenIdle();
  }

  private reportAdded(message: StoredMessage): void {
    const all = this.options.messages();
    const position = all.lastIndexOf(message);
    const firstRow = this.rowCount(all.slice(0, position < 0 ? all.length : position));
    const rows = convertModelMessagesToAguiMessages([message]) as AguiRow[];

    rows.forEach((row, offset) => {
      const messageIndex = firstRow + offset;
      const startedAt = this.started.get(row.id);
      if (startedAt === undefined) {
        this.options.emit(
          textMessageStartEvent({
            base: this.options.base,
            timestamp: this.clock.next(),
            messageId: row.id,
            role: row.role,
            messageIndex,
          })
        );
      } else {
        this.started.delete(row.id);
        if (startedAt !== messageIndex) this.repairPending = true;
      }
      this.options.emit(
        textMessageEndEvent({
          base: this.options.base,
          timestamp: this.clock.next(),
          row,
          messageIndex,
        })
      );
    });
    this.repairWhenIdle();
  }

  /** Repairs once no agent call is still streaming, so one snapshot covers it all. */
  private repairWhenIdle(): void {
    if (!this.repairPending || this.openStreams.size > 0) return;
    this.repairPending = false;
    this.emitSnapshot(this.clock.nextSnapshot());
  }

  private emitSnapshot(timestamp: number): void {
    const event: ScenarioMessageSnapshotEvent = {
      ...this.options.base,
      timestamp,
      type: ScenarioEventType.MESSAGE_SNAPSHOT,
      messages: convertModelMessagesToAguiMessages([...this.options.messages()]),
    };
    this.options.emit(event);
  }

  private rowCount(messages: readonly ModelMessage[]): number {
    return messages.reduce((total, message) => total + countAguiRows(message), 0);
  }
}
