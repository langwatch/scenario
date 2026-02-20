import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { run, type RunOptions } from "../run";
import { AgentRole, type AgentAdapter, type AgentInput } from "../../domain";
import type { ScenarioEvent } from "../../events/schema";

// Mock the EventBus - must use function keyword for constructor
vi.mock("../../events/event-bus", () => ({
  EventBus: vi.fn().mockImplementation(function (this: unknown, config: unknown) {
    return {
      config,
      listen: vi.fn(),
      subscribeTo: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
      drain: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// Mock the tracing setup
vi.mock("../../tracing/setup", () => ({
  observabilityHandle: undefined,
}));

// Mock getLangWatchTracer
vi.mock("langwatch", () => ({
  getLangWatchTracer: vi.fn().mockReturnValue({
    startSpan: vi.fn().mockReturnValue({
      end: vi.fn(),
      spanContext: vi.fn().mockReturnValue({ traceId: "test-trace-id" }),
    }),
    withActiveSpan: vi.fn().mockImplementation(async (_name, _opts, _ctx, fn) => {
      const mockSpan = {
        setType: vi.fn(),
        setInput: vi.fn(),
        setOutput: vi.fn(),
        setMetrics: vi.fn(),
        spanContext: vi.fn().mockReturnValue({ traceId: "test-trace-id" }),
      };
      return fn(mockSpan);
    }),
  }),
}));

class TestAgent implements AgentAdapter {
  name = "TestAgent";
  role = AgentRole.AGENT;

  async call(_input: AgentInput): Promise<string> {
    return "Test response";
  }
}

class TestJudgeAgent implements AgentAdapter {
  name = "TestJudge";
  role = AgentRole.JUDGE;

  async call(_input: AgentInput) {
    return {
      success: true,
      reasoning: "Test passed",
      metCriteria: ["criterion1"],
      unmetCriteria: [],
    };
  }
}

function createScenarioConfig(name = "Test Scenario") {
  return {
    name,
    description: `Scenario ${name}`,
    agents: [new TestAgent(), new TestJudgeAgent()],
    script: [
      async (_state: unknown, executor: { succeed: (msg: string) => Promise<unknown> }) => {
        await executor.succeed(`Success from ${name}`);
      },
    ],
  };
}

async function mockEventBusWithEventCapture() {
  const { EventBus } = await import("../../events/event-bus");
  const capturedEvents: ScenarioEvent[] = [];

  vi.mocked(EventBus).mockImplementation(function (this: unknown, config: unknown) {
    return {
      config,
      listen: vi.fn(),
      subscribeTo: vi.fn().mockImplementation((events$) => {
        const subscription = events$.subscribe((event: ScenarioEvent) => {
          capturedEvents.push(event);
        });
        return subscription;
      }),
      drain: vi.fn().mockResolvedValue(undefined),
    };
  });

  return { EventBus, capturedEvents };
}

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runId", () => {
    it("includes runId in the result", async () => {
      const result = await run(createScenarioConfig());

      expect(result.runId).toBeDefined();
      expect(result.runId).toMatch(/^scenariorun_/);
    });

    it("generates unique runIds for each run", async () => {
      const config = createScenarioConfig();

      const result1 = await run(config);
      const result2 = await run(config);

      expect(result1.runId).not.toBe(result2.runId);
    });
  });

  describe("batchRunId", () => {
    it("uses provided batchRunId from options", async () => {
      const { capturedEvents } = await mockEventBusWithEventCapture();

      await run(createScenarioConfig(), { batchRunId: "custom_batch_123" });

      const runStartedEvent = capturedEvents.find((e) => e.type === "SCENARIO_RUN_STARTED");
      expect(runStartedEvent?.batchRunId).toBe("custom_batch_123");
    });

    it("auto-generates batchRunId when not provided", async () => {
      const { capturedEvents } = await mockEventBusWithEventCapture();

      await run(createScenarioConfig());

      const runStartedEvent = capturedEvents.find((e) => e.type === "SCENARIO_RUN_STARTED");
      expect(runStartedEvent?.batchRunId).toBeDefined();
      expect(runStartedEvent?.batchRunId).toMatch(/^scenariobatch_/);
    });
  });

  describe("langwatch config", () => {
    it("uses provided langwatch config for EventBus", async () => {
      const { EventBus } = await import("../../events/event-bus");

      const options: RunOptions = {
        langwatch: {
          endpoint: "https://custom.endpoint.com",
          apiKey: "custom-api-key",
        },
      };

      await run(createScenarioConfig(), options);

      expect(EventBus).toHaveBeenCalledWith({
        endpoint: "https://custom.endpoint.com",
        apiKey: "custom-api-key",
      });
    });
  });

  describe("concurrency safety", () => {
    it("creates separate EventBus instances for concurrent runs", async () => {
      const { EventBus } = await import("../../events/event-bus");
      const eventBusConfigs: Array<{ endpoint: string; apiKey: string | undefined }> = [];

      vi.mocked(EventBus).mockImplementation(function (this: unknown, config: { endpoint: string; apiKey: string | undefined }) {
        eventBusConfigs.push(config);
        return {
          config,
          listen: vi.fn(),
          subscribeTo: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
          drain: vi.fn().mockResolvedValue(undefined),
        };
      });

      await Promise.all([
        run(createScenarioConfig(), {
          langwatch: { endpoint: "https://api.example.com", apiKey: "project-a-key" },
        }),
        run(createScenarioConfig(), {
          langwatch: { endpoint: "https://api.example.com", apiKey: "project-b-key" },
        }),
        run(createScenarioConfig(), {
          langwatch: { endpoint: "https://api.example.com", apiKey: "project-c-key" },
        }),
      ]);

      expect(EventBus).toHaveBeenCalledTimes(3);

      const apiKeys = eventBusConfigs.map((c) => c.apiKey);
      expect(apiKeys).toContain("project-a-key");
      expect(apiKeys).toContain("project-b-key");
      expect(apiKeys).toContain("project-c-key");

      expect(apiKeys.filter((k) => k === "project-a-key")).toHaveLength(1);
      expect(apiKeys.filter((k) => k === "project-b-key")).toHaveLength(1);
      expect(apiKeys.filter((k) => k === "project-c-key")).toHaveLength(1);
    });

    it("isolates events between concurrent runs", async () => {
      const { EventBus } = await import("../../events/event-bus");
      const eventsByApiKey = new Map<string, ScenarioEvent[]>();

      vi.mocked(EventBus).mockImplementation(function (this: unknown, config: { endpoint: string; apiKey: string | undefined }) {
        const events: ScenarioEvent[] = [];
        eventsByApiKey.set(config.apiKey ?? "", events);

        return {
          config,
          listen: vi.fn(),
          subscribeTo: vi.fn().mockImplementation((events$) => {
            const subscription = events$.subscribe((event: ScenarioEvent) => {
              events.push(event);
            });
            return subscription;
          }),
          drain: vi.fn().mockResolvedValue(undefined),
        };
      });

      await Promise.all([
        run(createScenarioConfig("Scenario-A"), {
          langwatch: { endpoint: "https://api.example.com", apiKey: "key-a" },
        }),
        run(createScenarioConfig("Scenario-B"), {
          langwatch: { endpoint: "https://api.example.com", apiKey: "key-b" },
        }),
      ]);

      const eventsA = eventsByApiKey.get("key-a") ?? [];
      const eventsB = eventsByApiKey.get("key-b") ?? [];

      expect(eventsA.length).toBeGreaterThanOrEqual(2);
      expect(eventsB.length).toBeGreaterThanOrEqual(2);

      const runStartedA = eventsA.find((e) => e.type === "SCENARIO_RUN_STARTED");
      const runStartedB = eventsB.find((e) => e.type === "SCENARIO_RUN_STARTED");

      expect(runStartedA?.metadata?.name).toBe("Scenario-A");
      expect(runStartedB?.metadata?.name).toBe("Scenario-B");
    });
  });
});
