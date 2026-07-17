/**
 * Shared contracts for the #784 procedure-adherence harness (v0 increment).
 *
 * These types are the ONE contract that the tee-substrate reader, the run-shape
 * floor, the AdherenceJudge, and the hand-authored fixtures all agree on. The
 * raw substrate is Claude Code `--output-format stream-json` events
 * ({@link ClaudeStreamMessage}); {@link normalizeTurns} derives the
 * {@link NormalizedTurn} view that the floor and judge actually reason over.
 *
 * NOTE: {@link ClaudeStreamMessage} is imported as a TYPE only, so nothing in
 * this module (or the modules that consume it) carries a runtime dependency on
 * `@langwatch/scenario`. That keeps the AC-proving code paths (corpus gen, judge
 * scoring, fixture harness) runnable via plain `tsx` without the core build.
 */

import type { ClaudeStreamMessage } from "@langwatch/scenario";

export type { ClaudeStreamMessage };

/** Role of a normalized turn once the stream-json event stream is classified. */
export type TurnRole = "human" | "assistant" | "tool" | "system" | "result" | "other";

/** A single `tool_use` block lifted out of an assistant message. */
export interface NormToolUse {
  /** The `tool_use` block id (links to the matching `tool_result`), if present. */
  id?: string;
  /** Tool name, e.g. `Read`, `Bash`, `Edit`, `Grep`. */
  name: string;
  /** Raw tool input (shape is tool-specific). */
  input: unknown;
  /** `JSON.stringify(input)` — the searchable text form of the input. */
  inputText: string;
}

/** A single `tool_result` block lifted out of a (synthetic user-role) tool turn. */
export interface NormToolResult {
  /** The `tool_use_id` this result answers, if present. */
  toolUseId?: string;
  /** Readable text of the result content. */
  content: string;
  /** Whether the tool reported an error. */
  isError: boolean;
}

/**
 * The normalized view of one conversation turn. This is what the floor and judge
 * read. Crucially:
 *  - `text` and `thinking` are PROSE — they are NEVER evidence that a procedure
 *    was followed (the judge ignores them; a subject that merely SAYS it followed
 *    X has not followed X).
 *  - `toolUses` / `toolResults` are the ONLY following-evidence.
 *  - `injected` marks a hook-injected turn (e.g. a UserPromptSubmit instruction
 *    sheet). Injected turns are ignored as following-evidence too.
 */
export interface NormalizedTurn {
  index: number;
  role: TurnRole;
  text: string;
  thinking: string;
  toolUses: NormToolUse[];
  toolResults: NormToolResult[];
  injected: boolean;
  raw: ClaudeStreamMessage;
}

/** One action record in the judge's evidence log (tool_use OR tool_result). */
export interface ActionRecord {
  turnIndex: number;
  kind: "tool_use" | "tool_result";
  name?: string;
  input?: unknown;
  content?: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Corpus contracts (produced by generate-corpus.ts, consumed by the judge).
// ---------------------------------------------------------------------------

/** One procedure as indexed for the judge (parsed from a generated PROCEDURE.md). */
export interface ProcedureEntry {
  id: string;
  /** Repo-relative path of the PROCEDURE.md, e.g. `corpus/deploy-service/PROCEDURE.md`. */
  path: string;
  kind: "procedure";
  title: string;
  keywords: string[];
  /** Ids of procedures this one links to (outgoing edges). */
  links: string[];
  status: "active" | "draft" | "deprecated";
  /** Full markdown body (frontmatter stripped) — what the judge reads. */
  body: string;
  tokens: number;
}

/** A ground-truth transitive chain authored into the corpus (A -> B -> ...). */
export interface Chain {
  /** The chain root procedure id (A). */
  root: string;
  /** Ordered procedure ids: [A, B, ...]. Following A REQUIRES following the rest. */
  steps: string[];
  description: string;
}

/** A named scenario's AUTHORED applicable-procedure set (the judge's denominator). */
export interface ScenarioSet {
  id: string;
  description: string;
  /** Authored applicable procedure ids — the DENOMINATOR, never judge-decided. */
  applicable: string[];
  /** If this scenario centers on a transitive chain, its root id. */
  targetChainRoot?: string;
}

/** The machine-readable manifest emitted alongside the generated corpus. */
export interface CorpusManifest {
  generatedAt: string;
  seed: number;
  tokenizer: string;
  totalTokens: number;
  fileCount: number;
  metaProcedureId: string;
  procedures: Array<{
    id: string;
    path: string;
    keywords: string[];
    links: string[];
    status: string;
    tokens: number;
  }>;
  chains: Chain[];
  scenarios: ScenarioSet[];
}

/** In-memory corpus index the judge scores against (id -> entry). */
export type CorpusIndex = Map<string, ProcedureEntry>;

// ---------------------------------------------------------------------------
// Judge contracts.
// ---------------------------------------------------------------------------

export type Attribution =
  | "none"
  | "retrieval-miss"
  | "instruction-sheet-miss"
  | "agent-override";

export type Strategy = "none" | "baseline" | "h1" | "h2" | "h3";

/** Per-procedure adherence verdict. */
export interface ProcedureVerdict {
  id: string;
  /** Authored applicability — echoed from the AUTHORED set, never judge-decided. */
  applied: boolean;
  /** Did the subject actually follow it, judged from tool_use/tool_result ONLY. */
  followed: boolean;
  /**
   * For a chain root: did the subject follow the whole A->B(->...) chain.
   * `null` when the procedure has no outgoing chain.
   */
  transitiveChainFollowed: boolean | null;
  /** Deterministic: was the procedure's content available to the subject at all. */
  surfaced: boolean;
  attribution: Attribution;
  reasoning: string;
}

export interface AdherenceReport {
  perProcedure: ProcedureVerdict[];
  applicableCount: number;
  followedCount: number;
  /** followedCount / applicableCount (0 when denominator is 0). */
  adherenceRate: number;
  /** Set true when the run-shape floor excluded this run (never scored). */
  belowFloor?: boolean;
  /** Model id used for the semantic judgment. */
  model?: string;
}
