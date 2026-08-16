import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ModelMessage } from "ai";
import { attributes } from "langwatch/observability";
import {
  langwatchApiSpanToReadableSpan,
  type LangWatchApiSpan,
} from "./langwatch-api-span";
import { createSyntheticErrorSpan } from "./synthetic-error-span";
import type { JudgeSpanCollector } from "../agents/judge/judge-span-collector";
import { getEnv } from "../config/env";
import type { LangwatchConfig } from "../domain/scenarios";
import { Logger } from "../utils/logger";

/** Spans with these name prefixes are scenario infrastructure, not user agent spans. */
const INFRASTRUCTURE_SPAN_PREFIXES = [
  "langwatch.scenario.",
  "langwatch.judge.",
  "langwatch.user_simulator.",
];

/** Poll cadence during the verdict-time settle-wait. */
const POLL_INTERVAL_MS = 1_000;

/** Upper bound for a single trace API request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The invalid W3C trace id, stamped on messages when tracing is off. */
const INVALID_TRACE_ID = "00000000000000000000000000000000";

interface TraceFetchState {
  /** Span ids this fetcher merged into the collector, i.e. the remote spans. */
  mergedSpanIds: Set<string>;
  /** The trace settled; no further fetches needed. */
  settled: boolean;
  /** Terminally finished with a synthetic error span recorded. */
  failed: boolean;
}

interface TraceApiAuth {
  endpoint: string;
  apiKey: string;
}

interface PollResult {
  /** Fetched spans that are not the scenario's own locally collected spans. */
  remoteSpanCount: number;
  /**
   * Every fetched agent span's parent id resolves to another fetched span or
   * to a locally collected span. Ancestors finish and export after their
   * descendants, so unresolved parents mean the agent's trace is still
   * arriving. The scenario's own spans echoed back by the platform are
   * exempt: their parent is often the still-open local turn span, and their
   * ingestion state says nothing about the agent's spans. (Missing leaf
   * subtrees are undetectable from the outside; the deadline bounds those.)
   */
  parentsResolved: boolean;
}

/**
 * A batch of trace ids to fetch for a scenario thread.
 */
export interface RemoteTraceTarget {
  /** The scenario thread the fetched spans belong to. */
  threadId: string;
  /** Trace ids stamped on the conversation's messages, in first-seen order. */
  traceIds: string[];
  /** The judge span collector the fetched spans are fed into. */
  collector: JudgeSpanCollector;
  /** LangWatch endpoint and API key overrides; environment variables otherwise. */
  langwatch?: LangwatchConfig;
}

/**
 * Collects every distinct trace id stamped on the conversation's messages,
 * in first-seen order. Messages without a trace id (scripted content, runs
 * without tracing) are skipped, as is the invalid all-zero trace id produced
 * by a non-recording tracer.
 */
export function collectMessageTraceIds(
  messages: readonly ModelMessage[]
): string[] {
  const seen = new Set<string>();
  const traceIds: string[] = [];
  for (const message of messages) {
    const traceId = (message as { traceId?: unknown }).traceId;
    if (typeof traceId !== "string" || traceId.length === 0) continue;
    if (traceId === INVALID_TRACE_ID) continue;
    if (seen.has(traceId)) continue;
    seen.add(traceId);
    traceIds.push(traceId);
  }
  return traceIds;
}

/**
 * Fetches remote traces from the LangWatch trace API and feeds them into the
 * judge span collector, so the trace digest and the expand_trace/grep_trace
 * tools work on remote spans exactly as they do on local ones.
 *
 * Latency contract: conversation turns never fetch. The verdict settle-waits
 * ({@link settleWait}): each unsettled id is polled every second, all ids in
 * parallel under one shared deadline.
 *
 * A trace settles cleanly when it holds at least one remote span (a fetched
 * span that is not one of the scenario's own locally collected spans) AND
 * every fetched agent span's parent resolves within the fetched and locally
 * collected spans — the trace is complete, because ancestors always finish
 * and export after their descendants. Count-stability is deliberately NOT a
 * settle signal: ingestion arrives in chunks that can be tens of seconds
 * apart, and a stable early chunk would satisfy it while tool spans are
 * still on the way.
 *
 * When the deadline expires with remote spans present but parents still
 * unresolved, the trace settles best-effort: every span that arrived stays
 * in the collector, plus one synthetic `langwatch.span_collection.error`
 * span marking the trace incomplete — so the judge can still pass criteria
 * proven by the visible spans while treating the rest as inconclusive. When
 * the deadline expires with no remote span at all (propagation broken, agent
 * unreachable, agent not instrumented), the synthetic error span reports
 * that nothing was collected. Fetch failures never propagate out of the
 * judge.
 *
 * State is kept per thread id (merged span ids, settled flag) so a trace
 * confirmed complete is never re-fetched; `run()` clears it in the same
 * finally that clears the judge span collector.
 */
export class RemoteTraceFetcher {
  private readonly logger = new Logger("scenario.tracing.RemoteTraceFetcher");
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly registry = new Map<string, Map<string, TraceFetchState>>();

  constructor(options?: { fetchFn?: typeof fetch; pollIntervalMs?: number }) {
    this.fetchFn =
      options?.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  /**
   * Verdict-time wait: polls every unsettled trace id until it settles (see
   * the class doc for the settle conditions), all ids in parallel, under one
   * shared deadline of `timeoutMs` total.
   *
   * A failed poll retries until the deadline; only the deadline marks the id
   * failed and feeds one synthetic `langwatch.span_collection.error` span
   * carrying the reason to the collector. Never throws.
   */
  async settleWait(
    target: RemoteTraceTarget & { timeoutMs: number }
  ): Promise<void> {
    const auth = this.resolveAuth(target.langwatch);
    const deadline = Date.now() + target.timeoutMs;
    const pending = target.traceIds.filter((traceId) =>
      this.isUnsettled(target.threadId, traceId)
    );

    await Promise.all(
      pending.map((traceId) =>
        this.settleOne({
          threadId: target.threadId,
          traceId,
          collector: target.collector,
          auth,
          deadline,
          timeoutMs: target.timeoutMs,
        })
      )
    );
  }

  /**
   * True when not one of the given trace ids ever settled cleanly for this
   * thread. After a settle-wait this means every trace terminally failed,
   * so the run's remote evidence cannot improve with more turns.
   */
  noneSettled(threadId: string, traceIds: string[]): boolean {
    const threadStates = this.registry.get(threadId);
    if (!threadStates) return true;
    return !traceIds.some((traceId) => threadStates.get(traceId)?.settled);
  }

  /**
   * Drops all fetch state for a thread. Called from the `run()` finally,
   * alongside `judgeSpanCollector.clearSpansForThread`, to prevent memory
   * growth in long-lived processes.
   */
  clearForThread(threadId: string): void {
    this.registry.delete(threadId);
  }

  private isUnsettled(threadId: string, traceId: string): boolean {
    const state = this.registry.get(threadId)?.get(traceId);
    if (!state) return true;
    return !state.settled && !state.failed;
  }

  private stateFor(threadId: string, traceId: string): TraceFetchState {
    let threadStates = this.registry.get(threadId);
    if (!threadStates) {
      threadStates = new Map();
      this.registry.set(threadId, threadStates);
    }
    let state = threadStates.get(traceId);
    if (!state) {
      state = {
        mergedSpanIds: new Set(),
        settled: false,
        failed: false,
      };
      threadStates.set(traceId, state);
    }
    return state;
  }

  private async settleOne({
    threadId,
    traceId,
    collector,
    auth,
    deadline,
    timeoutMs,
  }: {
    threadId: string;
    traceId: string;
    collector: JudgeSpanCollector;
    auth: TraceApiAuth;
    deadline: number;
    timeoutMs: number;
  }): Promise<void> {
    const state = this.stateFor(threadId, traceId);
    let lastRemoteSpanCount = 0;
    let lastFetchError: string | undefined;

    while (true) {
      try {
        lastRemoteSpanCount = await this.pollOnce({
          threadId,
          traceId,
          state,
          collector,
          auth,
        });
        lastFetchError = undefined;
      } catch (error) {
        // A failed poll retries until the deadline: a transient error (a
        // request timing out under load, a blip on the API) must not
        // terminally fail the trace while the budget still has time left.
        lastFetchError = error instanceof Error ? error.message : String(error);
        this.logger.debug("Trace poll failed; retrying until the deadline", {
          traceId,
          reason: lastFetchError,
        });
      }

      if (state.settled) return;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (lastRemoteSpanCount >= 1) {
          // Best-effort settle: the spans that arrived stay judged, and the
          // error span tells the judge the trace may be missing spans.
          this.recordFailure({
            threadId,
            traceId,
            collector,
            reason: `Trace ${traceId} was still incomplete after ${timeoutMs}ms: ${lastRemoteSpanCount} remote spans were collected but some parent spans never arrived, so spans may be missing`,
          });
        } else if (lastFetchError) {
          this.recordFailure({
            threadId,
            traceId,
            collector,
            reason: `Fetching trace ${traceId} kept failing until the ${timeoutMs}ms deadline: ${lastFetchError}`,
          });
        } else {
          this.recordFailure({
            threadId,
            traceId,
            collector,
            reason: `Timed out after ${timeoutMs}ms waiting for trace ${traceId}: no agent spans arrived (the agent may not have adopted the propagated trace context or may not report to this LangWatch project)`,
          });
        }
        return;
      }
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  /**
   * One fetch + merge + settle evaluation. Marks the state settled when the
   * trace holds at least one remote span and every fetched agent span's parent
   * resolves (fetched or locally collected). Returns the remote span count
   * of this poll.
   */
  private async pollOnce({
    threadId,
    traceId,
    state,
    collector,
    auth,
  }: {
    threadId: string;
    traceId: string;
    state: TraceFetchState;
    collector: JudgeSpanCollector;
    auth: TraceApiAuth;
  }): Promise<number> {
    const spans = await this.fetchTrace({ traceId, auth });
    const { remoteSpanCount, parentsResolved } = this.merge({
      threadId,
      state,
      collector,
      spans,
    });

    if (remoteSpanCount >= 1 && parentsResolved) {
      state.settled = true;
    }
    return remoteSpanCount;
  }

  /**
   * Marks a trace id terminally failed and feeds one synthetic error span
   * (name `langwatch.span_collection.error`) carrying the reason into the
   * collector, exactly once per trace id.
   */
  private recordFailure({
    threadId,
    traceId,
    collector,
    reason,
  }: {
    threadId: string;
    traceId: string;
    collector: JudgeSpanCollector;
    reason: string;
  }): void {
    const state = this.stateFor(threadId, traceId);
    if (state.failed) return;
    state.failed = true;

    this.logger.warn("Remote trace collection failed", { traceId, reason });
    const errorSpan = createSyntheticErrorSpan({ traceId, reason });
    collector.onEnd(this.tagWithThreadId(errorSpan, threadId));
  }

  /**
   * Filters out scenario infrastructure spans, deduplicates by span id
   * against spans already collected for the thread, tags the remainder with
   * the thread id attribute, and feeds them to the collector. Returns the
   * remote-only span count and whether every fetched agent span's parent id
   * resolves within the fetched spans plus the locally collected ones.
   */
  private merge({
    threadId,
    state,
    collector,
    spans,
  }: {
    threadId: string;
    state: TraceFetchState;
    collector: JudgeSpanCollector;
    spans: LangWatchApiSpan[];
  }): PollResult {
    const collectorSpanIds = new Set(
      collector.getSpansForThread(threadId).map((s) => s.spanContext().spanId)
    );
    // The collector holds both the scenario's own spans and remote spans
    // merged by earlier polls; only the former count as local.
    const localSpanIds = new Set(
      [...collectorSpanIds].filter((id) => !state.mergedSpanIds.has(id))
    );
    const fetchedSpanIds = new Set(
      spans.map((s) => s.span_id).filter((id): id is string => Boolean(id))
    );

    let remoteSpanCount = 0;
    let parentsResolved = spans.length > 0;
    const existingSpanIds = new Set(collectorSpanIds);

    for (const apiSpan of spans) {
      const name = apiSpan.name ?? "";
      if (
        INFRASTRUCTURE_SPAN_PREFIXES.some((prefix) => name.startsWith(prefix))
      ) {
        continue;
      }
      if (!apiSpan.span_id) continue;
      const isLocalEcho = localSpanIds.has(apiSpan.span_id);
      if (!isLocalEcho) {
        remoteSpanCount += 1;
        const parentId = apiSpan.parent_id;
        if (
          parentId &&
          !fetchedSpanIds.has(parentId) &&
          !collectorSpanIds.has(parentId)
        ) {
          parentsResolved = false;
        }
      }
      if (existingSpanIds.has(apiSpan.span_id)) continue;
      existingSpanIds.add(apiSpan.span_id);
      state.mergedSpanIds.add(apiSpan.span_id);

      const readableSpan = langwatchApiSpanToReadableSpan(apiSpan);
      collector.onEnd(this.tagWithThreadId(readableSpan, threadId));
    }

    return { remoteSpanCount, parentsResolved };
  }

  /**
   * Tags a span with the thread id attribute so
   * `JudgeSpanCollector.getSpansForThread()` can find it.
   */
  private tagWithThreadId(span: ReadableSpan, threadId: string): ReadableSpan {
    return {
      ...span,
      attributes: {
        ...span.attributes,
        [attributes.ATTR_LANGWATCH_THREAD_ID]: threadId,
      } as Attributes,
    };
  }

  private async fetchTrace({
    traceId,
    auth,
  }: {
    traceId: string;
    auth: TraceApiAuth;
  }): Promise<LangWatchApiSpan[]> {
    const url = `${auth.endpoint.replace(/\/$/, "")}/api/trace/${traceId}`;

    const response = await this.fetchFn(url, {
      headers: {
        // Dual-emit auth: /api/trace historically authenticates with
        // X-Auth-Token, while newer deployments accept a Bearer token.
        // Sending both keeps the fetch working across LangWatch versions.
        "X-Auth-Token": auth.apiKey,
        Authorization: `Bearer ${auth.apiKey}`,
      },
      // A fixed per-request bound against a hung API. The settle loop owns
      // the shared deadline: shrinking this signal to the remaining budget
      // aborted in-flight polls at the deadline edge, which recorded a
      // misleading hard-failure reason instead of the timeout reason.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 404) {
      // Trace not found yet - spans may not have arrived.
      return [];
    }
    if (!response.ok) {
      throw new Error(
        `Trace API returned ${response.status}: ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      trace_id?: string;
      spans?: LangWatchApiSpan[];
    };
    return data.spans ?? [];
  }

  /**
   * Resolves the trace API endpoint and key the same way the event reporter
   * does: per-run `langwatch` config first, then the LANGWATCH_ENDPOINT /
   * LANGWATCH_API_KEY environment variables (endpoint defaults to
   * https://app.langwatch.ai).
   */
  private resolveAuth(langwatch?: LangwatchConfig): TraceApiAuth {
    const env = getEnv();
    return {
      endpoint: langwatch?.endpoint ?? env.LANGWATCH_ENDPOINT,
      apiKey: langwatch?.apiKey ?? env.LANGWATCH_API_KEY ?? "",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Singleton instance of the remote trace fetcher.
 */
export const remoteTraceFetcher = new RemoteTraceFetcher();
