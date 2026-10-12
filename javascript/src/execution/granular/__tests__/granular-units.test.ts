// Ref: specs/granular-message-events.feature
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSendGranularEvents } from "../../../config/env";
import { ScenarioEventType, type ScenarioEvent } from "../../../events/schema";
import { rebuildChatLog } from "../../../integrations/vitest/rebuild-chat-log";
import {
  StateChangeEventType,
  type StateChangeEvent,
  type StoredMessage,
} from "../../scenario-execution-state";
import { AgentCallStream, DEFAULT_DELTA_FLUSH_MS } from "../agent-call-stream";
import { MessageEventPublisher } from "../message-event-publisher";
import { RunEventClock } from "../run-event-clock";

const base = { batchRunId: "b", scenarioId: "s", scenarioRunId: "r", scenarioSetId: "default" };

describe("SCENARIO_SEND_GRANULAR_EVENTS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["true", "1", "yes", "on", " TRUE "])("turns granular events on for %j", (value) => {
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", value);
    expect(resolveSendGranularEvents(undefined)).toBe(true);
  });

  it.each(["false", "0", "no", "off", ""])("leaves granular events off for %j", (value) => {
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", value);
    expect(resolveSendGranularEvents(undefined)).toBe(false);
  });

  it("refuses a value that is neither on nor off", () => {
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", "maybe");
    expect(() => resolveSendGranularEvents(undefined)).toThrow(/SCENARIO_SEND_GRANULAR_EVENTS/);
  });

  it("lets the run's own option win over the variable", () => {
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", "true");
    expect(resolveSendGranularEvents(false)).toBe(false);
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", "maybe");
    expect(resolveSendGranularEvents(true)).toBe(true);
  });
});

describe("RunEventClock", () => {
  it("gives snapshots in one millisecond strictly increasing timestamps", () => {
    const clock = new RunEventClock(() => 1000);
    expect([clock.nextSnapshot(), clock.nextSnapshot(), clock.nextSnapshot()]).toEqual([1000, 1001, 1002]);
  });

  it("never stamps an event earlier than the snapshot before it", () => {
    let now = 1000;
    const clock = new RunEventClock(() => now);
    clock.nextSnapshot();
    clock.nextSnapshot();
    expect(clock.next()).toBe(1001);
    now = 1005;
    expect(clock.next()).toBe(1005);
    expect(clock.nextSnapshot()).toBe(1005);
  });
});

describe("MessageEventPublisher", () => {
  function setup({ granular }: { granular: boolean }) {
    const changes = new Subject<StateChangeEvent>();
    const messages: StoredMessage[] = [];
    const emitted: ScenarioEvent[] = [];
    const publisher = new MessageEventPublisher({
      granular,
      base,
      emit: (event) => emitted.push(event),
      messages: () => messages,
      clock: new RunEventClock(() => 5000),
    });
    publisher.follow(changes);
    const add = (message: StoredMessage) => {
      messages.push(message);
      changes.next({ type: StateChangeEventType.MESSAGE_ADDED, message });
    };
    const rollBack = (to: number) => {
      const removed = messages.splice(to);
      changes.next({ type: StateChangeEventType.MESSAGES_ROLLED_BACK, removedCount: removed.length });
    };
    return { publisher, emitted, add, rollBack };
  }

  it("gives reconciliation snapshots in one millisecond distinct, ordered timestamps", () => {
    const { emitted, add, rollBack } = setup({ granular: true });
    add({ id: "m1", turn: 0, role: "user", content: "one" });
    add({ id: "m2", turn: 0, role: "assistant", content: "two" });
    rollBack(1);
    rollBack(0);

    const timestamps = emitted.map((e) => e.timestamp);
    const snapshots = emitted.filter((e) => e.type === ScenarioEventType.MESSAGE_SNAPSHOT);
    expect(snapshots.map((e) => e.timestamp)).toEqual([5000, 5001]);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it("repairs once, after the open stream closes, when a rollback lands mid-call", () => {
    const { publisher, emitted, add, rollBack } = setup({ granular: true });
    add({ id: "m1", turn: 0, role: "user", content: "one" });
    const stream = publisher.openStream({ role: "assistant" })!;
    rollBack(0);
    expect(emitted.some((e) => e.type === ScenarioEventType.MESSAGE_SNAPSHOT)).toBe(false);
    stream.close();
    expect(emitted.filter((e) => e.type === ScenarioEventType.MESSAGE_SNAPSHOT)).toHaveLength(1);
  });

  it("keeps snapshot mode as it was: one snapshot per message and no stream", () => {
    const { publisher, emitted, add, rollBack } = setup({ granular: false });
    add({ id: "m1", turn: 0, role: "user", content: "one" });
    rollBack(0);
    expect(emitted.map((e) => e.type)).toEqual([ScenarioEventType.MESSAGE_SNAPSHOT]);
    expect(publisher.openStream({ role: "assistant" })).toBeUndefined();
  });
});

describe("AgentCallStream", () => {
  afterEach(() => vi.useRealTimers());

  function open() {
    const emitted: ScenarioEvent[] = [];
    const started: string[] = [];
    const closed: string[][] = [];
    const stream = new AgentCallStream({
      role: "assistant",
      base,
      emit: (event) => emitted.push(event),
      timestamp: () => 1,
      startMessage: ({ messageId }) => started.push(messageId),
      onClose: (ids) => closed.push(ids),
    });
    return { stream, emitted, started, closed };
  }

  it("gathers deltas for the flush interval and posts them as one", () => {
    vi.useFakeTimers();
    const { stream, emitted } = open();
    stream.write({ type: "text-delta", id: "t", text: "a" });
    stream.write({ type: "text-delta", id: "t", text: "b" });
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(DEFAULT_DELTA_FLUSH_MS);
    expect(emitted).toEqual([expect.objectContaining({ type: ScenarioEventType.TEXT_MESSAGE_CONTENT, delta: "ab" })]);
  });

  it("clears its timer and pending deltas when the call settles, and ignores later parts", () => {
    vi.useFakeTimers();
    const { stream, emitted } = open();
    stream.write({ type: "text-delta", id: "t", text: "a" });
    stream.settle();
    expect(vi.getTimerCount()).toBe(0);
    stream.write({ type: "text-delta", id: "t", text: "late" });
    vi.advanceTimersByTime(DEFAULT_DELTA_FLUSH_MS * 2);
    expect(emitted).toHaveLength(0);
  });

  it("flushes deltas before a structural event so the posted order is the written order", () => {
    const { stream, emitted } = open();
    stream.write({ type: "tool-input-start", id: "c1", toolName: "search" });
    stream.write({ type: "tool-input-delta", id: "c1", delta: '{"q":' });
    stream.write({ type: "tool-input-delta", id: "c1", delta: '"x"}' });
    stream.write({ type: "tool-input-end", id: "c1" });
    expect(emitted.map((e) => e.type)).toEqual([
      ScenarioEventType.TOOL_CALL_START,
      ScenarioEventType.TOOL_CALL_ARGS,
      ScenarioEventType.TOOL_CALL_END,
    ]);
    stream.close();
  });

  it("starts one message per step and hands the ids to the returned messages of its role", () => {
    const { stream, started, closed } = open();
    stream.write({ type: "start-step" });
    stream.write({ type: "text-delta", id: "a", text: "first" });
    stream.write({ type: "finish-step" });
    stream.write({ type: "start-step" });
    stream.write({ type: "text-start", id: "b" });
    stream.settle();
    expect(started).toHaveLength(2);
    expect(
      stream.assignIds([
        { role: "assistant", content: "first" },
        { role: "tool", content: [] },
        { role: "assistant", content: "second" },
      ])
    ).toEqual([started[0], undefined, started[1]]);
    stream.close();
    stream.close();
    expect(closed).toEqual([started]);
  });
});

describe("rebuildChatLog", () => {
  const event = { ...base, timestamp: 1 };

  it("rebuilds the chat log from start and end events, in messageIndex order", () => {
    const log = rebuildChatLog([
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_START, messageId: "a", role: "user", messageIndex: 0 },
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_END, messageId: "a", role: "user", content: "hi", messageIndex: 0 },
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_START, messageId: "b", role: "assistant", messageIndex: 1 },
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_CONTENT, messageId: "b", delta: "hel" },
      {
        ...event,
        type: ScenarioEventType.TEXT_MESSAGE_END,
        messageId: "b",
        role: "assistant",
        content: "hello",
        message: { id: "b", role: "assistant", content: "hello", toolCalls: [] },
        messageIndex: 1,
      },
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_START, messageId: "never-ended", role: "assistant", messageIndex: 2 },
    ]);
    expect(log.map((row) => [row.id, row.role, row.content])).toEqual([
      ["a", "user", "hi"],
      ["b", "assistant", "hello"],
    ]);
    expect(log[1]!.toolCalls).toEqual([]);
  });

  it("pads to a high index as the platform does, so ends out of order keep their rows", () => {
    const end = (messageId: string, messageIndex: number) => ({
      ...event,
      type: ScenarioEventType.TEXT_MESSAGE_END as const,
      messageId,
      role: "assistant",
      content: messageId,
      messageIndex,
    });
    const log = rebuildChatLog([
      end("m2", 2),
      end("m0", 0),
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant", messageIndex: 2 },
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", messageIndex: 1 },
      end("m1", 1),
    ]);
    expect(log.map((row) => row.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("lets a snapshot replace the list, as a repair does", () => {
    const log = rebuildChatLog([
      { ...event, type: ScenarioEventType.TEXT_MESSAGE_END, messageId: "a", role: "user", content: "gone", messageIndex: 0 },
      { ...event, type: ScenarioEventType.MESSAGE_SNAPSHOT, messages: [{ id: "x", role: "user", content: "kept" }] },
    ]);
    expect(log.map((row) => row.content)).toEqual(["kept"]);
  });
});
