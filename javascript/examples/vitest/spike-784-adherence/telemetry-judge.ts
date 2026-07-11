/**
 * telemetry-judge — ship the HARNESS-side judge verdict (scores + reasoning) to
 * LangWatch, ATTACHED to the run's traces (owner requirement, 2026-07-11).
 *
 * WHY this exists: the adherence/rubric judge runs in the HARNESS process (not the
 * sandboxed `claude -p` subject session), so its verdict is NOT in the CC-session
 * OTLP stream that `sandbox.ts#otelWiring` wires up. This module emits the verdict
 * itself as a single OTLP span, tagged with the SAME per-run correlation resource
 * attributes (`run.id`, `experiment=sc784`, `strategy`, `scenario`, `enduser.id` —
 * see {@link runResourceAttrs} in sandbox.ts) so LangWatch groups it with the run's
 * CC-session traces.
 *
 * HARD guarantees (non-negotiable — see #784 spike constraints):
 *   1. FAIL-OPEN. No `ik-lw-` ingestion key ⇒ ZERO emit, ZERO fetch, immediate
 *      return. Absent the key the run is byte-identical (variance runs unaffected).
 *   2. FIRE-AND-FORGET. Every path is wrapped in try/catch with a short
 *      AbortController timeout; a LangWatch failure/timeout can NEVER throw, fail,
 *      or meaningfully slow a run. The local checkpoint.json + JSONL stay
 *      authoritative — this telemetry is best-effort only.
 *   3. ADDITIVE. Nothing here touches judge logic, run flow, or the CC-session OTel
 *      wiring; it only POSTs a JSON span.
 *
 * TRANSPORT: OTLP/HTTP **JSON** (not protobuf) to `${LW_OTLP_ENDPOINT}/v1/traces`
 * with `Authorization: Bearer <ik-lw- key>`. JSON is chosen because it needs no
 * protobuf codec / OTEL SDK (this module depends on `node:crypto` only), and the
 * exact JSON span shape below is the one PROVEN to ingest `rejectedSpans:0` in
 * `sol.langwatch-cc-governance-otlp-setup` ("Verify — what counts as proof").
 *
 * DECOUPLING: the ONLY runtime dependency is `node:crypto`. `AdherenceReport` /
 * `RubricResult` are imported as TYPES (erased at build/run time), and the sandbox
 * defaults (`loadIngestionKey`, `LW_OTLP_ENDPOINT`) are pulled via a LAZY dynamic
 * import reached only on the real emit path — so the emitter (and its offline
 * proofs) never drag the heavy `@langwatch/scenario` chain into the process.
 */

import { randomBytes } from "node:crypto";

import type { AdherenceReport } from "./types.ts";
import type { RubricResult } from "./rubric-core.ts";

// ---------------------------------------------------------------------------
// Minimal OTLP/HTTP JSON shapes (no @opentelemetry dependency).
// ---------------------------------------------------------------------------

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string } // proto3 JSON encodes int64 as a string
  | { doubleValue: number };

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
}

/** The OTLP/HTTP JSON `/v1/traces` request body (single resource, single span). */
export interface OtlpTracePayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

const sAttr = (key: string, v: string): OtlpKeyValue => ({ key, value: { stringValue: v } });
const bAttr = (key: string, v: boolean): OtlpKeyValue => ({ key, value: { boolValue: v } });
const iAttr = (key: string, v: number): OtlpKeyValue => ({ key, value: { intValue: String(Math.trunc(v)) } });
const dAttr = (key: string, v: number): OtlpKeyValue => ({ key, value: { doubleValue: v } });

// ---------------------------------------------------------------------------
// Public contract.
// ---------------------------------------------------------------------------

/** The harness-side verdict + the run's correlation attributes to emit. */
export interface JudgeVerdictEmit {
  /**
   * The resolved per-run correlation resource attributes — pass
   * `sandbox.otelResourceAttrs` so this span carries the SAME `run.id`,
   * `experiment=sc784`, `strategy`, `scenario`, `enduser.id` that
   * `otelWiring` tagged the CC-session OTLP stream with (this is the correlation
   * key LangWatch groups the run's signals by).
   */
  resourceAttrs: Record<string, string>;
  /** The full adherence verdict (per-procedure followed/attribution/reasoning + rate). */
  report?: AdherenceReport;
  /** The rubric verdict (prove/quality scenario only). */
  rubric?: RubricResult;
  /** Human-readable scenario id (may differ from the correlation `scenario` tag). */
  scenarioId?: string;
  /** Strategy name (human span attr; correlation `strategy` rides resourceAttrs). */
  strategy?: string;
  /** The judge model that actually answered the verdict. */
  judgeModel?: string;
  /** The subject model `claude -p` resolved to (logged variable). */
  subjectModel?: string;
  /** `scenario.run` success flag. */
  scenarioRunSuccess?: boolean;
  /** Checkpoint status (judged / excluded / ...). */
  status?: string;
}

/** Response shape the emitter needs from a fetch impl (a subset of `Response`). */
interface FetchResponseLike {
  ok?: boolean;
  status: number;
  text: () => Promise<string>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface EmitOptions {
  /** Explicit ingestion key (tests pass a fake `ik-lw-…`). */
  key?: string;
  /** Override the key resolver (tests force `() => undefined` for the fail-open path). */
  loadKey?: () => string | undefined;
  /** Override the OTLP endpoint base (default: sandbox `LW_OTLP_ENDPOINT`, lazy). */
  endpoint?: string;
  /** Injectable fetch (tests capture the POST; never hits the network). */
  fetchImpl?: FetchLike;
  /** Abort timeout for the POST (ms). Default 4000, or `ADHERENCE_JUDGE_EMIT_TIMEOUT_MS`. */
  timeoutMs?: number;
  logger?: (msg: string) => void;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
  /** Injectable 32-hex traceId generator for deterministic tests. */
  genTraceId?: () => string;
  /** Injectable 16-hex spanId generator for deterministic tests. */
  genSpanId?: () => string;
}

export interface EmitResult {
  /** True only when the POST landed AND the backend rejected 0 spans. */
  emitted: boolean;
  /** Why nothing was emitted (`no-ingestion-key`, or a swallowed error message). */
  reason?: string;
  status?: number;
  rejectedSpans?: number;
  /** The traceId minted for the emitted span (for cross-referencing). */
  traceId?: string;
}

/**
 * Build the OTLP/HTTP JSON trace payload for a judge verdict. PURE — no I/O, no
 * key — so the structure can be asserted offline. Carries scores AND reasoning:
 * the full per-procedure verdict (`adherence.per_procedure` = JSON of
 * `{id, applied, followed, transitiveChainFollowed, surfaced, attribution,
 * reasoning}`) plus a flattened human `adherence.reasoning`, and, when present,
 * the rubric block (`rubric.per_criterion` = JSON of `{id, met, reasoning}`).
 */
export function buildJudgeSpanPayload(
  emit: JudgeVerdictEmit,
  ids: { traceId: string; spanId: string; startTimeUnixNano: string; endTimeUnixNano: string },
): OtlpTracePayload {
  const resourceAttributes: OtlpKeyValue[] = Object.entries(emit.resourceAttrs).map(([k, v]) => sAttr(k, v));

  const spanAttrs: OtlpKeyValue[] = [sAttr("langwatch.span.type", "evaluation")];
  if (emit.strategy) spanAttrs.push(sAttr("adherence.strategy", emit.strategy));
  if (emit.scenarioId) spanAttrs.push(sAttr("judge.scenario_id", emit.scenarioId));
  if (emit.judgeModel) spanAttrs.push(sAttr("judge.model", emit.judgeModel));
  if (emit.subjectModel) spanAttrs.push(sAttr("judge.subject_model", emit.subjectModel));
  if (typeof emit.scenarioRunSuccess === "boolean") spanAttrs.push(bAttr("scenario.run_success", emit.scenarioRunSuccess));
  if (emit.status) spanAttrs.push(sAttr("checkpoint.status", emit.status));

  const r = emit.report;
  if (r) {
    spanAttrs.push(sAttr("judge.kind", "adherence"));
    spanAttrs.push(dAttr("adherence.rate", r.adherenceRate));
    spanAttrs.push(iAttr("adherence.followed_count", r.followedCount));
    spanAttrs.push(iAttr("adherence.applicable_count", r.applicableCount));
    if (typeof r.belowFloor === "boolean") spanAttrs.push(bAttr("adherence.below_floor", r.belowFloor));
    if (r.model) spanAttrs.push(sAttr("adherence.judge_model", r.model));
    // FULL per-procedure verdict — scores AND reasoning (owner: "scores AND reasoning").
    spanAttrs.push(sAttr("adherence.per_procedure", JSON.stringify(r.perProcedure)));
    const reasoning = r.perProcedure
      .map((p) => `${p.id} [followed=${p.followed}, attribution=${p.attribution}, surfaced=${p.surfaced}]: ${p.reasoning}`)
      .join("\n");
    spanAttrs.push(sAttr("adherence.reasoning", reasoning));
  }

  const rb = emit.rubric;
  if (rb) {
    spanAttrs.push(sAttr("rubric.kind", "quality"));
    spanAttrs.push(iAttr("rubric.score", rb.score));
    spanAttrs.push(iAttr("rubric.total", rb.total));
    spanAttrs.push(bAttr("rubric.passed", rb.passed));
    if (rb.model) spanAttrs.push(sAttr("rubric.judge_model", rb.model));
    if (typeof rb.emptyArtifact === "boolean") spanAttrs.push(bAttr("rubric.empty_artifact", rb.emptyArtifact));
    spanAttrs.push(sAttr("rubric.per_criterion", JSON.stringify(rb.perCriterion)));
    const rubricReasoning = rb.perCriterion.map((c) => `${c.id} [met=${c.met}]: ${c.reasoning}`).join("\n");
    spanAttrs.push(sAttr("rubric.reasoning", rubricReasoning));
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: "sc784.judge", version: "1" },
            spans: [
              {
                traceId: ids.traceId,
                spanId: ids.spanId,
                name: "sc784.judge.verdict",
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: ids.startTimeUnixNano,
                endTimeUnixNano: ids.endTimeUnixNano,
                attributes: spanAttrs,
              },
            ],
          },
        ],
      },
    ],
  };
}

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

/**
 * Emit a judge verdict to LangWatch, correlated with the run. FAIL-OPEN and
 * fire-and-forget: returns `{emitted:false, reason:"no-ingestion-key"}` WITHOUT
 * any fetch when no `ik-lw-` key resolves, and swallows every error/timeout so a
 * LangWatch problem can never fail or slow a run. NEVER throws.
 */
export async function emitJudgeVerdict(emit: JudgeVerdictEmit, opts: EmitOptions = {}): Promise<EmitResult> {
  const log = opts.logger ?? ((): void => undefined);
  try {
    // ---- FAIL-OPEN gate: resolve the key FIRST; no key ⇒ zero emit, zero fetch ----
    // Precedence: explicit key > injected loader > sandbox.loadIngestionKey (lazy).
    // The lazy import keeps this module free of a static @langwatch/sandbox chain and
    // is only ever reached when neither `key` nor `loadKey` is provided.
    let key: string | undefined = opts.key;
    let sandboxMod: typeof import("./sandbox.ts") | undefined;
    if (key === undefined) {
      if (opts.loadKey) {
        key = opts.loadKey();
      } else {
        sandboxMod = await import("./sandbox.ts");
        key = sandboxMod.loadIngestionKey();
      }
    }
    if (!key) return { emitted: false, reason: "no-ingestion-key" };

    // ---- key present: build + POST the span (all still inside try/catch) ----
    let endpoint = opts.endpoint;
    if (endpoint === undefined) {
      sandboxMod = sandboxMod ?? (await import("./sandbox.ts"));
      endpoint = sandboxMod.LW_OTLP_ENDPOINT;
    }
    const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`;

    const nowMs = Math.trunc((opts.now ?? Date.now)());
    const startNano = BigInt(nowMs) * 1_000_000n;
    const traceId = (opts.genTraceId ?? ((): string => randomHex(16)))();
    const spanId = (opts.genSpanId ?? ((): string => randomHex(8)))();
    const payload = buildJudgeSpanPayload(emit, {
      traceId,
      spanId,
      startTimeUnixNano: String(startNano),
      endTimeUnixNano: String(startNano + 1_000_000n), // +1ms, non-zero duration
    });
    const body = JSON.stringify(payload);

    const envTimeout = Number(process.env.ADHERENCE_JUDGE_EMIT_TIMEOUT_MS);
    const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 4000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });
      // A bare 200 is NOT proof of ingestion — check partialSuccess.rejectedSpans.
      let rejectedSpans: number | undefined;
      try {
        const parsed = JSON.parse(await res.text()) as { partialSuccess?: { rejectedSpans?: number | string } };
        const rej = parsed.partialSuccess?.rejectedSpans;
        rejectedSpans = rej === undefined || rej === null ? 0 : Number(rej);
      } catch {
        /* body unreadable/non-JSON — best-effort; leave rejectedSpans undefined */
      }
      const okStatus = res.ok ?? (res.status >= 200 && res.status < 300);
      const rejected = typeof rejectedSpans === "number" && rejectedSpans > 0;
      if (rejected) {
        log(`[judge-telemetry] endpoint rejected ${rejectedSpans} span(s) (HTTP ${res.status}) — verdict NOT attached`);
      } else {
        log(`[judge-telemetry] verdict emitted (HTTP ${res.status}, rejectedSpans=${rejectedSpans ?? "?"}) trace=${traceId}`);
      }
      return { emitted: okStatus && !rejected, status: res.status, rejectedSpans, traceId };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Fire-and-forget: a network error / timeout / abort must NEVER fail a run.
    log(`[judge-telemetry] emit failed (swallowed): ${(e as Error).message}`);
    return { emitted: false, reason: (e as Error).message };
  }
}
