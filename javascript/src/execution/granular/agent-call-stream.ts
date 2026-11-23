import type { ModelMessage } from "ai";

import type { RunEventBase } from "./message-row-events";
import type {
  AgentStreamPart,
  AgentStreamWriter,
} from "../../domain/agents/types/agent-stream.types";
import { ScenarioEventType, type ScenarioEvent } from "../../events/schema";
import { generateMessageId } from "../../utils/ids";
import { Logger } from "../../utils/logger";

/** How long text and tool-argument deltas gather before one post. */
export const DEFAULT_DELTA_FLUSH_MS = 50;

type PendingDelta =
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "args"; toolCallId: string; delta: string };

/**
 * One agent call's live progress, as {@link AgentStreamWriter}.
 *
 * Each step of the stream is one message, started when its first part
 * arrives. Deltas gather for `flushMs` and go out as one event, and always
 * before the next structural event, so the posted order is the written order.
 *
 * The call's return decides what is recorded: {@link assignIds} gives the
 * k-th streamed message's id to the k-th returned message of the call's role,
 * and the publisher ends it from the returned message. Once settled, the
 * stream drops pending deltas (the END carries the full text) and ignores
 * further parts.
 */
export class AgentCallStream implements AgentStreamWriter {
  private readonly logger = new Logger("scenario.execution.AgentCallStream");
  private readonly startedIds: string[] = [];
  private currentMessageId: string | null = null;
  private pending: PendingDelta[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settled = false;
  private closed = false;

  constructor(
    private readonly options: {
      role: "user" | "assistant";
      base: RunEventBase;
      flushMs?: number;
      emit: (event: ScenarioEvent) => void;
      timestamp: () => number;
      startMessage: (args: { messageId: string }) => void;
      onClose: (startedIds: string[]) => void;
    }
  ) {}

  write(part: AgentStreamPart): void {
    if (this.settled) {
      this.logger.debug(`Ignoring a ${part.type} part written after the agent call settled`);
      return;
    }
    switch (part.type) {
      case "start-step":
      case "finish-step":
        this.flush();
        this.currentMessageId = null;
        return;
      case "text-start":
        this.ensureMessage();
        return;
      case "text-delta": {
        if (part.text.length === 0) return;
        const messageId = this.ensureMessage();
        this.queue({ kind: "text", messageId, delta: part.text });
        return;
      }
      case "text-end":
        return;
      case "tool-input-start": {
        const parentMessageId = this.ensureMessage();
        this.flush();
        this.emit({
          type: ScenarioEventType.TOOL_CALL_START,
          toolCallId: part.id,
          toolCallName: part.toolName,
          parentMessageId,
        });
        return;
      }
      case "tool-input-delta":
        if (part.delta.length > 0) {
          this.queue({ kind: "args", toolCallId: part.id, delta: part.delta });
        }
        return;
      case "tool-input-end":
        this.flush();
        this.emit({ type: ScenarioEventType.TOOL_CALL_END, toolCallId: part.id });
        return;
    }
  }

  async pipe(stream: AsyncIterable<{ type: string }>): Promise<void> {
    for await (const part of stream) {
      // The AI SDK reports a provider failure or an abort as a part rather
      // than a throw; ending here stops reading and fails the agent call.
      const failure = streamFailureOf(part);
      if (failure) throw failure;
      const known = toStreamPart(part);
      if (known) this.write(known);
    }
  }

  /** The call returned: stop accepting parts and drop deltas its END replaces. */
  settle(): void {
    this.settled = true;
    this.clearTimer();
    this.pending = [];
  }

  /**
   * Ids for the call's returned messages: the k-th message of the call's
   * role takes the k-th streamed message's id, the rest take fresh ids.
   */
  assignIds(messages: readonly ModelMessage[]): (string | undefined)[] {
    let next = 0;
    return messages.map((message) =>
      message.role === this.options.role ? this.startedIds[next++] : undefined
    );
  }

  /** Settles the stream and reports which streamed messages it started. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.settle();
    this.closed = true;
    this.options.onClose([...this.startedIds]);
  }

  private ensureMessage(): string {
    if (this.currentMessageId) return this.currentMessageId;
    this.flush();
    const messageId = generateMessageId();
    this.currentMessageId = messageId;
    this.startedIds.push(messageId);
    this.options.startMessage({ messageId });
    return messageId;
  }

  private queue(delta: PendingDelta): void {
    const last = this.pending.at(-1);
    if (last && sameTarget(last, delta)) {
      last.delta += delta.delta;
    } else {
      this.pending.push(delta);
    }
    this.timer ??= setTimeout(() => this.flush(), this.options.flushMs ?? DEFAULT_DELTA_FLUSH_MS);
  }

  private flush(): void {
    this.clearTimer();
    const pending = this.pending;
    this.pending = [];
    for (const delta of pending) {
      if (delta.kind === "text") {
        this.emit({
          type: ScenarioEventType.TEXT_MESSAGE_CONTENT,
          messageId: delta.messageId,
          delta: delta.delta,
        });
      } else {
        this.emit({
          type: ScenarioEventType.TOOL_CALL_ARGS,
          toolCallId: delta.toolCallId,
          delta: delta.delta,
        });
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(
    event:
      | { type: ScenarioEventType.TEXT_MESSAGE_CONTENT; messageId: string; delta: string }
      | {
          type: ScenarioEventType.TOOL_CALL_START;
          toolCallId: string;
          toolCallName: string;
          parentMessageId: string;
        }
      | { type: ScenarioEventType.TOOL_CALL_ARGS; toolCallId: string; delta: string }
      | { type: ScenarioEventType.TOOL_CALL_END; toolCallId: string }
  ): void {
    this.options.emit({
      ...this.options.base,
      timestamp: this.options.timestamp(),
      ...event,
    });
  }
}

function sameTarget(a: PendingDelta, b: PendingDelta): boolean {
  if (a.kind === "text" && b.kind === "text") return a.messageId === b.messageId;
  if (a.kind === "args" && b.kind === "args") return a.toolCallId === b.toolCallId;
  return false;
}

/**
 * The error an AI SDK `error` or `abort` part stands for, else null. An
 * `error` part's own Error is thrown as it is; anything else is wrapped, its
 * value kept only as the cause, so a log of the message never prints it. A
 * `tool-error` is not a failure: the model sees it as the tool's result.
 */
export function streamFailureOf(part: { type: string }): Error | null {
  if (part.type === "error") {
    const error: unknown = "error" in part ? Reflect.get(part, "error") : undefined;
    return error instanceof Error
      ? error
      : new Error("The agent's stream reported an error", { cause: error });
  }
  if (part.type === "abort") {
    const reason = stringField(part, "reason");
    const aborted = new Error(`The agent's stream was aborted${reason ? `: ${reason}` : ""}`);
    aborted.name = "AbortError";
    return aborted;
  }
  return null;
}

/** The part as an {@link AgentStreamPart} when it is one the run reports, else null. */
export function toStreamPart(part: { type: string }): AgentStreamPart | null {
  const id = stringField(part, "id");
  switch (part.type) {
    case "start-step":
    case "finish-step":
      return { type: part.type };
    case "text-start":
    case "text-end":
      return id === undefined ? null : { type: part.type, id };
    case "text-delta": {
      const text = stringField(part, "text");
      return id === undefined || text === undefined ? null : { type: part.type, id, text };
    }
    case "tool-input-start": {
      const toolName = stringField(part, "toolName");
      return id === undefined || toolName === undefined
        ? null
        : { type: part.type, id, toolName };
    }
    case "tool-input-delta": {
      const delta = stringField(part, "delta");
      return id === undefined || delta === undefined ? null : { type: part.type, id, delta };
    }
    case "tool-input-end":
      return id === undefined ? null : { type: part.type, id };
    default:
      return null;
  }
}

function stringField(part: object, field: string): string | undefined {
  if (!(field in part)) return undefined;
  const value: unknown = Reflect.get(part, field);
  return typeof value === "string" ? value : undefined;
}
