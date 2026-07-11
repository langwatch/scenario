/**
 * hooks-lib.mjs — the self-contained runtime shared by both strategy hooks.
 *
 * TWO roles from ONE source of truth:
 *   1. A library of PURE functions (`loadCorpus`, `bm25`, `retrieve`,
 *      `readOAuthToken`, `callHaiku`, `buildCompile*`, `buildVerify*`) that the
 *      offline smoke imports (`await import(...)`) and unit-exercises directly.
 *   2. A runnable Claude Code hook entrypoint: `node hooks-lib.mjs <mode>` where
 *      mode is `baseline` | `h1-compile` | `h1-verify`. Reads the hook JSON from
 *      stdin, does its job, writes stdout (context injection for the two
 *      UserPromptSubmit modes), appends evidence, and exits 0 (never blocks).
 *
 * Node builtins ONLY (fs/path/os) so it runs as a bare `node` hook inside the
 * sandbox with no install step and no repo `import` resolution.
 *
 * L4 — Haiku is called via the DIRECT OAuth Messages API, never `claude -p
 * --model haiku` (a nested `claude` inherits CLAUDE_CONFIG_DIR and re-fires this
 * same UserPromptSubmit hook -> infinite loop). This mirrors the
 * `callAnthropicOAuth` pattern in `judge-core.ts`: fresh token from
 * `$CLAUDE_CONFIG_DIR/.credentials.json`, `Authorization: Bearer <token>`,
 * `anthropic-beta: oauth-2025-04-20`, model `claude-haiku-4-5`. There is NO
 * ANTHROPIC_API_KEY on this box — auth is Claude Max OAuth.
 *
 * Env read at hook time:
 *   ADHERENCE_CORPUS_DIR   absolute path to the committed `corpus/` (read-only)
 *   ADHERENCE_HOOK_LOG     absolute path to append hook-fired evidence (jsonl)
 *   ADHERENCE_RETRIEVAL_K  top-K candidates (default 5)
 *   ADHERENCE_HAIKU_MODEL  default `claude-haiku-4-5`
 *   CLAUDE_CONFIG_DIR      creds live at `$CLAUDE_CONFIG_DIR/.credentials.json`
 */

import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5";

/**
 * OAuth Claude Max tokens are only authorized for the Claude Code client, so the
 * FIRST system block must present that identity or the Messages API rejects the
 * credential (401/403). The task-specific instruction follows as a second block.
 */
export const CLAUDE_CODE_SPOOF =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// ---------------------------------------------------------------------------
// Corpus loading + BM25 retrieval (node-builtins only).
// ---------------------------------------------------------------------------

/** Parse `---`-fenced frontmatter (id/keywords/links/status) + body. */
export function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { id: "", keywords: [], links: [], status: "active", body: raw };
  const fm = { id: "", keywords: [], links: [], status: "active" };
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "keywords" || k === "links") {
      fm[k] = v
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      fm[k] = v.trim();
    }
  }
  return { ...fm, body: m[2] };
}

/** Load every `corpus/<id>/PROCEDURE.md` into a lightweight entry array. */
export function loadCorpus(dir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = join(dir, d.name, "PROCEDURE.md");
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");
    const { id, keywords, links, status, body } = parseFrontmatter(raw);
    entries.push({
      id: id || d.name,
      path: `corpus/${d.name}/PROCEDURE.md`,
      keywords,
      links,
      status,
      body,
      tokens: tokenize(body),
    });
  }
  return entries;
}

const STOP_WORDS = new Set(
  "the a an of to and or is are be for on in it its this that with as by from at into so you your我 not no do does done every any all use used using when where which who what how".split(
    /\s+/,
  ),
);

/** Lowercase word tokens, stop-words removed, length>=3. */
export function tokenize(s) {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOP_WORDS.has(t),
  );
}

/**
 * BM25 over the corpus BODIES (not just frontmatter keywords). Body-level
 * scoring is deliberate: the AC4 target moment is phrased to avoid the target
 * procedure's FRONTMATTER keywords, so a frontmatter-only gate would miss it;
 * scoring full bodies keeps the target inside the top-K CANDIDATE set where the
 * H1 Haiku compile can still disambiguate it. Returns entries ranked by score.
 */
export function bm25(query, corpus, k = 5, { k1 = 1.5, b = 0.75 } = {}) {
  const qTerms = [...new Set(tokenize(query))];
  const N = corpus.length || 1;
  const avgdl = corpus.reduce((s, d) => s + d.tokens.length, 0) / N || 1;

  // Document frequency per query term.
  const df = new Map();
  for (const term of qTerms) {
    let n = 0;
    for (const d of corpus) if (d.tokens.includes(term)) n++;
    df.set(term, n);
  }

  const scored = corpus.map((d) => {
    const dl = d.tokens.length || 1;
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
    }
    return { entry: d, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((s) => ({ ...s.entry, score: s.score }));
}

/** Retrieve top-K candidate procedure entries for a query. */
export function retrieve(query, corpus, k = 5) {
  return bm25(query, corpus, k);
}

/** Render retrieved procedure BODIES for verbatim baseline injection. */
export function formatRetrievedBodies(entries) {
  if (!entries.length) {
    return "No procedure matched this request. If this is a routine operation, check whether a written procedure should be followed.";
  }
  const blocks = entries
    .map(
      (e) =>
        `----- PROCEDURE ${e.id} (status: ${e.status}) -----\n${e.body.trim()}\n----- END ${e.id} -----`,
    )
    .join("\n\n");
  return `RETRIEVED PROCEDURES (authoritative — if one applies to the request, follow its numbered steps exactly, including any transitive hand-off it names):\n\n${blocks}`;
}

// ---------------------------------------------------------------------------
// OAuth Messages API (Haiku) — direct call, L4.
// ---------------------------------------------------------------------------

/** Read the Claude Max OAuth access token FRESH (picks up ~24h in-place refresh). */
export function readOAuthToken(credentialsPath) {
  const raw = readFileSync(credentialsPath, "utf8");
  const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error(
      `No claudeAiOauth.accessToken in ${credentialsPath}. Auth is Claude Max OAuth; there is no ANTHROPIC_API_KEY.`,
    );
  }
  return token;
}

export function defaultCredsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call Haiku via the OAuth Messages API. Returns a STRUCTURED result
 * `{ ok, status, text, error }` — a throttled/empty response is `ok:false`,
 * which the caller treats as an INVALID turn (never a violation, F14). Retries
 * are DELIBERATELY few (hooks must stay fast; the pre-turn hook is on the
 * subject's critical path): a couple of short backoffs, then give up cleanly.
 */
export async function callHaiku(
  system,
  user,
  {
    credentialsPath = defaultCredsPath(),
    model = process.env.ADHERENCE_HAIKU_MODEL ?? DEFAULT_HAIKU_MODEL,
    maxTokens = 1200,
    maxRetries = 2,
  } = {},
) {
  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let token;
    try {
      token = readOAuthToken(credentialsPath);
    } catch (e) {
      return { ok: false, status: 0, text: "", error: `cred: ${String(e.message ?? e)}` };
    }
    let res;
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
          max_tokens: maxTokens,
          temperature: 0,
          system: [
            { type: "text", text: CLAUDE_CODE_SPOOF },
            { type: "text", text: system },
          ],
          messages: [{ role: "user", content: user }],
        }),
      });
    } catch (e) {
      lastErr = `network: ${String(e.message ?? e)}`;
      await sleep(1500 * (attempt + 1));
      continue;
    }
    lastStatus = res.status;
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const text = (data.content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) return { ok: false, status: res.status, text: "", error: "empty content" };
      return { ok: true, status: res.status, text, error: "" };
    }
    lastErr = (await res.text().catch(() => "")).slice(0, 200);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxRetries) break;
    const ra = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * (attempt + 1));
  }
  return { ok: false, status: lastStatus, text: "", error: lastErr || `http ${lastStatus}` };
}

// ---------------------------------------------------------------------------
// Prompt construction (compile + verify).
// ---------------------------------------------------------------------------

export function buildCompileSystem() {
  return `You compile a BINDING INSTRUCTION SHEET for an autonomous coding agent that is about to act.
You are given the user's request and a set of CANDIDATE procedures retrieved from a large procedure corpus.
Your job:
1. Decide which ONE candidate (if any) actually governs this request — reason about intent, not keyword overlap; the request may be phrased without the procedure's own vocabulary.
2. If a procedure applies, emit a short, imperative instruction sheet: name the governing procedure id, then list ITS numbered steps as concrete actions the agent must carry out, and include any transitive hand-off procedure it names (with that procedure's steps too).
3. If none applies, say so in one line.
Output plain text (no markdown headers needed). Be concise and binding — the agent will treat this as a must-follow directive. Do NOT invent steps that are not in the candidate procedures.`;
}

export function buildCompileUser(prompt, candidates) {
  const blocks = candidates
    .map(
      (e) =>
        `--- CANDIDATE ${e.id} (links: ${(e.links ?? []).join(", ") || "none"}) ---\n${e.body.trim()}`,
    )
    .join("\n\n");
  return `USER REQUEST:\n${prompt}\n\nCANDIDATE PROCEDURES:\n${blocks}\n\nCompile the binding instruction sheet now.`;
}

export function buildVerifySystem() {
  return `You verify whether an autonomous coding agent ADHERED to the procedure it was bound to this turn.
Judge ONLY from concrete actions (tool calls / file writes / commands) evident in the transcript — never from the agent's prose claims.
Reply with STRICT JSON: {"adhered": true|false, "missingSteps": ["..."], "note": "one sentence"}.`;
}

export function buildVerifyUser(sheet, transcriptText) {
  return `INSTRUCTION SHEET THE AGENT WAS BOUND TO:\n${sheet || "(none captured)"}\n\nTRANSCRIPT (agent turn):\n${String(transcriptText).slice(0, 8000)}\n\nReturn the strict JSON verdict now.`;
}

// ---------------------------------------------------------------------------
// Compiled-sheet id extraction (#784 H1-attribution fix).
// ---------------------------------------------------------------------------

/**
 * Which corpus procedure ids the COMPILED SHEET TEXT actually names — the
 * governing procedure Haiku chose plus any transitive hand-off it included.
 * DELIBERATELY different from `retrieved` (the BM25 candidate pool handed to
 * Haiku as raw material): a hand-off id (e.g. `reconcile-invoice`) can be named
 * by Haiku from inside a candidate's body ("## Follow-on procedures") even when
 * that id was never itself a top-K candidate, so scanning `retrieved` alone
 * would miss it. Checked against the FULL corpus id set (not just `retrieved`)
 * for that reason.
 *
 * Why this matters: this sheet is handed to the subject via the
 * UserPromptSubmit hook's STDOUT, which `claude -p` folds into the subject's
 * INPUT context for that turn — it is NOT re-emitted into the
 * `--output-format stream-json` STDOUT the harness tees (verified empirically:
 * zero occurrences of the compiled sheet's own text in any tee'd
 * `<n>.stream.jsonl`). So a procedure the sheet named but the substrate never
 * independently mentions (no grep/read of its own PROCEDURE.md) is invisible to
 * `computeSurfaced` unless this list is fed in separately — an H1 procedure
 * that WAS compiled into the sheet then skipped was previously misattributed
 * `retrieval-miss` (as if H1 never surfaced it at all) instead of
 * `instruction-sheet-miss`/`agent-override`.
 */
export function compiledIdsFromSheet(sheetText, corpus) {
  if (!sheetText) return [];
  return corpus.filter((c) => sheetText.includes(c.id)).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Hook I/O helpers.
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    // A hook always gets stdin under claude -p; guard anyway.
    setTimeout(() => resolve(buf), 5000).unref?.();
  });
}

function parseHookInput(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** Append one evidence line; failures here must never break the subject turn. */
export function logHookEvent(logPath, obj) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {
    /* best-effort */
  }
}

/** Read the current turn's transcript text for the Stop verify, best-effort. */
function readTranscriptText(input) {
  const last = input.last_assistant_message;
  const parts = [];
  if (typeof last === "string" && last.trim()) parts.push(`assistant: ${last}`);
  const tp = input.transcript_path;
  if (tp && existsSync(tp)) {
    try {
      const lines = readFileSync(tp, "utf8").split("\n").filter(Boolean);
      // The on-disk transcript is JSONL; pull any readable text/tool content.
      for (const l of lines.slice(-80)) {
        try {
          const o = JSON.parse(l);
          const c = o?.message?.content ?? o?.content;
          if (typeof c === "string") parts.push(c);
          else if (Array.isArray(c)) {
            for (const b of c) {
              if (b?.type === "text" && b.text) parts.push(b.text);
              else if (b?.type === "tool_use") parts.push(`[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 300)}]`);
              else if (b?.type === "tool_result") parts.push(`[tool_result ${String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 300)}]`);
            }
          }
        } catch {
          /* skip non-JSON line */
        }
      }
    } catch {
      /* transcript may lag; last_assistant_message still gives signal */
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Hook mode dispatch.
// ---------------------------------------------------------------------------

async function runBaseline(input, env) {
  const prompt = input.user_prompt ?? input.prompt ?? "";
  const corpus = loadCorpus(env.corpusDir);
  const hits = retrieve(prompt, corpus, env.k);
  logHookEvent(env.logPath, {
    mode: "baseline",
    event: "userpromptsubmit",
    retrieved: hits.map((h) => h.id),
    promptChars: prompt.length,
  });
  // Plain stdout on exit 0 is added to the subject's context (fair retrieval).
  process.stdout.write(formatRetrievedBodies(hits));
  process.exit(0);
}

async function runH1Compile(input, env) {
  const prompt = input.user_prompt ?? input.prompt ?? "";
  const corpus = loadCorpus(env.corpusDir);
  const hits = retrieve(prompt, corpus, env.k);
  const res = await callHaiku(buildCompileSystem(), buildCompileUser(prompt, hits), {
    credentialsPath: env.credsPath,
    model: env.haikuModel,
  });
  // ids the compiled SHEET TEXT actually names (governing + hand-off), not just
  // the raw BM25 candidate pool -- feeds computeSurfaced for H1 attribution
  // (#784 fix; see compiledIdsFromSheet doc).
  const compiledIds = res.ok ? compiledIdsFromSheet(res.text, corpus) : [];
  logHookEvent(env.logPath, {
    mode: "h1-compile",
    event: "userpromptsubmit",
    retrieved: hits.map((h) => h.id),
    compiledIds,
    haikuStatus: res.status,
    haikuOk: res.ok,
    error: res.error || undefined,
    model: env.haikuModel,
  });
  if (res.ok) {
    // Hand the sheet to the Stop-verify hook (separate process) via a file.
    if (env.sheetFile) {
      try {
        writeFileSync(env.sheetFile, res.text);
      } catch {
        /* best-effort */
      }
    }
    process.stdout.write(
      `BINDING INSTRUCTION SHEET (compiled for this turn — you MUST follow it):\n\n${res.text}`,
    );
  } else {
    // Throttled/empty compile: the turn is marked INVALID by the instrument
    // (via the hook log), NOT a violation. Still surface the raw candidates so
    // the turn is not left blind.
    logHookEvent(env.logPath, { mode: "h1-compile", event: "invalid-turn", reason: res.error, haikuStatus: res.status });
    process.stdout.write(
      `${formatRetrievedBodies(hits)}\n\n[note: instruction-sheet compile was unavailable this turn]`,
    );
  }
  process.exit(0);
}

async function runH1Verify(input, env) {
  if (input.stop_hook_active === true) process.exit(0); // never block; yield the loop guard
  const transcript = readTranscriptText(input);
  let sheet = "";
  if (env.sheetFile && existsSync(env.sheetFile)) {
    try {
      sheet = readFileSync(env.sheetFile, "utf8");
    } catch {
      /* verify generically without the sheet */
    }
  }
  const res = await callHaiku(buildVerifySystem(), buildVerifyUser(sheet, transcript), {
    credentialsPath: env.credsPath,
    model: env.haikuModel,
  });
  let verdict = null;
  if (res.ok) {
    try {
      const s = res.text.indexOf("{");
      const e = res.text.lastIndexOf("}");
      if (s !== -1 && e !== -1) verdict = JSON.parse(res.text.slice(s, e + 1));
    } catch {
      /* leave verdict null */
    }
  }
  logHookEvent(env.logPath, {
    mode: "h1-verify",
    event: "stop",
    haikuStatus: res.status,
    haikuOk: res.ok,
    error: res.error || undefined,
    verdict,
    model: env.haikuModel,
  });
  // Observe-only: exit 0 with no blocking output.
  process.exit(0);
}

function hookEnv() {
  return {
    corpusDir: process.env.ADHERENCE_CORPUS_DIR ?? "",
    logPath: process.env.ADHERENCE_HOOK_LOG ?? "",
    k: Number(process.env.ADHERENCE_RETRIEVAL_K ?? 5) || 5,
    haikuModel: process.env.ADHERENCE_HAIKU_MODEL ?? DEFAULT_HAIKU_MODEL,
    credsPath: defaultCredsPath(),
    sheetFile: process.env.ADHERENCE_SHEET_FILE ?? "",
  };
}

async function main() {
  const mode = process.argv[2];
  const env = hookEnv();
  let input = {};
  try {
    input = parseHookInput(await readStdin());
  } catch {
    input = {};
  }
  try {
    if (mode === "baseline") return await runBaseline(input, env);
    if (mode === "h1-compile") return await runH1Compile(input, env);
    if (mode === "h1-verify") return await runH1Verify(input, env);
    // Unknown mode: no-op, do not disturb the turn.
    process.exit(0);
  } catch (e) {
    logHookEvent(env.logPath, { mode, event: "hook-error", error: String(e?.message ?? e) });
    // A hook failure must NOT abort the subject turn; exit 0 (non-blocking).
    process.exit(0);
  }
}

// Only run the dispatcher when executed directly as a hook (not when imported).
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("hooks-lib.mjs") && process.argv[2];
if (invokedDirectly) {
  main();
}
