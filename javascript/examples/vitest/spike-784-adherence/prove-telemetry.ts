/**
 * prove-telemetry — OFFLINE proof for `telemetry-judge.ts`. NO network, NO live
 * `claude -p` session, NO Max spend. Proves the two properties that matter with
 * the `ik-lw-` key ABSENT:
 *
 *   P1 FAIL-OPEN (hermetic)   — no resolvable key ⇒ emitter returns immediately,
 *                               attempts ZERO fetch.
 *   P2 FAIL-OPEN (default)    — the real default path (no injected key/loader) also
 *                               fails open: no fetch, no throw (robust even though
 *                               the box's `@langwatch/scenario` runtime import is
 *                               currently broken — a broken dep still can't break a
 *                               run).
 *   P3 KEY-STATE (box)        — none of the three key sources `loadIngestionKey`
 *                               reads currently yields an `ik-lw-` key ⇒ fail-open
 *                               is ACTIVE right now.
 *   P4 STRUCTURE (fake key)   — with a FAKE key + a STUBBED fetch, the emitter POSTs
 *                               a well-formed OTLP span to `…/api/otel/v1/traces`
 *                               carrying the run.id / experiment / strategy /
 *                               scenario correlation attrs + the judge scores AND
 *                               reasoning + the rubric block. Asserts shape only;
 *                               never hits the real endpoint.
 *   P5 DRIFT GUARD (source)   — `runResourceAttrs` and `otelWiring` in sandbox.ts
 *                               encode the SAME correlation keys (so the judge span
 *                               and the CC-session traces always correlate).
 *
 * Run:  tsx prove-telemetry.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  emitJudgeVerdict,
  buildJudgeSpanPayload,
  type JudgeVerdictEmit,
  type OtlpTracePayload,
} from "./telemetry-judge.ts";
import type { AdherenceReport } from "./types.ts";
import type { RubricResult } from "./rubric-core.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- shared fixtures ----
const resourceAttrs: Record<string, string> = {
  "project.repo": "langwatch/scenario",
  experiment: "sc784",
  strategy: "h3",
  scenario: "context-load-refund",
  "run.id": "h3-1780000000000",
  "enduser.id": "andrew@langwatch.ai",
};
const report: AdherenceReport = {
  perProcedure: [
    {
      id: "handle-refund",
      applied: true,
      followed: true,
      transitiveChainFollowed: false,
      surfaced: true,
      attribution: "none",
      reasoning: "Read the refund policy and issued the refund via the seeded tool.",
    },
    {
      id: "reconcile-invoice",
      applied: true,
      followed: false,
      transitiveChainFollowed: null,
      surfaced: true,
      attribution: "agent-override",
      reasoning: "Transitive hand-off skipped; never reconciled the invoice.",
    },
  ],
  applicableCount: 2,
  followedCount: 1,
  adherenceRate: 0.5,
  model: "gpt-5.1",
};
const rubric: RubricResult = {
  perCriterion: [
    { id: "cites-evidence", met: true, reasoning: "Every claim cited the seeded incident log." },
    { id: "root-cause-identified", met: false, reasoning: "Named a symptom, not the root cause." },
  ],
  score: 1,
  total: 2,
  passed: false,
  model: "gpt-5.1",
};
const emit: JudgeVerdictEmit = {
  resourceAttrs,
  report,
  rubric,
  scenarioId: "context-load-prove",
  strategy: "h3",
  judgeModel: "gpt-5.1",
  subjectModel: "claude-opus-4-8",
  scenarioRunSuccess: false,
  status: "judged",
};

function findAttr(attrs: Array<{ key: string; value: unknown }>, key: string): Record<string, unknown> | undefined {
  const a = attrs.find((x) => x.key === key);
  return a ? (a.value as Record<string, unknown>) : undefined;
}

async function main(): Promise<void> {
  // =========================================================================
  console.log("\nP1 FAIL-OPEN (hermetic: loadKey -> undefined) — must NOT fetch");
  {
    let fetchCalls = 0;
    const spyFetch = async (): Promise<{ status: number; text: () => Promise<string> }> => {
      fetchCalls++;
      throw new Error("fetch MUST NOT be called on the no-key path");
    };
    const res = await emitJudgeVerdict(emit, {
      loadKey: () => undefined,
      fetchImpl: spyFetch as unknown as EmitFetch,
    });
    check("returns emitted=false", res.emitted === false, JSON.stringify(res));
    check('reason === "no-ingestion-key"', res.reason === "no-ingestion-key", JSON.stringify(res));
    check("ZERO fetch attempts", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    check("no status / no traceId (nothing built)", res.status === undefined && res.traceId === undefined);
  }

  // =========================================================================
  console.log("\nP2 FAIL-OPEN (default path: no key, no loader) — no fetch, no throw");
  {
    let fetchCalls = 0;
    const spyFetch = async (): Promise<{ status: number; text: () => Promise<string> }> => {
      fetchCalls++;
      throw new Error("fetch MUST NOT be called when no key resolves");
    };
    let threw = false;
    let res: Awaited<ReturnType<typeof emitJudgeVerdict>> | undefined;
    try {
      res = await emitJudgeVerdict(emit, { fetchImpl: spyFetch as unknown as EmitFetch });
    } catch {
      threw = true;
    }
    check("never throws", threw === false);
    check("returns emitted=false", res?.emitted === false, JSON.stringify(res));
    check("ZERO fetch attempts", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  }

  // =========================================================================
  console.log("\nP3 KEY-STATE (box) — no ik-lw- key from any source loadIngestionKey reads");
  {
    const envKey = process.env.LANGWATCH_INGESTION_KEY;
    check("env LANGWATCH_INGESTION_KEY absent/non-ik", !envKey || !envKey.startsWith("ik-lw-"), `env=${envKey ? "set" : "unset"}`);

    let dropped = "";
    try {
      dropped = readFileSync(join(homedir(), ".claude/orchardist/sc784-ik-lw.key"), "utf8").trim();
    } catch {
      /* absent — good */
    }
    check("owner drop-path key absent/non-ik", !dropped.startsWith("ik-lw-"), dropped ? "present!" : "absent");

    const envPath = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
    let dotenvKey = "";
    try {
      const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("LANGWATCH_INGESTION_KEY="));
      dotenvKey = line?.slice("LANGWATCH_INGESTION_KEY=".length).replace(/^["']|["']$/g, "").trim() ?? "";
    } catch {
      /* .env unreadable — treat as absent */
    }
    check(".env LANGWATCH_INGESTION_KEY absent/non-ik", !dotenvKey.startsWith("ik-lw-"), dotenvKey ? "present!" : "absent");
    console.log("  => fail-open is ACTIVE: no key present, so every emit is a no-op today.");
  }

  // =========================================================================
  console.log("\nP4 STRUCTURE (fake key + stubbed fetch) — well-formed OTLP span w/ scores+reasoning");
  {
    let captured: { url: string; init: { headers: Record<string, string>; body: string; method: string } } | undefined;
    const captureFetch = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
      captured = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ partialSuccess: { rejectedSpans: 0 } }) };
    };
    const res = await emitJudgeVerdict(emit, {
      key: "ik-lw-FAKEKEY",
      endpoint: "https://app.langwatch.ai/api/otel",
      fetchImpl: captureFetch as unknown as EmitFetch,
      now: () => 1_780_000_000_000,
      genTraceId: () => "a".repeat(32),
      genSpanId: () => "b".repeat(16),
    });

    check("result.emitted === true", res.emitted === true, JSON.stringify(res));
    check("result.status === 200", res.status === 200);
    check("result.rejectedSpans === 0", res.rejectedSpans === 0);
    check("result.traceId is the minted 32-hex", res.traceId === "a".repeat(32));

    check("fetch was called", captured !== undefined);
    check("POST to …/api/otel/v1/traces", captured?.url === "https://app.langwatch.ai/api/otel/v1/traces", captured?.url);
    check("method POST", captured?.init.method === "POST");
    check("Authorization Bearer <fake ik-lw->", captured?.init.headers.Authorization === "Bearer ik-lw-FAKEKEY");
    check("Content-Type application/json", captured?.init.headers["Content-Type"] === "application/json");

    const payload = JSON.parse(captured?.init.body ?? "{}") as OtlpTracePayload;
    const rs = payload.resourceSpans?.[0];
    const span = rs?.scopeSpans?.[0]?.spans?.[0];
    const rattrs = rs?.resource.attributes ?? [];
    const sattrs = span?.attributes ?? [];

    // --- correlation resource attributes (the grouping key) ---
    check("resource run.id correlates", (findAttr(rattrs, "run.id")?.stringValue as string) === "h3-1780000000000");
    check("resource experiment=sc784", (findAttr(rattrs, "experiment")?.stringValue as string) === "sc784");
    check("resource strategy=h3", (findAttr(rattrs, "strategy")?.stringValue as string) === "h3");
    check("resource scenario=context-load-refund", (findAttr(rattrs, "scenario")?.stringValue as string) === "context-load-refund");
    check("resource project.repo", (findAttr(rattrs, "project.repo")?.stringValue as string) === "langwatch/scenario");
    check("resource enduser.id", (findAttr(rattrs, "enduser.id")?.stringValue as string) === "andrew@langwatch.ai");

    // --- span envelope (sol-doc required fields) ---
    check("span name", span?.name === "sc784.judge.verdict");
    check("span kind=1", span?.kind === 1);
    check("span traceId 32-hex", /^[0-9a-f]{32}$/.test(span?.traceId ?? ""));
    check("span spanId 16-hex", /^[0-9a-f]{16}$/.test(span?.spanId ?? ""));
    check("span start nano set", span?.startTimeUnixNano === "1780000000000000000");
    check("span end nano > start", span?.endTimeUnixNano === "1780000000001000000");
    check("span has its own attributes[]", Array.isArray(span?.attributes));

    // --- SCORES ---
    check("adherence.rate=0.5 (double)", (findAttr(sattrs, "adherence.rate")?.doubleValue as number) === 0.5);
    check("adherence.followed_count=1 (int)", (findAttr(sattrs, "adherence.followed_count")?.intValue as string) === "1");
    check("adherence.applicable_count=2 (int)", (findAttr(sattrs, "adherence.applicable_count")?.intValue as string) === "2");
    check("rubric.score=1 (int)", (findAttr(sattrs, "rubric.score")?.intValue as string) === "1");
    check("rubric.total=2 (int)", (findAttr(sattrs, "rubric.total")?.intValue as string) === "2");
    check("rubric.passed=false (bool)", (findAttr(sattrs, "rubric.passed")?.boolValue as boolean) === false);

    // --- REASONING (owner: scores AND reasoning) ---
    const perProc = findAttr(sattrs, "adherence.per_procedure")?.stringValue as string;
    check("per_procedure carries the SKIPPED proc id", (perProc ?? "").includes("reconcile-invoice"));
    check("per_procedure carries attribution", (perProc ?? "").includes("agent-override"));
    check("per_procedure carries per-proc REASONING", (perProc ?? "").includes("never reconciled the invoice"));
    check("per_procedure is valid JSON of 2 verdicts", (() => {
      try {
        return (JSON.parse(perProc ?? "[]") as unknown[]).length === 2;
      } catch {
        return false;
      }
    })());
    const flatReason = findAttr(sattrs, "adherence.reasoning")?.stringValue as string;
    check("flattened adherence.reasoning present", (flatReason ?? "").includes("Read the refund policy"));

    const perCrit = findAttr(sattrs, "rubric.per_criterion")?.stringValue as string;
    check("rubric.per_criterion carries criterion id", (perCrit ?? "").includes("root-cause-identified"));
    check("rubric.per_criterion carries criterion REASONING", (perCrit ?? "").includes("Named a symptom"));

    // --- span type hint ---
    check("langwatch.span.type=evaluation", (findAttr(sattrs, "langwatch.span.type")?.stringValue as string) === "evaluation");

    // --- pure builder agrees (belt-and-suspenders) ---
    const built = buildJudgeSpanPayload(emit, {
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
    });
    const builtSpan = built.resourceSpans[0].scopeSpans[0].spans[0];
    check("pure builder: same resource-attr count", built.resourceSpans[0].resource.attributes.length === rattrs.length);
    check("pure builder: same span-attr count", builtSpan.attributes.length === sattrs.length);
    check("pure builder: honors injected ids", builtSpan.traceId === "c".repeat(32) && builtSpan.spanId === "d".repeat(16));
  }

  // =========================================================================
  console.log("\nP5 DRIFT GUARD (source) — runResourceAttrs ≡ otelWiring correlation keys");
  {
    const src = readFileSync(join(import.meta.dirname, "sandbox.ts"), "utf8");
    // runResourceAttrs must return the 6 canonical keys.
    for (const k of ['"project.repo": "langwatch/scenario"', 'experiment: "sc784"', "strategy,", "scenario,", '"run.id": runId', '"enduser.id": "andrew@langwatch.ai"']) {
      check(`runResourceAttrs has ${k}`, src.includes(k));
    }
    // otelWiring's OTEL_RESOURCE_ATTRIBUTES string must use the SAME keys/order.
    check(
      "otelWiring baseAttrs matches the canonical order",
      src.includes("project.repo=langwatch/scenario,experiment=sc784,strategy=${strategy},scenario=${scenario},run.id=${runId}"),
    );
    check("otelWiring fullAttrs appends enduser.id", src.includes("enduser.id=andrew@langwatch.ai"));
    // sandbox exposes the resolved attrs on the Sandbox for the emit.
    check("Sandbox carries otelResourceAttrs", src.includes("otelResourceAttrs: Record<string, string>"));
    check("loadIngestionKey is exported (reused by the emitter)", src.includes("export function loadIngestionKey"));
    check("LW_OTLP_ENDPOINT is exported (reused by the emitter)", src.includes("export const LW_OTLP_ENDPOINT"));
  }

  console.log(`\n${failures === 0 ? "ALL PROOFS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

// A structural alias for the injectable fetch (matches telemetry-judge's FetchLike).
type EmitFetch = Parameters<typeof emitJudgeVerdict>[1] extends { fetchImpl?: infer F } ? F : never;

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
