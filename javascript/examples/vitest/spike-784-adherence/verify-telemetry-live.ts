/**
 * verify-telemetry-live — post ONE real judge-verdict span to LangWatch with the
 * box-wide sk-lw key (owner-unblocked 2026-07-11) and confirm it ingests
 * (HTTP 200 + rejectedSpans:0). Proves the judge-scores+reasoning→LangWatch
 * requirement end-to-end BEYOND the offline prove-telemetry.ts. Prints the traceId
 * so it can be fetched back from LangWatch.
 *
 *   tsx verify-telemetry-live.ts
 */
import { emitJudgeVerdict } from "./telemetry-judge.ts";
import { loadIngestionKey } from "./sandbox.ts";
import type { AdherenceReport } from "./types.ts";

async function main(): Promise<void> {
  const key = loadIngestionKey();
  const kind = key ? (/^sk-lw-/.test(key) ? "sk-lw" : /^ik-lw-/.test(key) ? "ik-lw" : "?") : "NONE";
  console.log(`key resolved: ${key ? `${key.slice(0, 9)}…(${key.length} chars, ${kind})` : "NONE — fail-open, nothing to verify"}`);
  if (!key) process.exit(1);

  // A synthetic but realistic verdict (mirrors a real vendor H4 run: 3/3, gate-forced).
  const runId = `verify-telemetry-${process.pid}`;
  const resourceAttrs: Record<string, string> = {
    "project.repo": "langwatch/scenario",
    experiment: "sc784",
    strategy: "h3",
    scenario: "context-load-vendor",
    "run.id": runId,
    "enduser.id": "andrew@langwatch.ai",
  };
  const report: AdherenceReport = {
    applicableCount: 3,
    followedCount: 3,
    adherenceRate: 1,
    belowFloor: false,
    model: "gpt-5.1",
    perProcedure: [
      { id: "onboard-vendor", applied: true, followed: true, transitiveChainFollowed: true, surfaced: true, attribution: "none", reasoning: "verify-probe: attached the contact set." },
      { id: "provision-account", applied: true, followed: true, transitiveChainFollowed: false, surfaced: true, attribution: "none", reasoning: "verify-probe: applied baseline-config." },
      { id: "grant-access", applied: true, followed: true, transitiveChainFollowed: false, surfaced: true, attribution: "none", reasoning: "verify-probe: gate forced the expiry." },
    ],
  } as AdherenceReport;

  console.log(`emitting judge-verdict span (run.id=${runId}) to LangWatch …`);
  const res = await emitJudgeVerdict(
    { resourceAttrs, report, scenarioId: "context-load-vendor", strategy: "h3", judgeModel: "gpt-5.1", subjectModel: "claude-opus-4-8", scenarioRunSuccess: true, status: "judged" },
    { logger: (m) => console.log(`   ${m}`) },
  );
  console.log(`emit result: ${JSON.stringify(res)}`);
  const ok = res.emitted === true && res.rejectedSpans === 0;
  console.log(ok ? `PASS — trace ingested (rejectedSpans:0). traceId=${res.traceId} run.id=${runId}` : `FAIL — not ingested (status=${res.status} rejectedSpans=${res.rejectedSpans} reason=${res.reason})`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
