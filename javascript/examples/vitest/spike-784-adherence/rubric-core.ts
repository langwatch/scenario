/**
 * rubric-core — the OUTPUT-QUALITY judge for judgment/improvised work, framework-free.
 *
 * WHY a separate judge (the #784 improvised-procedure variant): the action-log
 * `followed` judge (`judge-core.ts`) scores a procedure from ACTION PRESENCE — did
 * a tool action carry out each numbered step. That is exactly right for MECHANICAL,
 * checklist-verifiable steps (attach the contact set, set an expiry, log the
 * revocation). It is BLIND to whether a produced ARTIFACT is any good: a subject
 * that writes ANYTHING to the findings file has an action for the "write the
 * substantiation" step, so the action judge (and any gate built on it) marks it
 * followed regardless of quality. Judgment work needs a QUALITY rubric instead.
 *
 * This module scores a produced artifact against explicit, itemized criteria (each
 * 0/1, with a stated pass threshold). It is deliberately ISOLATED — no
 * `@langwatch/scenario`, no `judge-core`, only node builtins + fetch — so it can be
 * proven on ground-truth fixtures via plain `tsx` (see `prove-rubric.ts`) exactly
 * like `prove-ac5.ts` proves the action judge, BEFORE any live run.
 *
 * Division of labour (mirrors judge-core's honesty split):
 *   - The MODEL decides ONLY each criterion's met/unmet, strictly from (source
 *     material, artifact, criterion). This is the genuinely semantic call.
 *   - `score`, `passed`, and the empty-artifact short-circuit are DETERMINISTIC.
 *
 * Judge model: OpenAI `gpt-5.1` (never the Anthropic path — the subject IS Claude,
 * so an Anthropic judge would grade its own family). Reasoning-family models omit
 * temperature and cap reasoning with `reasoning_effort:"low"`; JSON is forced via
 * `response_format`.
 */

/** The strong quality-judge model (OpenAI; never Anthropic — the subject is Claude). */
export const DEFAULT_RUBRIC_MODEL = "gpt-5.1";

/** One itemized, binary quality criterion. */
export interface RubricCriterion {
  /** Stable id (used in the JSON verdict + ground-truth fixtures). */
  id: string;
  /** What earns met=true — phrased so a rigorous judge can decide 0/1. */
  description: string;
}

/** A named rubric: the criteria + the pass threshold (min criteria met to "pass"). */
export interface RubricSpec {
  id: string;
  /** Human label for the artifact kind, e.g. "root-cause finding". */
  artifactKind: string;
  criteria: RubricCriterion[];
  /** Minimum number of criteria met for `passed=true` (stated, not implicit). */
  passThreshold: number;
}

/** The model's decision for one criterion. */
export interface CriterionVerdict {
  id: string;
  met: boolean;
  reasoning: string;
}

export interface RubricResult {
  perCriterion: CriterionVerdict[];
  /** Count of criteria met. */
  score: number;
  /** Total criteria (denominator). */
  total: number;
  /** score >= passThreshold. */
  passed: boolean;
  model: string;
  /** True when the artifact was empty/missing — scored 0 deterministically, never sent to the model. */
  emptyArtifact?: boolean;
}

export interface RubricScoreInput {
  /** The produced artifact text (e.g. the written finding). */
  artifact: string;
  /**
   * The SOURCE MATERIAL the author had available (the seeded evidence). The judge
   * checks cited-evidence + no-unsupported-claims AGAINST this — a claim counts as
   * supported only if the source material contains it.
   */
  sourceMaterial: string;
  rubric: RubricSpec;
  model?: string;
  /** OpenAI key. Defaults to process.env.OPENAI_API_KEY. */
  openaiApiKey?: string;
  /** Injectable model fn (offline fixtures). Receives (system, user, model) -> raw text. */
  llm?: (system: string, user: string, model: string) => Promise<string>;
  logger?: (msg: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 4_000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 1_000);
}

/**
 * Call the OpenAI Chat Completions API for the rubric judge. Inlined (not imported
 * from judge-core) to keep this module framework-free. Reasoning-family models
 * (gpt-5*, o*) omit temperature + cap reasoning; JSON is forced via response_format.
 */
export async function callOpenAIRubric(
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
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error(`OpenAI ${model}: empty content`);
      return text;
    }
    const bodyText = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`OpenAI ${res.status}: ${bodyText.slice(0, 200)}`);
    if (!retryable || attempt === maxRetries) break;
    logger?.(`[rubric] OpenAI ${res.status} (attempt ${attempt}); backing off`);
    await sleep(backoffMs(attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Extract the first balanced JSON object from a model reply. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`no JSON object in rubric reply: ${text.slice(0, 200)}`);
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
  throw new Error(`unterminated JSON in rubric reply: ${text.slice(0, 200)}`);
}

function buildRubricSystem(spec: RubricSpec): string {
  return `You are a rigorous QUALITY judge for a produced work artifact (a ${spec.artifactKind}).

You receive:
1. SOURCE MATERIAL — the evidence the author had available when producing the artifact.
2. The ARTIFACT the author produced.
3. A list of CRITERIA, each with an id and a description of what earns "met".

Decide, for EACH criterion id, whether the artifact MEETS it (true) or not (false).

HARD RULES — follow them exactly:
- Judge the ARTIFACT's CONTENT against the SOURCE MATERIAL and the criterion. A claim in the artifact counts as SUPPORTED only if the SOURCE MATERIAL actually contains it; a specific value counts as CITED only if it matches the source material.
- Do NOT reward a confident tone, fluent prose, or length. A long, assured writeup that names the wrong cause, cites nothing specific, or invents facts must score those criteria false.
- A criterion is "met" only if it is FULLY satisfied as described. If it is partially satisfied or hedged into vagueness, it is not met.
- "Specific" means a concrete, checkable referent (a named change, a field, a value, a timestamp, a decision) — not a general gesture ("a config issue", "increased load").
- "Concrete remediation" means a specific action the reader can take (a named change to make), not "investigate further", "monitor", or "consider scaling".
- Be independent per criterion — a strong artifact can still fail one criterion, and a weak one can still pass one.

Output STRICT JSON and nothing else:
{"criteria":[{"id":"<criterion id>","met":true|false,"reasoning":"<one sentence citing the specific artifact text and source evidence>"}]}
Exactly one entry per criterion id (${spec.criteria.map((c) => c.id).join(", ")}). No markdown, no prose outside the JSON.`;
}

function buildRubricUser(input: RubricScoreInput): string {
  const criteria = input.rubric.criteria
    .map((c) => `- ${c.id}: ${c.description}`)
    .join("\n");
  return `SOURCE MATERIAL (the evidence the author had — the ground truth to check claims against):
${input.sourceMaterial.trim()}

ARTIFACT (the produced ${input.rubric.artifactKind} to grade):
${input.artifact.trim() || "(empty artifact)"}

CRITERIA (score every one of these ids: ${input.rubric.criteria.map((c) => c.id).join(", ")}):
${criteria}

Return the strict JSON verdict object now.`;
}

/** Parse the rubric verdict, defaulting any missing criterion to not-met. */
function parseRubricVerdicts(text: string, spec: RubricSpec): CriterionVerdict[] {
  const obj = extractJson(text) as { criteria?: unknown };
  const rows = Array.isArray(obj.criteria) ? obj.criteria : [];
  const byId = new Map<string, CriterionVerdict>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row["id"] !== "string") continue;
    byId.set(row["id"], {
      id: row["id"],
      met: row["met"] === true,
      reasoning: typeof row["reasoning"] === "string" ? row["reasoning"] : "",
    });
  }
  return spec.criteria.map(
    (c) =>
      byId.get(c.id) ?? {
        id: c.id,
        met: false,
        reasoning: "model returned no verdict for this criterion; defaulting to not-met",
      },
  );
}

/**
 * Score a produced artifact against a rubric. An empty/whitespace artifact
 * short-circuits to an all-false result (never sent to the model). Otherwise the
 * model decides each criterion; `score`/`passed` are computed deterministically.
 */
export async function scoreRubric(input: RubricScoreInput): Promise<RubricResult> {
  const model = input.model ?? DEFAULT_RUBRIC_MODEL;
  const spec = input.rubric;

  if (!input.artifact || !input.artifact.trim()) {
    input.logger?.("[rubric] empty artifact — scoring 0/N deterministically (not sent to model)");
    return {
      perCriterion: spec.criteria.map((c) => ({
        id: c.id,
        met: false,
        reasoning: "artifact was empty or missing",
      })),
      score: 0,
      total: spec.criteria.length,
      passed: false,
      model,
      emptyArtifact: true,
    };
  }

  const system = buildRubricSystem(spec);
  const user = buildRubricUser(input);
  const llm =
    input.llm ??
    ((s: string, u: string, m: string) => {
      const key = input.openaiApiKey ?? process.env.OPENAI_API_KEY;
      if (!key) throw new Error("scoreRubric needs an OpenAI key (OPENAI_API_KEY) — none provided");
      return callOpenAIRubric(s, u, m, key, { logger: input.logger });
    });
  const reply = await llm(system, user, model);
  const perCriterion = parseRubricVerdicts(reply, spec);
  const score = perCriterion.filter((c) => c.met).length;
  return {
    perCriterion,
    score,
    total: spec.criteria.length,
    passed: score >= spec.passThreshold,
    model,
  };
}
