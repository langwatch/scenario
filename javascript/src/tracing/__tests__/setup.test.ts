import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to define mock values that are available inside vi.mock factories
const { mockSetupObservability, mockGetTracerProvider, mockJudgeSpanCollector, mockGetEnv } = vi.hoisted(() => ({
  mockSetupObservability: vi.fn(),
  mockGetTracerProvider: vi.fn(),
  mockJudgeSpanCollector: {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getSpansForThread: vi.fn().mockReturnValue([]),
    clearSpansForThread: vi.fn(),
  },
  mockGetEnv: vi.fn().mockReturnValue({
    LANGWATCH_API_KEY: "test-api-key",
    LANGWATCH_ENDPOINT: "https://app.langwatch.ai",
  }),
}));

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracerProvider: () => mockGetTracerProvider(),
  },
}));

vi.mock("langwatch/observability/node", () => ({
  setupObservability: (...args: unknown[]) => mockSetupObservability(...args),
}));

vi.mock("langwatch/observability", () => ({
  LangWatchTraceExporter: class MockLangWatchTraceExporter {
    export = vi.fn();
    shutdown = vi.fn();
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  SimpleSpanProcessor: class MockSimpleSpanProcessor {
    exporter: unknown;
    constructor(exporter: unknown) {
      this.exporter = exporter;
    }
    onStart = vi.fn();
    onEnd = vi.fn();
    forceFlush = vi.fn();
    shutdown = vi.fn();
  },
}));

vi.mock("../../agents/judge/judge-span-collector", () => ({
  judgeSpanCollector: mockJudgeSpanCollector,
}));

vi.mock("../../config", () => ({
  getEnv: () => mockGetEnv(),
}));

// Import after mocks are set up
import {
  setupScenarioTracing,
  ensureTracingInitialized,
  _resetTracingForTests,
} from "../setup";

describe("setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTracingForTests();
    // Default: return a ProxyTracerProvider (no addSpanProcessor)
    mockGetTracerProvider.mockReturnValue({
      constructor: { name: "ProxyTracerProvider" },
    });
  });

  describe("setupScenarioTracing", () => {
    describe("when no concrete OTel provider exists", () => {
      it("calls setupObservability with default config", () => {
        setupScenarioTracing();

        expect(mockSetupObservability).toHaveBeenCalledTimes(1);
        expect(mockSetupObservability).toHaveBeenCalledWith(
          expect.objectContaining({
            langwatch: {
              apiKey: "test-api-key",
              endpoint: "https://app.langwatch.ai",
            },
          })
        );
      });

      it("always injects judgeSpanCollector as a span processor", () => {
        setupScenarioTracing();

        const call = mockSetupObservability.mock.calls[0]![0];
        expect(call.spanProcessors).toContain(mockJudgeSpanCollector);
      });

      it("forwards user-provided options to setupObservability", () => {
        const customProcessor = {
          onStart: vi.fn(),
          onEnd: vi.fn(),
          forceFlush: vi.fn().mockResolvedValue(undefined),
          shutdown: vi.fn().mockResolvedValue(undefined),
        };

        setupScenarioTracing({
          serviceName: "my-test-service",
          spanProcessors: [customProcessor],
        });

        const call = mockSetupObservability.mock.calls[0]![0];
        expect(call.serviceName).toBe("my-test-service");
        expect(call.spanProcessors).toContain(mockJudgeSpanCollector);
        expect(call.spanProcessors).toContain(customProcessor);
      });

      it("uses user-provided langwatch config when given", () => {
        setupScenarioTracing({
          langwatch: { apiKey: "custom-key", endpoint: "https://custom.endpoint" },
        });

        const call = mockSetupObservability.mock.calls[0]![0];
        expect(call.langwatch).toEqual({
          apiKey: "custom-key",
          endpoint: "https://custom.endpoint",
        });
      });
    });

    describe("when a concrete OTel provider already exists", () => {
      const mockAddSpanProcessor = vi.fn();

      beforeEach(() => {
        mockGetTracerProvider.mockReturnValue({
          addSpanProcessor: mockAddSpanProcessor,
          constructor: { name: "NodeTracerProvider" },
        });
      });

      it("skips setupObservability and attaches to existing provider", () => {
        setupScenarioTracing();

        expect(mockSetupObservability).not.toHaveBeenCalled();
        expect(mockAddSpanProcessor).toHaveBeenCalled();
      });

      it("adds judgeSpanCollector to existing provider", () => {
        setupScenarioTracing();

        expect(mockAddSpanProcessor).toHaveBeenCalledWith(mockJudgeSpanCollector);
      });

      it("adds LangWatch exporter to existing provider when API key is set", () => {
        setupScenarioTracing();

        // judgeSpanCollector + SimpleSpanProcessor(LangWatchTraceExporter)
        expect(mockAddSpanProcessor).toHaveBeenCalledTimes(2);
      });

      it("forwards user-provided spanProcessors to existing provider", () => {
        const customProcessor = {
          onStart: vi.fn(),
          onEnd: vi.fn(),
          forceFlush: vi.fn().mockResolvedValue(undefined),
          shutdown: vi.fn().mockResolvedValue(undefined),
        };

        setupScenarioTracing({ spanProcessors: [customProcessor] });

        expect(mockAddSpanProcessor).toHaveBeenCalledWith(customProcessor);
      });

      it("wraps user-provided traceExporter in SimpleSpanProcessor", () => {
        const customExporter = { export: vi.fn(), shutdown: vi.fn() };

        setupScenarioTracing({ traceExporter: customExporter as any });

        // judgeSpanCollector + user traceExporter wrapped + LangWatch exporter
        expect(mockAddSpanProcessor).toHaveBeenCalledTimes(3);
      });
    });

    describe("when a ProxyTracerProvider wraps a concrete provider", () => {
      const mockAddSpanProcessor = vi.fn();

      beforeEach(() => {
        mockGetTracerProvider.mockReturnValue({
          constructor: { name: "ProxyTracerProvider" },
          _delegate: {
            addSpanProcessor: mockAddSpanProcessor,
            constructor: { name: "NodeTracerProvider" },
          },
        });
      });

      it("detects the delegate and attaches processors to it", () => {
        setupScenarioTracing();

        expect(mockSetupObservability).not.toHaveBeenCalled();
        expect(mockAddSpanProcessor).toHaveBeenCalledWith(mockJudgeSpanCollector);
      });
    });

    describe("when provider has getDelegate() method", () => {
      const mockAddSpanProcessor = vi.fn();

      beforeEach(() => {
        mockGetTracerProvider.mockReturnValue({
          constructor: { name: "ProxyTracerProvider" },
          getDelegate: () => ({
            addSpanProcessor: mockAddSpanProcessor,
            constructor: { name: "NodeTracerProvider" },
          }),
        });
      });

      it("detects the delegate via getDelegate() and attaches processors", () => {
        setupScenarioTracing();

        expect(mockSetupObservability).not.toHaveBeenCalled();
        expect(mockAddSpanProcessor).toHaveBeenCalledWith(mockJudgeSpanCollector);
      });
    });

    describe("when provider has delegate property", () => {
      const mockAddSpanProcessor = vi.fn();

      beforeEach(() => {
        mockGetTracerProvider.mockReturnValue({
          constructor: { name: "ProxyTracerProvider" },
          delegate: {
            addSpanProcessor: mockAddSpanProcessor,
            constructor: { name: "NodeTracerProvider" },
          },
        });
      });

      it("detects the delegate via delegate property and attaches processors", () => {
        setupScenarioTracing();

        expect(mockSetupObservability).not.toHaveBeenCalled();
        expect(mockAddSpanProcessor).toHaveBeenCalledWith(mockJudgeSpanCollector);
      });
    });

    it("prevents double initialization", () => {
      setupScenarioTracing();
      setupScenarioTracing();

      expect(mockSetupObservability).toHaveBeenCalledTimes(1);
    });
  });

  describe("ensureTracingInitialized", () => {
    it("delegates to setupScenarioTracing on first call", () => {
      ensureTracingInitialized();

      expect(mockSetupObservability).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when setupScenarioTracing was already called", () => {
      setupScenarioTracing();
      ensureTracingInitialized();

      expect(mockSetupObservability).toHaveBeenCalledTimes(1);
    });

    it("passes observability options through", () => {
      ensureTracingInitialized({ serviceName: "from-config" });

      const call = mockSetupObservability.mock.calls[0]![0];
      expect(call.serviceName).toBe("from-config");
    });
  });
});
