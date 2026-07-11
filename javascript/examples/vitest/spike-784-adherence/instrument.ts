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
