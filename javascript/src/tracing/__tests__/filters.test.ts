import { describe, it, expect, vi, afterEach } from "vitest";
import { LangWatchTraceExporter } from "langwatch/observability";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { scenarioOnly, withCustomScopes, type TraceFilter } from "../filters";

/**
 * A span carrying only what the exporter's filter reads. The filter matches on
 * the instrumentation scope and the span name, so the rest of ReadableSpan is
 * irrelevant here and faking it keeps the test free of an SDK setup.
 */
const spanInScope = (instrumentationScopeName: string, name: string) =>
  ({
    name,
    instrumentationScope: { name: instrumentationScopeName },
  }) as unknown as ReadableSpan;

/**
 * The scopes that survive `filters` and reach the transport.
 *
 * LangWatchTraceExporter applies its filters in `export()` and then delegates
 * to the OTLP exporter it extends, so spying on the parent is what makes the
 * drop observable without a network call or a live endpoint.
 */
const exportedScopes = (
  filters: TraceFilter[],
  spans: ReadableSpan[],
): string[] => {
  const parent = Object.getPrototypeOf(LangWatchTraceExporter.prototype);
  const forwarded: string[] = [];
  vi.spyOn(parent, "export").mockImplementation(((
    batch: ReadableSpan[],
    done: (result: { code: number }) => void,
  ) => {
    forwarded.push(...batch.map((span) => span.instrumentationScope.name));
    done({ code: 0 });
  }) as never);

  new LangWatchTraceExporter({
    endpoint: "http://127.0.0.1:1/v1/traces",
    apiKey: "sk-lw-test",
    filters,
  }).export(spans, () => undefined);

  return forwarded;
};

describe("filters", () => {
  describe("scenarioOnly", () => {
    it("includes only @langwatch/scenario scope", () => {
      expect(scenarioOnly).toEqual([
        {
          include: {
            instrumentationScopeName: [{ equals: "@langwatch/scenario" }],
          },
        },
      ]);
    });

    it("returns a single-element array", () => {
      expect(scenarioOnly).toHaveLength(1);
    });
  });

  describe("withCustomScopes", () => {
    describe("when called with no additional scopes", () => {
      it("includes only @langwatch/scenario", () => {
        const filters = withCustomScopes();
        expect(filters).toEqual([
          {
            include: {
              instrumentationScopeName: [{ equals: "@langwatch/scenario" }],
            },
          },
        ]);
      });
    });

    describe("when called with one custom scope", () => {
      it("includes @langwatch/scenario and the custom scope", () => {
        const filters = withCustomScopes("my-app");
        expect(filters).toEqual([
          {
            include: {
              instrumentationScopeName: [
                { equals: "@langwatch/scenario" },
                { equals: "my-app" },
              ],
            },
          },
        ]);
      });
    });

    describe("when called with multiple custom scopes", () => {
      it("includes @langwatch/scenario and all custom scopes", () => {
        const filters = withCustomScopes("my-app", "my-agent", "my-tools");
        expect(filters).toEqual([
          {
            include: {
              instrumentationScopeName: [
                { equals: "@langwatch/scenario" },
                { equals: "my-app" },
                { equals: "my-agent" },
                { equals: "my-tools" },
              ],
            },
          },
        ]);
      });
    });

    it("returns a new array each time", () => {
      const a = withCustomScopes("a");
      const b = withCustomScopes("b");
      expect(a).not.toBe(b);
    });
  });

  // The suite above pins the shape of the rules. Shape is not behaviour: every
  // assertion there still passes if the exporter ignores `filters` entirely, so
  // nothing yet showed that a noise span is actually dropped.
  describe("when the rules are handed to the exporter that consumes them", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("given scenarioOnly", () => {
      it("forwards scenario spans and drops the other scopes", () => {
        const forwarded = exportedScopes(scenarioOnly, [
          spanInScope("@langwatch/scenario", "Scenario Turn"),
          spanInScope("http-server", "GET /api/health"),
          spanInScope("next.js", "middleware"),
        ]);

        expect(forwarded).toEqual(["@langwatch/scenario"]);
      });
    });

    describe("given withCustomScopes", () => {
      it("forwards the named scopes alongside scenario and drops the rest", () => {
        const forwarded = exportedScopes(withCustomScopes("my-database"), [
          spanInScope("@langwatch/scenario", "Scenario Turn"),
          spanInScope("my-database", "SELECT 1"),
          spanInScope("http-server", "GET /api/health"),
        ]);

        expect(forwarded).toEqual(["@langwatch/scenario", "my-database"]);
      });
    });
  });
});
