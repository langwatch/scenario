import { describe, it, expect, vi, beforeEach } from "vitest";

import { EventBus } from "../event-bus";
import {
  ScenarioEventType,
  type ScenarioEvent,
  type ScenarioRunStartedEvent,
  type ScenarioRunFinishedEvent,
  ScenarioRunStatus,
  Verdict,
} from "../schema";

vi.mock("../event-alert-message-logger", () => ({
  EventAlertMessageLogger: vi.fn().mockImplementation(function (this: unknown) {
    return { handleGreeting: vi.fn(), handleWatchMessage: vi.fn() };
  }),
}));

function makeStartedEvent(runId = "run-1"): ScenarioRunStartedEvent {
  return {
    type: ScenarioEventType.RUN_STARTED,
    batchRunId: "batch-1",
    scenarioId: "scenario-1",
    scenarioRunId: runId,
    scenarioSetId: "default",
    timestamp: Date.now(),
    metadata: { name: "test-name", description: "test-description" },
  };
}

function makeFinishedEvent(runId = "run-1"): ScenarioRunFinishedEvent {
  return {
    type: ScenarioEventType.RUN_FINISHED,
    batchRunId: "batch-1",
    scenarioId: "scenario-1",
    scenarioRunId: runId,
    scenarioSetId: "default",
    timestamp: Date.now(),
    status: ScenarioRunStatus.SUCCESS,
    results: {
      verdict: Verdict.SUCCESS,
      metCriteria: [],
      unmetCriteria: [],
    },
  };
}

function makeBus(postEvent: (event: ScenarioEvent) => Promise<{ setUrl?: string }>) {
  const bus = new EventBus({
    endpoint: "https://example.test",
    apiKey: "test-key",
  });
  // Swap the private reporter for a controllable one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus as any).eventReporter = { postEvent };
  return bus;
}

/** Fails the test instead of hanging when drain regresses into a deadlock. */
async function drainWithDeadline(bus: EventBus, timeoutMs = 5_000): Promise<void> {
  await Promise.race([
    bus.drain(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("drain() did not resolve promptly")), timeoutMs)
    ),
  ]);
}

describe("EventBus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a transient failure and delivers on the third attempt", async () => {
    let attempts = 0;
    const bus = makeBus(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient failure");
      return {};
    });

    bus.listen();
    bus.publish(makeStartedEvent());
    await drainWithDeadline(bus);

    expect(attempts).toBe(3);
  });

  it("drops a permanently failing event without terminating the stream", async () => {
    const delivered: ScenarioEvent[] = [];
    const bus = makeBus(async (event) => {
      if (event.type === ScenarioEventType.RUN_STARTED) {
        throw new Error("endpoint is down");
      }
      delivered.push(event);
      return {};
    });

    bus.listen();
    bus.publish(makeStartedEvent());
    bus.publish(makeFinishedEvent());
    await drainWithDeadline(bus);

    // The failing RUN_STARTED was dropped after retries; the stream stayed
    // alive and still delivered the RUN_FINISHED that followed it.
    expect(delivered.map((e) => e.type)).toEqual([ScenarioEventType.RUN_FINISHED]);
  });

  it("does not retry a permanent 4xx client error", async () => {
    let attempts = 0;
    const bus = makeBus(async () => {
      attempts += 1;
      throw Object.assign(new Error("bad request"), { status: 400 });
    });

    bus.listen();
    bus.publish(makeStartedEvent());
    await drainWithDeadline(bus);

    expect(attempts).toBe(1);
  });

  it("retries 429 responses", async () => {
    let attempts = 0;
    const bus = makeBus(async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429 });
      return {};
    });

    bus.listen();
    bus.publish(makeStartedEvent());
    await drainWithDeadline(bus);

    expect(attempts).toBe(2);
  });

  it("drain resolves on stream completion even when RUN_FINISHED never arrives", async () => {
    const bus = makeBus(async () => ({}));

    bus.listen();
    bus.publish(makeStartedEvent());

    // No RUN_FINISHED published: drain must resolve when the stream
    // completes instead of sitting on the 300s timeout.
    await drainWithDeadline(bus);
  });

  it("removes the bus from the static registry after drain", async () => {
    const bus = makeBus(async () => ({}));

    expect(EventBus.getAllBuses().has(bus)).toBe(true);

    bus.listen();
    bus.publish(makeFinishedEvent());
    await drainWithDeadline(bus);

    expect(EventBus.getAllBuses().has(bus)).toBe(false);
  });
});
