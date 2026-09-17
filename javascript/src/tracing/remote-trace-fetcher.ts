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

/**
 * The abort the settle loop caused itself by bounding a request to what was
 * left of the shared deadline. It is not an API failure, so the deadline
 * branch keeps the timeout reason rather than reporting a failing fetch.
 */
class DeadlineAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineAbortError";
  }
}

interface TraceFetchState {
  /** Span ids this fetcher merged into the collector, i.e. the remote spans. */
  mergedSpanIds: Set<string>;
  /** The trace settled; no further fetches needed. */
  settled: boolean;
  /** Terminally finished with a synthetic error span recorded. */
  failed: boolean;
  /**
   * The synthetic error span recorded for this trace, so an extension wait
   * can retract it when the trace settles after all.
   */
  errorSpanId?: string;
}

interface TraceApiAuth {
  endpoint: string;
  apiKey: string;
  /**
   * Scopes a bearer or PAT credential to one project. The platform resolves
   * the `Authorization: Bearer` branch first, and that branch rejects an
   * organization-wide key that arrives without `X-Project-Id`.
   */
  projectId: string | undefined;
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
   * carrying the reason to the collector. Never throws. Returns whether every
   * given trace id is settled cleanly after the wait.
   */
  async settleWait(
    target: RemoteTraceTarget & { timeoutMs: number }
  ): Promise<{ allSettled: boolean }> {
    const auth = this.resolveAuth(target.langwatch);
    const deadline = Date.now() + target.timeoutMs;
    // Every trace this wait touches is claimed for the thread, so the
    // collector's per-thread clear can release the process-span registry
    // entries of traces whose local echoes never end or never associate
    // with the thread.
    target.collector.claimTraces(target.threadId, target.traceIds);
    const pending = target.traceIds.filter((traceId) =>
      this.isUnsettled(target.threadId, traceId)
    );

    // Without an endpoint or a key every poll answers 401 and the loop burns
    // the whole wait budget before it can say why. Fail the ids now instead.
    if (!auth.endpoint || !auth.apiKey) {
      for (const traceId of pending) {
        this.recordFailure({
          threadId: target.threadId,
          traceId,
          collector: target.collector,
          reason: `Cannot fetch trace ${traceId}: remote trace fetching is on but the LangWatch ${
            auth.endpoint ? "API key" : "endpoint"
          } is not configured (set LANGWATCH_API_KEY and LANGWATCH_ENDPOINT, or pass them in the run's langwatch config)`,
        });
      }
      return { allSettled: false };
    }

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
    return { allSettled: this.allSettled(target.threadId, target.traceIds) };
  }

  /**
   * The judge's one extra wait: re-arms every trace that terminally failed
   * the first settle-wait (retracting its synthetic error span from the
   * collector) and settle-waits once more under `timeoutMs`. A trace that
   * fails again gets a fresh error span with the new reason. Returns whether
   * every given trace id is settled cleanly afterwards.
   */
  async extendSettle(
    target: RemoteTraceTarget & { timeoutMs: number }
  ): Promise<{ allSettled: boolean }> {
    const threadStates = this.registry.get(target.threadId);
    for (const traceId of target.traceIds) {
      const state = threadStates?.get(traceId);
      if (!state?.failed) continue;
      state.failed = false;
      if (state.errorSpanId) {
        target.collector.removeSpanById(state.errorSpanId);
        state.errorSpanId = undefined;
      }
    }
    return this.settleWait(target);
  }

  private allSettled(threadId: string, traceIds: string[]): boolean {
    const threadStates = this.registry.get(threadId);
    return traceIds.every((traceId) =>
      Boolean(threadStates?.get(traceId)?.settled)
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
   * Records the "nothing to fetch" case: remote fetching is on, but not one
   * message of the conversation carries a trace id, so there is no id to
   * poll. Feeds the same synthetic error span the deadline path feeds, once
   * per thread, so the judge reads why the traces section is empty instead
   * of returning inconclusive criteria with no stated reason.
   */
  recordMissingTraceIds({
    threadId,
    collector,
  }: {
    threadId: string;
    collector: JudgeSpanCollector;
  }): void {
    this.recordFailure({
      threadId,
      traceId: INVALID_TRACE_ID,
      collector,
      reason:
        "Remote trace fetching is on but no message of this conversation carries a trace id, so no trace could be fetched. The agent adapter has to return the trace id of the run (or forward input.propagationHeaders so the agent joins the scenario's trace).",
    });
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
          deadline,
        });
        lastFetchError = undefined;
      } catch (error) {
        // A failed poll retries until the deadline: a transient error (a
        // request timing out under load, a blip on the API) must not
        // terminally fail the trace while the budget still has time left.
        //
        // Our own deadline abort is not one of those. Recording it would
        // report "kept failing" for a run whose real story is "nothing
        // arrived in time", so the earlier error, if any, stands instead.
        const reason = error instanceof Error ? error.message : String(error);
        if (!(error instanceof DeadlineAbortError)) {
          lastFetchError = reason;
        }
        this.logger.debug("Trace poll failed; retrying until the deadline", {
          traceId,
          reason,
        });
      }

      if (state.settled) return;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (lastRemoteSpanCount >= 1) {
          // Best-effort settle: the spans that arrived stay judged, and the
          // error span tells the judge the trace may be missing spans. The
          // count comes from the last poll that succeeded, so a later poll
          // may still have failed: name that error too, or the reason reads
          // as a pure completeness problem.
          const fetchSuffix = lastFetchError
            ? `; the last poll also failed: ${lastFetchError}`
            : "";
          this.recordFailure({
            threadId,
            traceId,
            collector,
            reason: `Trace ${traceId} was still incomplete after ${timeoutMs}ms: ${lastRemoteSpanCount} remote spans were collected but some parent spans never arrived, so spans may be missing${fetchSuffix}`,
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
    deadline,
  }: {
    threadId: string;
    traceId: string;
    state: TraceFetchState;
    collector: JudgeSpanCollector;
    auth: TraceApiAuth;
    deadline: number;
  }): Promise<number> {
    const spans = await this.fetchTrace({ traceId, auth, deadline });
    const { remoteSpanCount, parentsResolved } = this.merge({
      threadId,
      traceId,
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
    state.errorSpanId = errorSpan.spanContext().spanId;
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
    traceId,
    state,
    collector,
    spans,
  }: {
    threadId: string;
    traceId: string;
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
      // A span this process started itself is a platform echo, never remote
      // evidence. The registry check covers what the per-thread view cannot:
      // spans whose ancestor chain crosses the still-open turn span, and
      // spans from instrumented SDKs that never tag the thread id (the
      // judge's and user simulator's own model calls).
      const isLocalEcho =
        localSpanIds.has(apiSpan.span_id) ||
        collector.isProcessSpan(traceId, apiSpan.span_id);
      if (!isLocalEcho) {
        remoteSpanCount += 1;
        const parentId = apiSpan.parent_id;
        if (
          parentId &&
          !fetchedSpanIds.has(parentId) &&
          !collectorSpanIds.has(parentId) &&
          !collector.isProcessSpan(traceId, parentId)
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
    deadline,
  }: {
    traceId: string;
    auth: TraceApiAuth;
    deadline: number;
  }): Promise<LangWatchApiSpan[]> {
    const url = `${auth.endpoint.replace(/\/$/, "")}/api/trace/${traceId}`;

    const headers: Record<string, string> = {
      // Dual-emit auth: /api/trace historically authenticates with
      // X-Auth-Token, while newer deployments accept a Bearer token.
      // Sending both keeps the fetch working across LangWatch versions.
      "X-Auth-Token": auth.apiKey,
      Authorization: `Bearer ${auth.apiKey}`,
    };
    // The Bearer branch resolves first on the platform, and it rejects a PAT
    // or organization key that is not scoped to a project. The event reporter
    // sends the same header for the same reason.
    if (auth.projectId) {
      headers["X-Project-Id"] = auth.projectId;
    }

    // Two bounds, whichever is nearer: a fixed guard against a hung API, and
    // what is left of the settle loop's shared deadline. Without the second
    // one a stalled request outlives a short budget, so a 10s run waits the
    // full request timeout before the loop can see it expired.
    //
    // The abort runs on our own controller rather than AbortSignal.timeout
    // so the flag below is set by us, not inferred from the clock or from
    // whatever error shape the fetch implementation throws on abort. A
    // computed budget is fractional (1.25 * p95 + 5s), so the delay is
    // rounded up before it reaches a timer.
    const budgetRemaining = deadline - Date.now();
    const boundedByDeadline = budgetRemaining <= REQUEST_TIMEOUT_MS;
    const boundMs = Math.max(
      1,
      Math.ceil(Math.min(REQUEST_TIMEOUT_MS, budgetRemaining))
    );
    const controller = new AbortController();
    let abortedByDeadline = false;
    const timer = setTimeout(() => {
      abortedByDeadline = boundedByDeadline;
      controller.abort();
    }, boundMs);

    // The timer stays armed through the body read: a server that answers
    // with headers and then stalls the body would otherwise hang the settle
    // loop with nothing left to abort it.
    try {
      const response = await this.fetchFn(url, {
        headers,
        signal: controller.signal,
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
    } catch (error) {
      // Our own abort at the deadline is not an API failure. settleOne reads
      // this type and keeps the timeout reason instead of reporting a fetch
      // that "kept failing".
      if (abortedByDeadline) {
        throw new DeadlineAbortError(
          `Trace fetch for ${traceId} was aborted at the settle deadline`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
      projectId: langwatch?.projectId ?? env.LANGWATCH_PROJECT_ID,
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
