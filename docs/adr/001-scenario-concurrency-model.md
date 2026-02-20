# ADR-001: Scenario Concurrency Model — Per-Call Isolation

**Date:** 2026-02-20

**Status:** Accepted

## Context

The `@langwatch/scenario` test runner needs to support concurrent execution of scenario tests, where each run may target a different LangWatch project with its own API key and endpoint.

The original implementation used environment variables (`LANGWATCH_API_KEY`, `LANGWATCH_ENDPOINT`, `SCENARIO_BATCH_RUN_ID`) as the configuration mechanism. Because environment variables are process-wide shared state, concurrent `run()` calls would overwrite each other's config, causing events to be routed to the wrong project. This required a mutex to serialize runs, eliminating any concurrency benefit.

The LangWatch platform orchestrates batch scenario runs on behalf of multiple projects simultaneously, making true concurrency a hard requirement.

## Decision

We will use per-call programmatic configuration instead of environment variables. Each call to `run()` accepts an optional `RunOptions` parameter containing `LangwatchConfig` (endpoint, apiKey) and `batchRunId`. Each call creates its own `EventBus` instance scoped to that configuration.

Environment variables remain as a fallback for single-project CLI usage, but programmatic config takes precedence via nullish coalescing (`options?.langwatch?.apiKey ?? envConfig.LANGWATCH_API_KEY`).

The `batchRunId` is resolved once at the `run()` boundary and passed as a constructor argument to `ScenarioExecution`, rather than being read from the environment at event-emit time.

## Consequences

- **Concurrent runs are fully isolated.** Each `run()` call gets its own EventBus, its own config, and its own batchRunId. No mutex needed.
- **No process-wide state mutation.** Config flows through function arguments, not environment variables.
- **Backward compatible.** Existing users relying on env vars continue to work without changes.
- **`LangwatchConfig` fields are optional.** Callers can override just the API key, just the endpoint, or both — unset fields fall back to env vars.
- **`ScenarioExecution` constructor now requires `batchRunId`.** This is a breaking change for any direct consumers of `ScenarioExecution` (not `run()`), though this class is not part of the public API.

## References

- PR: https://github.com/langwatch/scenario/pull/207
- Upstream consumer: https://github.com/langwatch/langwatch/pull/1074
