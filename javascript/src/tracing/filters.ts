/**
 * Criteria for matching spans by instrumentation scope name or span name.
 * Within each field, matchers use OR semantics (any match succeeds).
 * Across fields, AND semantics apply (all specified fields must match).
 */
export interface TraceFilterCriteria {
  instrumentationScopeName?: TraceFilterMatch[];
  name?: TraceFilterMatch[];
}

/**
 * A single match rule for string comparison.
 */
export interface TraceFilterMatch {
  equals?: string;
  startsWith?: string;
  matches?: RegExp;
  ignoreCase?: boolean;
}

/**
 * A filter rule for controlling which spans are exported.
 *
 * Compatible with the langwatch SDK's `TraceFilter` type used by
 * `LangWatchTraceExporter`.
 */
export type TraceFilter =
  | { preset: "vercelAIOnly" | "excludeHttpRequests" }
  | { include: TraceFilterCriteria }
  | { exclude: TraceFilterCriteria };

/**
 * Preset filter that only keeps spans from the @langwatch/scenario instrumentation scope.
 * Use this to prevent unrelated server spans (HTTP, middleware, etc.) from being exported.
 *
 * @example
 * ```typescript
 * import { defineConfig, scenarioOnly } from "@langwatch/scenario";
 * import { LangWatchTraceExporter } from "langwatch/observability";
 *
 * export default defineConfig({
 *   observability: {
 *     traceExporter: new LangWatchTraceExporter({
 *       filters: scenarioOnly,
 *     }),
 *     instrumentations: [], // disable auto-instrumentation
 *   },
 * });
 * ```
 */
export const scenarioOnly: TraceFilter[] = [
  {
    include: {
      instrumentationScopeName: [{ equals: "@langwatch/scenario" }],
    },
  },
];

/**
 * Creates a filter that keeps spans from the @langwatch/scenario scope
 * plus any additional custom instrumentation scopes.
 *
 * @param scopes - Additional instrumentation scope names to include
 * @returns Array of TraceFilter rules
 *
 * @example
 * ```typescript
 * import { defineConfig, withCustomScopes } from "@langwatch/scenario";
 * import { LangWatchTraceExporter } from "langwatch/observability";
 *
 * export default defineConfig({
 *   observability: {
 *     traceExporter: new LangWatchTraceExporter({
 *       filters: withCustomScopes("my-app/database", "my-app/agent"),
 *     }),
 *     instrumentations: [], // disable auto-instrumentation
 *   },
 * });
 * ```
 */
export function withCustomScopes(...scopes: string[]): TraceFilter[] {
  return [
    {
      include: {
        instrumentationScopeName: [
          { equals: "@langwatch/scenario" },
          ...scopes.map((scope) => ({ equals: scope })),
        ],
      },
    },
  ];
}
