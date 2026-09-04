/**
 * Auto-save red-team scenario reports as JSON files.
 *
 * Mirrors the Python `scenario.report._save` module at the JSON-shape level
 * so the same Streamlit dashboard (`scenario redteam-report`) renders both.
 *
 * This TypeScript version skips the LLM-based severity/suggestion analysis
 * that Python does at save time — analysis is instead computed on-demand by
 * the dashboard's aggregate-fixes pass.
 *
 * Zero-friction path: the runner detects a RedTeamAgent in the agents list
 * and calls `saveRedTeamReport` automatically. Opt out with
 * `SCENARIO_REDTEAM_REPORT=0`. Override batch dir with
 * `SCENARIO_REDTEAM_REPORT_DIR=/path`.
 */

import fs from "node:fs";
import path from "node:path";
import type { ScenarioResult, AgentAdapter } from "./domain";
import type { ScenarioConfig } from "./domain/scenarios";

/**
 * Shared marker for the marathon script's early exit when the ATTACK
 * achieved its objective. The scenario-level `succeed()` only ends the
 * script — the defense did NOT hold — so the writer keys off this prefix to
 * file such runs as compromised, never "held" (#888). Mirrored by
 * `EARLY_EXIT_OBJECTIVE_PREFIX` in `python/scenario/red_team_agent.py`.
 */
export const EARLY_EXIT_OBJECTIVE_PREFIX = "Early exit: objective achieved";

let _batchDir: string | null = null;

function currentBatchDir(): string {
  if (_batchDir) return _batchDir;
  const override = process.env.SCENARIO_REDTEAM_REPORT_DIR;
  if (override) {
    _batchDir = path.resolve(override);
  } else {
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\.\d+Z$/, "")
      .replace(/(\d{8})(\d{6})/, "$1_$2");
    _batchDir = path.resolve(process.cwd(), "redteam-reports", ts);
  }
  fs.mkdirSync(_batchDir, { recursive: true });
  return _batchDir;
}

function slugify(s: string): string {
  return (s || "run").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "run";
}

function strategyName(redTeam: unknown): string {
  const strat = (redTeam as { strategy?: { constructor?: { name?: string } } })?.strategy;
  const name = strat?.constructor?.name?.toLowerCase() ?? "";
  if (name.includes("crescendo")) return "crescendo";
  if (name.includes("goat")) return "goat";
  return name.replace("strategy", "") || "unknown";
}

/**
 * Duck-typed detector. Avoids an import cycle with `./agents/red-team`
 * since that module may import from `./runner`.
 */
export function isRedTeamAgent(agent: AgentAdapter | unknown): boolean {
  return (
    typeof agent === "object" &&
    agent !== null &&
    (agent as { name?: string }).name === "RedTeamAgent"
  );
}

function serializeMessage(m: unknown): Record<string, unknown> {
  if (m && typeof m === "object") {
    const obj = m as Record<string, unknown>;
    const { trace_id: _traceId, ...rest } = obj;
    return rest;
  }
  return { role: "unknown", content: String(m) };
}

interface SaveOptions {
  result: ScenarioResult;
  redTeam: AgentAdapter & {
    target?: string;
    totalTurns?: number;
    model?: unknown;
    metapromptModel?: unknown;
    strategy?: unknown;
  };
  testName: string;
  scenarioConfig: ScenarioConfig;
  elapsedSeconds?: number;
  error?: string;
  outDir?: string;
}

/**
 * Persist a red-team scenario run to JSON for dashboard consumption.
 *
 * Errors are swallowed (warning printed) so a reporting failure never
 * breaks a test run.
 */
export function saveRedTeamReport(opts: SaveOptions): string | null {
  if (process.env.SCENARIO_REDTEAM_REPORT === "0") {
    return null;
  }

  try {
    const destDir = opts.outDir ? path.resolve(opts.outDir) : currentBatchDir();
    fs.mkdirSync(destDir, { recursive: true });

    const strategy = strategyName(opts.redTeam);
    const criteria: string[] =
      (opts.scenarioConfig.agents
        .map((a) => (a as { criteria?: string[] }).criteria)
        .find((c): c is string[] => Array.isArray(c)) as string[]) || [];

    // A judge/infra failure carried on the result (`result.error`) is an
    // errored run, not a security verdict (#888) — filing it as a break
    // fabricates a finding. An early exit because the attack achieved its
    // objective is a compromise: `succeed()` only ended the script, the
    // defense did not hold. Status vocabulary is shared with the Python
    // writer and dashboard: "held" / "broke" / "errored" — never "broken".
    const runError = opts.error || opts.result.error;
    const objectiveAchieved =
      !runError &&
      opts.result.success &&
      (opts.result.reasoning || "").startsWith(EARLY_EXIT_OBJECTIVE_PREFIX);
    const status = runError
      ? "errored"
      : opts.result.success && !objectiveAchieved
        ? "held"
        : "broke";
    const messages = (opts.result.messages || []).map(serializeMessage);

    const payload = {
      test_name: opts.testName,
      description: opts.scenarioConfig.description || "",
      strategy,
      target: opts.redTeam.target || "",
      total_turns: opts.redTeam.totalTurns ?? 0,
      attacker_model: modelName(opts.redTeam.model),
      metaprompt_model: modelName(opts.redTeam.metapromptModel ?? opts.redTeam.model),
      criteria,
      status,
      success: Boolean(opts.result.success) && !objectiveAchieved,
      reasoning: opts.result.reasoning || (runError ? `ERROR: ${runError}` : ""),
      passed_criteria: opts.result.metCriteria || [],
      failed_criteria: opts.result.unmetCriteria || [],
      total_time: opts.elapsedSeconds ?? null,
      agent_time: null,
      messages,
      // Fields the dashboard populates via on-demand aggregation:
      failing_turn_index: null,
      failure_summary: "",
      suggestions: [],
      severity: "medium",
      severity_rationale: "",
      // Fail closed (#888): no analyzer has spoken at save time, so never
      // invent a verdict. "" makes the dashboard's status-based fallback
      // reachable (held → none, broke → partial, errored → none) instead of
      // filing every non-success as a significant security break.
      break_severity: status === "held" ? "none" : "",
      break_rationale: "",
      timestamp: Date.now(),
      analysis_pending: true,
    };

    const filename = `${Date.now()}_${slugify(opts.testName)}_${strategy}.json`;
    const destPath = path.join(destDir, filename);
    fs.writeFileSync(destPath, JSON.stringify(payload, null, 2));
    return destPath;
  } catch (e) {
     
    console.warn(`[scenario] red-team report save failed: ${(e as Error).message}`);
    return null;
  }
}

function modelName(m: unknown): string {
  if (!m) return "";
  if (typeof m === "string") return m;
  const anyM = m as { modelId?: string; id?: string };
  return anyM.modelId || anyM.id || "";
}
