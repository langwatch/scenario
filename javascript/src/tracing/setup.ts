import { trace } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangWatchTraceExporter } from "langwatch/observability";
import { setupObservability } from "langwatch/observability/node";
import type { SetupObservabilityOptions } from "langwatch/observability/node";
import { judgeSpanCollector } from "../agents/judge/judge-span-collector";
import { getEnv } from "../config";

/**
 * Module-level initialization flag.
 *
 * Safe against concurrent calls because:
 * 1. JavaScript runs on a single event loop thread
 * 2. setupScenarioTracing() is synchronous after the flag check
 * 3. The only async operation (getProjectConfig) completes before this is called
 */
let initialized = false;

/**
 * Returns the concrete OpenTelemetry provider if one exists (not a ProxyTracerProvider).
 * Checks the provider itself and one level of delegation.
 *
 * Known delegate accessor patterns in OTel ProxyTracerProvider:
 * - getDelegate(): Official method in @opentelemetry/api >= 1.3
 * - delegate: Used by some wrapper implementations
 * - _delegate: Internal field in @opentelemetry/api ProxyTracerProvider (private, fragile)
 */
function getConcreteProvider(
  provider: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { addSpanProcessor: (processor: any) => void } | undefined {
  if (!provider || typeof provider !== "object") return undefined;

  if (typeof (provider as Record<string, unknown>).addSpanProcessor === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return provider as { addSpanProcessor: (processor: any) => void };
  }

  // Check one level of delegate (ProxyTracerProvider pattern)
  const p = provider as Record<string, unknown>;
  const delegate =
    typeof p.getDelegate === "function"
      ? (p.getDelegate as () => unknown)()
      : p.delegate ?? p._delegate;

  if (delegate && typeof delegate === "object") {
    if (typeof (delegate as Record<string, unknown>).addSpanProcessor === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return delegate as { addSpanProcessor: (processor: any) => void };
    }
  }

  return undefined;
}

/**
 * Explicitly set up tracing for @langwatch/scenario.
 *
 * Call this before any `run()` invocations when you want full control
 * over the observability configuration. If called, `run()` will skip
 * its own lazy initialization.
 *
 * The `judgeSpanCollector` is always added as a span processor regardless
 * of the user-provided options.
 *
 * @param options - Optional `SetupObservabilityOptions` forwarded to the
 *   langwatch SDK `setupObservability()` function.
 *
 * @example
 * ```typescript
 * import { setupScenarioTracing } from "@langwatch/scenario";
 *
 * setupScenarioTracing({
 *   instrumentations: [],          // disable auto-instrumentation
 *   spanProcessors: [myProcessor], // add custom processors
 * });
 * ```
 */
export function setupScenarioTracing(
  options?: Partial<SetupObservabilityOptions>
): void {
  if (initialized) return;

  const globalProvider = trace.getTracerProvider();
  const concrete = getConcreteProvider(globalProvider);

  if (concrete) {
    // OTel already initialized by another SDK (e.g. @vercel/otel).
    // Attach our processors to the existing provider instead of re-initializing.
    attachToExistingProvider(concrete, options);
  } else {
    // No existing provider; do a full setup via the langwatch SDK.
    initializeFullSetup(options);
  }

  initialized = true;
}

/**
 * Ensures tracing is initialized before a scenario run.
 *
 * Called internally by `run()`. Uses the project config's observability
 * options if available. If `setupScenarioTracing()` was already called,
 * this is a no-op.
 *
 * @param options - Optional `SetupObservabilityOptions` from the project config.
 */
export function ensureTracingInitialized(
  options?: Partial<SetupObservabilityOptions>
): void {
  if (initialized) return;
  setupScenarioTracing(options);
}

/**
 * Attaches the judgeSpanCollector and a LangWatch exporter to an existing
 * concrete TracerProvider. This path is used when another SDK (e.g.
 * @vercel/otel, Datadog) has already initialized OpenTelemetry.
 *
 * Also forwards any user-provided `spanProcessors` and `traceExporter`
 * so they are not silently dropped when attaching to an existing provider.
 */
function attachToExistingProvider(
  // Use `any` for the processor parameter to avoid version conflicts between
  // @opentelemetry/sdk-trace-base versions that pnpm may resolve differently
  // for this package vs the langwatch SDK. The types are structurally identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: { addSpanProcessor: (processor: any) => void },
  options?: Partial<SetupObservabilityOptions>
): void {
  provider.addSpanProcessor(judgeSpanCollector);

  if (options?.spanProcessors) {
    for (const processor of options.spanProcessors) {
      provider.addSpanProcessor(processor);
    }
  }

  if (options?.traceExporter) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider.addSpanProcessor(new SimpleSpanProcessor(options.traceExporter as any));
  }

  const envConfig = getEnv();
  if (envConfig.LANGWATCH_API_KEY) {
    const exporter = new LangWatchTraceExporter({
      apiKey: envConfig.LANGWATCH_API_KEY,
      endpoint: envConfig.LANGWATCH_ENDPOINT,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as any));
  }
}

/**
 * Performs a full OTel setup via the langwatch SDK's `setupObservability()`.
 * Always injects `judgeSpanCollector` as a span processor.
 */
function initializeFullSetup(
  options?: Partial<SetupObservabilityOptions>
): void {
  const envConfig = getEnv();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spanProcessors: any[] = [judgeSpanCollector];
  if (options?.spanProcessors) {
    spanProcessors.push(...options.spanProcessors);
  }

  setupObservability({
    ...options,
    langwatch:
      options?.langwatch ?? {
        apiKey: envConfig.LANGWATCH_API_KEY,
        endpoint: envConfig.LANGWATCH_ENDPOINT,
      },
    spanProcessors,
  });
}

/**
 * Resets the initialization flag. Only for testing purposes.
 * @internal
 */
export function _resetTracingForTests(): void {
  initialized = false;
}
