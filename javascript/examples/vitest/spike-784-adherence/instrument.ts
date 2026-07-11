/**
 * instrument — denominator integrity + checkpointing (plan file #9, AC8 / F14).
 *
 * Three jobs:
 *  1. EXCLUDE errored/throttled/auth-failed turns from any rate denominator and
 *     report them as an excluded-count — a throttled or errored turn is NEVER
 *     silently scored `followed=false`. A run that HARD-errors (auth fail, or a
 *     rate-limit adapter-throw that aborts the run) is marked and excluded, not
 *     measured.
 *  2. Summarize the H1 hook log: how many Haiku compile/verify calls fired, how
 *     many returned HTTP 200, and how many turns were INVALID (a throttled/empty
 *     compile — invalid, not a violation). This is the "both Haiku hooks fired"
 *     evidence for an H1 session.
 *  3. CHECKPOINT the per-session verdict to disk so an abort (the rate-limit
 *     adapter-throw that rethrows through `scenario.run`) cannot lose already
 *     computed work — the checkpoint is written incrementally.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

import type { AdherenceReport, NormalizedTurn } from "./types.ts";

// ---------------------------------------------------------------------------
// Turn exclusion accounting.
// ---------------------------------------------------------------------------

const AUTH_FAIL_RE = /not logged in|\/login|invalid api key|authentication_error|oauth/i;
const THROTTLE_RE = /rate.?limit|\b429\b|overloaded|too many requests/i;

export interface RunAccounting {
  total: number;
  excluded: number;
  judged: number;
  hardError: boolean;
  /** Per-excluded-turn reasons, plus any hard-error reason. */
  reasons: Array<{ index: number; kind: "throttle" | "auth-fail" | "run-error"; detail: string }>;
}

/**
 * Classify a run's substrate for denominator integrity. Excluded turns
 * (throttle / auth-fail / errored result) are counted out; `hardError` marks a
 * run that must NOT be measured at all (auth fail, or an errored terminal
 * envelope). Never scores an errored turn as a violation.
 */
export function classifyRun(turns: NormalizedTurn[]): RunAccounting {
  const reasons: RunAccounting["reasons"] = [];
  let hardError = false;

  for (const t of turns) {
    const raw = t.raw as Record<string, unknown>;
    const rawType = typeof raw["type"] === "string" ? (raw["type"] as string) : "";

    // A `rate_limit_event` line is emitted on ORDINARY runs (it reports the
    // remaining quota window) — its mere presence is NOT a throttle. Only treat
    // it as one when it actually signals a rejected/exhausted state.
    if (rawType === "rate_limit_event") {
      const blob = JSON.stringify(raw).toLowerCase();
      if (/rejected|exceeded|exhausted|"status":"(over|hard)/.test(blob)) {
        reasons.push({ index: t.index, kind: "throttle", detail: "rate_limit_event signalled a hit" });
      }
      continue;
    }

    // Errored terminal envelope — the run reported failure.
    if (t.role === "result" && (raw["is_error"] === true || /error/i.test(String(raw["subtype"] ?? "")))) {
      hardError = true;
      reasons.push({ index: t.index, kind: "run-error", detail: `result is_error/${String(raw["subtype"] ?? "")}` });
      continue;
    }

    // Auth failure anywhere in prose or a tool error.
    const hay = `${t.text}\n${t.toolResults.map((r) => r.content).join("\n")}`;
    if (AUTH_FAIL_RE.test(hay)) {
      hardError = true;
      reasons.push({ index: t.index, kind: "auth-fail", detail: "not-logged-in / auth error signal" });
      continue;
    }
    if (t.toolResults.some((r) => r.isError && THROTTLE_RE.test(r.content))) {
      reasons.push({ index: t.index, kind: "throttle", detail: "throttle in tool_result" });
    }
  }

  const excluded = reasons.length;
  return { total: turns.length, excluded, judged: Math.max(0, turns.length - excluded), hardError, reasons };
}

/**
 * The subject model(s) the `claude -p` session actually RESOLVED to, read from
 * the tee'd stream-json (the `system:init` event's `model` + each assistant
 * `message.model`). Owner requirement (2026-07-11): the resolved subject model is
 * a LOGGED VARIABLE on every run — it is the independent variable of the
 * model-sweep arm, and `claude -p` with no `--model` resolves to the box default
 * (observed: `claude-opus-4-8`), which must be recorded, not assumed. Returns the
 * distinct set (usually one; a `[1m]`-context variant can co-occur).
 */
export function extractSubjectModel(turns: NormalizedTurn[]): string[] {
  const models = new Set<string>();
  for (const t of turns) {
    const raw = t.raw as Record<string, unknown>;
    if (typeof raw["model"] === "string") models.add(raw["model"] as string);
    const msg = raw["message"] as Record<string, unknown> | undefined;
    if (msg && typeof msg["model"] === "string") models.add(msg["model"] as string);
  }
  return [...models];
}

// ---------------------------------------------------------------------------
// H1 hook-log summary.
// ---------------------------------------------------------------------------

export interface HookEvent {
  ts?: string;
  mode?: string;
  event?: string;
  retrieved?: string[];
  /** ids the compiled instruction sheet TEXT actually names (h1-compile only). */
  compiledIds?: string[];
  haikuStatus?: number;
  haikuOk?: boolean;
  verdict?: unknown;
  error?: string;
  reason?: string;
  [k: string]: unknown;
}

/**
 * Union of every h1-compile event's `compiledIds` across a run — every
 * procedure id the H1 sheet surfaced to the subject at ANY turn in the session
 * (#784 H1-attribution fix). The sheet is delivered via the UserPromptSubmit
 * hook's stdout, which `claude -p` folds into the subject's INPUT context for
 * that turn — the tee'd `stream-json` STDOUT substrate never captures it. Feed
 * this into `ScoreInput.compiledSheetIds` (via `AdherenceJudgeConfig.hookLogPath`
 * or directly) so `computeSurfaced` treats a sheet-named procedure as surfaced
 * even when the subject's own tool actions never independently mention it —
 * otherwise it is wrongly attributed `retrieval-miss` (as if H1 never found it)
 * instead of `instruction-sheet-miss`/`agent-override`.
 */
export function collectCompiledSheetIds(events: HookEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.mode !== "h1-compile") continue;
    for (const id of e.compiledIds ?? []) ids.add(id);
  }
  return [...ids];
}

export interface HookSummary {
  fired: number;
  compileCalls: number;
  verifyCalls: number;
  baselineRetrievals: number;
  haiku200s: number;
  haikuNon200s: number;
  /** Turns whose compile was throttled/empty -> INVALID (not a violation). */
  invalidTurns: number;
  /** True when at least one compile AND one verify Haiku call returned 200. */
  bothHooksFired200: boolean;
  events: HookEvent[];
}

export function readHookLog(path: string): HookEvent[] {
  if (!existsSync(path)) return [];
  const out: HookEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as HookEvent);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function summarizeHooks(events: HookEvent[]): HookSummary {
  let compileCalls = 0;
  let verifyCalls = 0;
  let baselineRetrievals = 0;
  let haiku200s = 0;
  let haikuNon200s = 0;
  let invalidTurns = 0;
  let compile200 = false;
  let verify200 = false;

  for (const e of events) {
    if (e.mode === "baseline" && e.event === "userpromptsubmit") baselineRetrievals++;
    if (e.mode === "h1-compile" && e.event === "userpromptsubmit") {
      compileCalls++;
      if (e.haikuStatus === 200) {
        haiku200s++;
        compile200 = true;
      } else if (typeof e.haikuStatus === "number" && e.haikuStatus !== 0) {
        haikuNon200s++;
      }
    }
    if (e.event === "invalid-turn") invalidTurns++;
    if (e.mode === "h1-verify" && e.event === "stop") {
      verifyCalls++;
      if (e.haikuStatus === 200) {
        haiku200s++;
        verify200 = true;
      } else if (typeof e.haikuStatus === "number" && e.haikuStatus !== 0) {
        haikuNon200s++;
      }
    }
  }

  return {
    fired: events.filter((e) => e.event === "userpromptsubmit" || e.event === "stop").length,
    compileCalls,
    verifyCalls,
    baselineRetrievals,
    haiku200s,
    haikuNon200s,
    invalidTurns,
    bothHooksFired200: compile200 && verify200,
    events,
  };
}

// ---------------------------------------------------------------------------
// H2 blocking-Stop-hook summary (the enforcement-delta evidence).
// ---------------------------------------------------------------------------

export interface H2Summary {
  /** Every `h2-verify` Stop event, in order. */
  fires: number;
  /** How many of those fires BLOCKED the stop and forced a retry. */
  blocks: number;
  /** Fires that allowed the stop because enforcement was not in play this turn. */
  noopAllows: number;
  /** True iff some enforced turn reached completion only AFTER >=1 block (retry worked). */
  retryForcedCompletion: boolean;
  /** True iff some enforced turn hit the retry cap without ever reaching completion. */
  capHit: boolean;
  /** True iff enforcement fired on >=1 turn (an applicable procedure was in play). */
  enforcedAtLeastOnce: boolean;
  /** Ordered decisions (e.g. block, block, allow-complete-after-retry). */
  decisions: string[];
  /**
   * The coverage trajectory of every ENFORCED fire — how the action-log step
   * coverage moved across blocks/retries. This is the "did each retry move a
   * procedure from incomplete→complete" evidence.
   */
  trajectory: Array<{
    decision: string;
    enforced: string[];
    mutations?: number;
    reads?: number;
    needMut?: number;
    needRead?: number;
    retry?: number;
    stopHookActive?: boolean;
  }>;
}

const H2_ENFORCED_DECISIONS = new Set([
  "block",
  "allow-complete",
  "allow-complete-after-retry",
  "allow-cap-hit",
  "allow-counter-unwritable",
]);

/**
 * Summarize the H2 `h2-verify` Stop events from the hook log. Captures how many
 * times the Stop hook BLOCKED and forced a retry, and whether each retry moved a
 * procedure from incomplete→complete (via the coverage trajectory) — the core
 * evidence for whether external enforcement flipped the compliance gap.
 */
export function summarizeH2(events: HookEvent[]): H2Summary {
  const fires = events.filter((e) => e.mode === "h2-verify" && e.event === "stop");
  const decisions = fires.map((e) => String(e.decision ?? ""));
  const trajectory = fires
    .filter((e) => H2_ENFORCED_DECISIONS.has(String(e.decision ?? "")))
    .map((e) => ({
      decision: String(e.decision ?? ""),
      enforced: (e.enforced as string[]) ?? [],
      mutations: e["mutations"] as number | undefined,
      reads: e["reads"] as number | undefined,
      needMut: e["needMut"] as number | undefined,
      needRead: e["needRead"] as number | undefined,
      retry: e["retry"] as number | undefined,
      stopHookActive: e["stopHookActive"] as boolean | undefined,
    }));
  return {
    fires: fires.length,
    blocks: decisions.filter((d) => d === "block").length,
    noopAllows: decisions.filter((d) => d === "allow-noop" || d === "allow-no-substrate").length,
    retryForcedCompletion: decisions.includes("allow-complete-after-retry"),
    capHit: decisions.includes("allow-cap-hit"),
    enforcedAtLeastOnce: trajectory.length > 0,
    decisions,
    trajectory,
  };
}

// ---------------------------------------------------------------------------
// H3 hook-log summary — the PER-PROCEDURE Stop gate (gate ≡ judge).
// ---------------------------------------------------------------------------

/** One enforced procedure's verdict from a single h3-verify Stop fire. */
export interface H3PerProc {
  id: string;
  /** gpt-5.1 verdict for THIS procedure's own steps (null = judge errored → failed open). */
  followed: boolean | null;
  judgeOk: boolean;
  missingSteps?: string[];
  status?: number;
  latencyMs?: number;
}

export interface H3Summary {
  fires: number;
  blocks: number;
  /** Fires that allowed the stop with no per-procedure enforcement in play. */
  noopAllows: number;
  /** True iff some enforced turn reached completion only AFTER >=1 block. */
  retryForcedCompletion: boolean;
  /** True iff some enforced turn hit the retry cap without every proc followed. */
  capHit: boolean;
  /** True iff the per-procedure gate actually ran the judge on >=1 fire. */
  enforcedAtLeastOnce: boolean;
  /** Total per-procedure gpt-5.1 checks made across all enforced fires (bucket-free — OpenAI). */
  judgeCalls: number;
  /** Per-procedure checks that failed open (judgeOk=false — never block blind). */
  judgeErrors: number;
  decisions: string[];
  /**
   * The per-procedure trajectory of every ENFORCED fire — which procedures the
   * gate judged followed/not, which it blocked on, and the retry index. This is
   * the "did per-procedure gating block the SKIPPED proc while the well-served
   * one passed" evidence — the exact discrimination H2's aggregate gate lacked.
   */
  trajectory: Array<{
    decision: string;
    enforced: string[];
    enforcedVia?: string;
    blockedProcs: string[];
    retry?: number;
    priorBlocks?: number;
    perProc: H3PerProc[];
    stopHookActive?: boolean;
  }>;
}

/** Decisions where the per-procedure gate actually ran (perProc populated). */
const H3_ENFORCED_DECISIONS = new Set([
  "block",
  "allow-complete",
  "allow-complete-after-retry",
  "allow-judge-partial",
  "allow-cap-hit",
  "allow-counter-unwritable",
]);

/**
 * Summarize the H3 `h3-verify` Stop events. Captures how many times the
 * per-procedure gate BLOCKED (naming the specific skipped procedure), whether a
 * retry moved every enforced procedure to followed (`allow-complete-after-retry`),
 * and whether the run cap-hit (`reconcile-invoice` under-enactable). The
 * `judgeCalls`/`judgeErrors` counts are the bucket-free OpenAI gate cost.
 */
export function summarizeH3(events: HookEvent[]): H3Summary {
  const fires = events.filter((e) => e.mode === "h3-verify" && e.event === "stop");
  const decisions = fires.map((e) => String(e.decision ?? ""));
  const enforcedFires = fires.filter((e) => H3_ENFORCED_DECISIONS.has(String(e.decision ?? "")));
  const trajectory = enforcedFires.map((e) => ({
    decision: String(e.decision ?? ""),
    enforced: (e.enforced as string[]) ?? [],
    enforcedVia: e["enforcedVia"] as string | undefined,
    blockedProcs: (e["blockedProcs"] as string[]) ?? [],
    retry: e["retry"] as number | undefined,
    priorBlocks: e["priorBlocks"] as number | undefined,
    perProc: (((e["perProc"] as unknown[]) ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: String(p["id"] ?? ""),
      followed: (p["followed"] ?? null) as boolean | null,
      judgeOk: p["judgeOk"] === true,
      missingSteps: p["missingSteps"] as string[] | undefined,
      status: p["status"] as number | undefined,
      latencyMs: p["latencyMs"] as number | undefined,
    })),
    stopHookActive: e["stopHookActive"] as boolean | undefined,
  }));
  const allPerProc = trajectory.flatMap((t) => t.perProc);
  return {
    fires: fires.length,
    blocks: decisions.filter((d) => d === "block").length,
    noopAllows: decisions.filter(
      (d) => d === "allow-noop" || d === "allow-no-substrate" || d === "allow-judge-unavailable",
    ).length,
    retryForcedCompletion: decisions.includes("allow-complete-after-retry"),
    capHit: decisions.includes("allow-cap-hit"),
    enforcedAtLeastOnce: enforcedFires.length > 0,
    judgeCalls: allPerProc.length,
    judgeErrors: allPerProc.filter((p) => !p.judgeOk).length,
    decisions,
    trajectory,
  };
}

// ---------------------------------------------------------------------------
// Per-session checkpoint (survives an abort).
// ---------------------------------------------------------------------------

export interface SessionCheckpoint {
  scenarioId: string;
  strategy: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "judged" | "aborted" | "excluded";
  configDir?: string;
  workDir?: string;
  turnCounts?: RunAccounting;
  hooks?: Omit<HookSummary, "events">;
  report?: AdherenceReport;
  error?: string;
  notes?: string[];
}

/** Atomic checkpoint write (write temp + rename) so a crash never leaves half a file. */
export function checkpoint(path: string, data: SessionCheckpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  renameSync(tmp, path);
}

export function loadCheckpoint(path: string): SessionCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionCheckpoint;
  } catch {
    return null;
  }
}
