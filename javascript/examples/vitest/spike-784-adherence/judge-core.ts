/**
 * judge-core — the strong-model adherence scoring logic, framework-free.
 *
 * Kept independent of `@langwatch/scenario` so the fixture accuracy harness
 * (AC5) can exercise the real judgment path via `tsx` without loading the
 * scenario runner. `judge.ts` is the thin `AgentAdapter` seam that delegates
 * here.
 *
 * Division of labour (deliberate, for reliability + honesty):
 *   - The MODEL decides ONLY `followed` per procedure, strictly from the action
 *     log (tool_use/tool_result). This is the genuinely semantic call — "did
 *     these tool actions carry out this procedure's required steps?".
 *   - Everything else is DETERMINISTIC: `applied` echoes the AUTHORED set;
 *     `surfaced` is computed from the evidence; `transitiveChainFollowed` is a
 *     pure function of the `followed` map and the authored chains; `attribution`
 *     is a pure function of (followed, surfaced, strategy). This makes the
 *     taxonomy stable while keeping the hard call model-driven.
 *
 * Auth: Claude Max OAuth. The access token is read FRESH from
 * `credentialsPath` (default `~/.claude/.credentials.json`) on every call so an
 * in-place ~24h refresh is picked up. Never logged, never persisted.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AdherenceReport,
  Attribution,
  Chain,
  CorpusIndex,
  NormalizedTurn,
  ProcedureEntry,
  ProcedureVerdict,
  Strategy,
} from "./types.ts";
import { extractActionLog, formatActionLog } from "./normalize.ts";
import { passesRunShapeFloor, type FloorOpts } from "./run-shape-floor.ts";

/** Default strong judge model (resolved + documented in README). */
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5";

/** The per-procedure `followed` decision the model returns. */
interface ModelVerdict {
  id: string;
  followed: boolean;
  reasoning: string;
}

export interface ScoreInput {
  /** Normalized transcript turns (from the tee'd substrate or a fixture). */
  turns: NormalizedTurn[];
  /** AUTHORED applicable procedure ids — the denominator, never judge-decided. */
  applicable: string[];
  /** Procedure bodies the judge reads (per-fixture mini-corpus or the real one). */
  corpus: CorpusIndex;
  /** Authored A->B chains (for transitiveChainFollowed). */
  chains?: Chain[];
  /** Strategy under test (affects attribution: instruction-sheet-miss is H1-only). */
  strategy?: Strategy;
  /** For H1: ids the compiled instruction sheet actually included. */
  compiledSheetIds?: string[];
  model?: string;
  credentialsPath?: string;
  /** OpenAI key (for gpt or o-series judge models). Defaults to process.env.OPENAI_API_KEY. */
  openaiApiKey?: string;
  /** Floor gate; pass `false` to skip (fixtures that deliberately test scoring). */
  floor?: FloorOpts | false;
  logger?: (msg: string) => void;
  /**
   * Injectable model function (offline tests). Receives (system, user) and
   * returns the raw model text. Defaults to the OAuth Messages API call.
   */
  llm?: (system: string, user: string, model: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// OAuth Messages API call with backoff (shared subscription bucket -> 429s).
// ---------------------------------------------------------------------------

interface OAuthCreds {
  claudeAiOauth?: { accessToken?: string };
}

function readAccessToken(credentialsPath: string): string {
  const raw = readFileSync(credentialsPath, "utf8");
  const parsed = JSON.parse(raw) as OAuthCreds;
  const token = parsed.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error(
      `No claudeAiOauth.accessToken in ${credentialsPath}. On this box auth is Claude Max OAuth; ` +
        `there is no ANTHROPIC_API_KEY.`,
    );
  }
  return token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the Anthropic Messages API using the Claude Max OAuth token. Retries on
 * 429 / rate_limit_error / 5xx with exponential backoff + jitter, honoring
 * `retry-after` when present. The subscription bucket is shared with interactive
 * use, so throttling is expected — this is why the backoff is generous.
 */
export async function callAnthropicOAuth(
  system: string,
  user: string,
  model: string,
  credentialsPath: string,
  opts: { maxRetries?: number; logger?: (m: string) => void } = {},
): Promise<string> {
  const { maxRetries = 7, logger } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const token = readAccessToken(credentialsPath); // fresh each attempt
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
    } catch (e) {
      lastErr = e;
      const wait = backoffMs(attempt);
      logger?.(`[judge] network error (attempt ${attempt}); retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      return (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
    }

    const bodyText = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500 || /rate_limit/i.test(bodyText);
    lastErr = new Error(`Anthropic ${res.status}: ${bodyText.slice(0, 200)}`);
    if (!retryable || attempt === maxRetries) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
    logger?.(`[judge] ${res.status} (attempt ${attempt}); retrying in ${wait}ms`);
    await sleep(wait);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 4_000 * 2 ** attempt); // 4s,8s,16s,...capped 60s
  return base + Math.floor(Math.random() * 1_000);
}

/**
 * Call the OpenAI Chat Completions API. Used as the strong-judge path when the
 * Claude Max OAuth bucket is throttled (the box shares one subscription bucket).
 * Reasoning-family models (gpt-5*, o*) omit `temperature` and cap reasoning with
 * `reasoning_effort: "low"`; others send `temperature: 0`. Both force JSON via
 * `response_format`.
 */
export async function callOpenAI(
  system: string,
  user: string,
  model: string,
  apiKey: string,
  opts: { maxRetries?: number; logger?: (m: string) => void } = {},
): Promise<string> {
  const { maxRetries = 5, logger } = opts;
  const reasoning = /^(gpt-5|o1|o3|o4)/.test(model);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_completion_tokens: 4000,
    response_format: { type: "json_object" },
  };
  if (reasoning) body.reasoning_effort = "low";
  else body.temperature = 0;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error(`OpenAI ${model}: empty content`);
      return text;
    }
    const bodyText = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`OpenAI ${res.status}: ${bodyText.slice(0, 200)}`);
    if (!retryable || attempt === maxRetries) break;
    logger?.(`[judge] OpenAI ${res.status} (attempt ${attempt}); backing off`);
    await sleep(backoffMs(attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Route to the right provider by model name. */
export async function callModel(
  system: string,
  user: string,
  model: string,
  opts: { credentialsPath: string; openaiApiKey?: string; logger?: (m: string) => void },
): Promise<string> {
  if (/^claude/.test(model)) {
    return callAnthropicOAuth(system, user, model, opts.credentialsPath, { logger: opts.logger });
  }
  const key = opts.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`model ${model} needs an OpenAI key (OPENAI_API_KEY) — none provided`);
  return callOpenAI(system, user, model, key, { logger: opts.logger });
}

// ---------------------------------------------------------------------------
// Prompt construction + robust JSON extraction.
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You are a rigorous procedure-adherence judge for an autonomous coding agent.

You receive:
1. A set of APPLICABLE PROCEDURES (each with an id and full body). This set is authoritative — you do NOT decide which procedures apply.
2. An ACTION LOG: the ordered tool_use and tool_result records extracted from the subject agent's transcript.

Decide, for EACH applicable procedure id, whether the subject FOLLOWED it.

HARD RULES — follow them exactly:
- Judge "followed" ONLY from the ACTION LOG (tool_use / tool_result). Concrete tool actions are the only evidence.
- IGNORE all prose, narration, planning, "thinking", and any hook-injected instruction sheets. A subject that SAYS or CLAIMS it followed a procedure but shows NO corresponding tool actions did NOT follow it. Claims are not evidence.
- Each procedure's "## Procedure" section lists ITS OWN numbered steps. A procedure is "followed" if and only if EVERY one of its numbered steps is carried out by a corresponding tool action in the log. Merely reading/opening the procedure file itself does NOT count as performing a step.
- If ANY numbered step has no corresponding tool action, "followed" is false — even if the other steps were done, and even if the agent claims completion.
- A "## Hand-off" note, or a line like "then follow procedure X", is NOT one of this procedure's numbered steps. It delegates to X, which you judge on its own line. Do NOT mark this procedure unfollowed merely because X was not carried out. (Whole-chain completion is tracked separately, not by you.)
- Do not reward intent, apologies, or promises to do it later.

Output STRICT JSON and nothing else:
{"verdicts":[{"id":"<procedure id>","followed":true|false,"reasoning":"<one sentence citing the specific action(s) or their absence>"}]}
Exactly one entry per applicable procedure id. No markdown, no prose outside the JSON.`;

function procedureBlock(entry: ProcedureEntry): string {
  const links = entry.links.length ? `\nlinks: ${entry.links.join(", ")}` : "";
  return `--- PROCEDURE id: ${entry.id} (status: ${entry.status})${links}\n${entry.body.trim()}\n--- END ${entry.id}`;
}

function buildUserPrompt(input: ScoreInput): string {
  const bodies = input.applicable
    .map((id) => {
      const entry = input.corpus.get(id);
      return entry
        ? procedureBlock(entry)
        : `--- PROCEDURE id: ${id}\n(body unavailable)\n--- END ${id}`;
    })
    .join("\n\n");
  const log = formatActionLog(extractActionLog(input.turns));
  return `APPLICABLE PROCEDURES (score every one of these ids: ${input.applicable.join(", ")}):

${bodies}

ACTION LOG (the ONLY evidence — tool actions in order):
${log}

Return the strict JSON verdict object now.`;
}

/** Extract the first balanced JSON object from a model reply. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`no JSON object in model reply: ${text.slice(0, 200)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`unterminated JSON in model reply: ${text.slice(0, 200)}`);
}

function parseModelVerdicts(text: string, applicable: string[]): ModelVerdict[] {
  const obj = extractJson(text) as { verdicts?: unknown };
  const rows = Array.isArray(obj.verdicts) ? obj.verdicts : [];
  const byId = new Map<string, ModelVerdict>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row["id"] !== "string") continue;
    byId.set(row["id"], {
      id: row["id"],
      followed: row["followed"] === true,
      reasoning: typeof row["reasoning"] === "string" ? row["reasoning"] : "",
    });
  }
  // Ensure exactly one verdict per applicable id (missing -> not followed).
  return applicable.map(
    (id) =>
      byId.get(id) ?? {
        id,
        followed: false,
        reasoning: "model returned no verdict for this id; defaulting to not-followed",
      },
  );
}

// ---------------------------------------------------------------------------
// Deterministic sub-signals.
// ---------------------------------------------------------------------------

/**
 * A procedure is "surfaced" when its content was demonstrably available to the
 * subject: a tool_use whose input references the procedure id/path, a tool_result
 * whose content mentions it, an injected turn (visible IN the substrate) carrying
 * it, or its id appearing in `compiledSheetIds` (an H1 instruction sheet named
 * it). Used ONLY for attribution (retrieval-miss vs instruction-sheet-miss vs
 * agent-override), never for `followed`.
 *
 * `compiledSheetIds` exists because H1's compiled sheet is delivered via the
 * UserPromptSubmit hook's STDOUT, which `claude -p` folds directly into the
 * subject's INPUT context for that turn — it is NOT re-emitted into the
 * `--output-format stream-json` STDOUT this harness tees, so it never appears
 * as an `injected` (or any other) turn in `turns` (verified empirically: zero
 * occurrences of compiled-sheet text in a tee'd substrate). Without this
 * channel, a procedure the H1 sheet surfaced but the subject never
 * independently re-mentioned (no grep/read of its own file) scored
 * `surfaced=false` -> wrongly attributed `retrieval-miss`, as if H1 had never
 * found it at all, instead of `instruction-sheet-miss`/`agent-override` (#784
 * H1-attribution fix). Callers populate `compiledSheetIds` from the H1 hook log
 * (`collectCompiledSheetIds`) or a fixture's declared `compiledSheetIds`.
 */
function computeSurfaced(
  id: string,
  entry: ProcedureEntry | undefined,
  turns: NormalizedTurn[],
  compiledSheetIds: string[] = [],
): boolean {
  if (compiledSheetIds.includes(id)) return true;

  const needles = [id, `${id}/PROCEDURE.md`, `${id}.md`];
  if (entry?.path) needles.push(entry.path);
  const hit = (hay: string) => needles.some((n) => hay.includes(n));

  for (const t of turns) {
    // Injected sheets and read/grep of the file both count as "surfaced".
    if (t.injected && hit(t.text)) return true;
    for (const tu of t.toolUses) {
      if (hit(tu.inputText)) return true;
    }
    for (const tr of t.toolResults) {
      if (hit(tr.content)) return true;
    }
  }
  return false;
}

/** transitiveChainFollowed for a chain root: root followed AND every step followed. */
function computeTransitive(
  id: string,
  chains: Chain[],
  followedMap: Map<string, boolean>,
): boolean | null {
  const chain = chains.find((c) => c.root === id);
  if (!chain) return null;
  return chain.steps.every((step) => followedMap.get(step) === true);
}

function mapAttribution(
  followed: boolean,
  surfaced: boolean,
  strategy: Strategy,
  inSheet: boolean,
): Attribution {
  if (followed) return "none";
  if (!surfaced) return "retrieval-miss";
  if (strategy === "h1" && !inSheet) return "instruction-sheet-miss";
  return "agent-override";
}

// ---------------------------------------------------------------------------
// Public entry.
// ---------------------------------------------------------------------------

/**
 * Score adherence for one run. Gated by the run-shape floor: a below-floor run
 * is EXCLUDED (returns `belowFloor: true`, never sent to the model).
 */
export async function scoreAdherence(input: ScoreInput): Promise<AdherenceReport> {
  const model = input.model ?? DEFAULT_JUDGE_MODEL;
  const strategy: Strategy = input.strategy ?? "none";
  const chains = input.chains ?? [];
  const compiledSheetIds = input.compiledSheetIds ?? [];

  // Floor gate.
  if (input.floor !== false) {
    const floorOpts = input.floor ?? {
      id: "adherence",
      minTurns: 3,
      requireHumanTurn: true,
      requireToolUse: true,
    };
    const floor = passesRunShapeFloor(input.turns, floorOpts);
    if (!floor.ok) {
      input.logger?.(`[judge] EXCLUDED below floor: ${floor.reason}`);
      return {
        perProcedure: [],
        applicableCount: input.applicable.length,
        followedCount: 0,
        adherenceRate: 0,
        belowFloor: true,
        model,
      };
    }
  }

  // Model decides `followed` per procedure (action-only).
  const system = JUDGE_SYSTEM;
  const user = buildUserPrompt(input);
  const llm =
    input.llm ??
    ((s: string, u: string, m: string) =>
      callModel(s, u, m, {
        credentialsPath: input.credentialsPath ?? defaultCredsPath(),
        openaiApiKey: input.openaiApiKey,
        logger: input.logger,
      }));
  const reply = await llm(system, user, model);
  const modelVerdicts = parseModelVerdicts(reply, input.applicable);
  const followedMap = new Map(modelVerdicts.map((v) => [v.id, v.followed]));

  const perProcedure: ProcedureVerdict[] = modelVerdicts.map((mv) => {
    const entry = input.corpus.get(mv.id);
    const surfaced = computeSurfaced(mv.id, entry, input.turns, compiledSheetIds);
    const inSheet = compiledSheetIds.includes(mv.id);
    return {
      id: mv.id,
      applied: true, // authored denominator
      followed: mv.followed,
      transitiveChainFollowed: computeTransitive(mv.id, chains, followedMap),
      surfaced,
      attribution: mapAttribution(mv.followed, surfaced, strategy, inSheet),
      reasoning: mv.reasoning,
    };
  });

  const followedCount = perProcedure.filter((p) => p.followed).length;
  return {
    perProcedure,
    applicableCount: input.applicable.length,
    followedCount,
    adherenceRate: input.applicable.length ? followedCount / input.applicable.length : 0,
    model,
  };
}

export function defaultCredsPath(): string {
  return process.env.ADHERENCE_CREDENTIALS_PATH ?? join(homedir(), ".claude", ".credentials.json");
}
