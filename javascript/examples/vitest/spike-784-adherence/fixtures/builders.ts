/**
 * builders — construct ground-truth substrate FIXTURES in the SAME shape the
 * judge consumes: raw Claude Code `stream-json` events
 * ({@link ClaudeStreamMessage}), plus a mini-corpus and declared ground truth.
 *
 * Stream shape modeled on the exported `parseStreamJson`/`ClaudeStreamMessage`:
 *   - assistant text        -> {type:"assistant", message:{content:[{type:"text"}]}}
 *   - assistant thinking     -> {type:"assistant", message:{content:[{type:"thinking"}]}}
 *   - assistant tool_use     -> {type:"assistant", message:{content:[{type:"tool_use",...}]}}
 *   - tool result (as user)  -> {type:"user",      message:{content:[{type:"tool_result",...}]}}
 *   - real human turn        -> {type:"user",      message:{content:"..."}}
 *   - hook-injected turn     -> as above + `_injected:true` (ignored as evidence)
 */

import type {
  Attribution,
  Chain,
  ClaudeStreamMessage,
  CorpusIndex,
  ProcedureEntry,
  Strategy,
} from "../types.ts";
import type { FloorOpts } from "../run-shape-floor.ts";

let toolCounter = 0;
function nextToolId(): string {
  toolCounter += 1;
  return `toolu_${toolCounter.toString().padStart(4, "0")}`;
}

/** A real human user turn (string content -> classified "human"). */
export function human(text: string): ClaudeStreamMessage {
  return { type: "user", message: { role: "user", content: text } };
}

/** A hook-injected turn (e.g. an H1 instruction sheet) — ignored as evidence. */
export function injected(text: string): ClaudeStreamMessage {
  return { type: "user", message: { role: "user", content: text }, _injected: true };
}

/** Assistant visible text (prose — never evidence). */
export function assistantText(text: string): ClaudeStreamMessage {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** Assistant thinking block (never evidence). */
export function thinking(text: string): ClaudeStreamMessage {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } };
}

/** An assistant tool_use. Returns {msg, id} so a matching tool_result can link. */
export function toolUse(
  name: string,
  input: unknown,
  precedingText?: string,
): { msg: ClaudeStreamMessage; id: string } {
  const id = nextToolId();
  const content: Array<Record<string, unknown>> = [];
  if (precedingText) content.push({ type: "text", text: precedingText });
  content.push({ type: "tool_use", id, name, input });
  return { msg: { type: "assistant", message: { role: "assistant", content } }, id };
}

/** A tool_result (arrives as a user-role event; classified "tool"). */
export function toolResult(
  content: string,
  opts: { toolUseId?: string; isError?: boolean } = {},
): ClaudeStreamMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          content,
          is_error: opts.isError ?? false,
        },
      ],
    },
  };
}

/** Convenience: a Read tool_use immediately followed by its result (the file body). */
export function readFile(path: string, body: string): ClaudeStreamMessage[] {
  const { msg, id } = toolUse("Read", { file_path: path });
  return [msg, toolResult(body, { toolUseId: id })];
}

/** Convenience: a Bash tool_use immediately followed by its result. */
export function bash(command: string, result: string, isError = false): ClaudeStreamMessage[] {
  const { msg, id } = toolUse("Bash", { command });
  return [msg, toolResult(result, { toolUseId: id, isError })];
}

/** Convenience: a Write tool_use immediately followed by its result. */
export function write(path: string, content: string, result = "written"): ClaudeStreamMessage[] {
  const { msg, id } = toolUse("Write", { file_path: path, content });
  return [msg, toolResult(result, { toolUseId: id })];
}

export function systemInit(): ClaudeStreamMessage {
  return { type: "system", subtype: "init", session_id: "fixture" };
}
export function resultLine(isError = false): ClaudeStreamMessage {
  return { type: "result", subtype: isError ? "error" : "success", is_error: isError };
}

/** Build a mini-corpus procedure entry. */
export function proc(
  id: string,
  body: string,
  opts: { links?: string[]; status?: ProcedureEntry["status"]; title?: string; keywords?: string[] } = {},
): ProcedureEntry {
  return {
    id,
    path: `corpus/${id}/PROCEDURE.md`,
    kind: "procedure",
    title: opts.title ?? id,
    keywords: opts.keywords ?? [id],
    links: opts.links ?? [],
    status: opts.status ?? "active",
    body,
    tokens: 0,
  };
}

export function miniCorpus(entries: ProcedureEntry[]): CorpusIndex {
  return new Map(entries.map((e) => [e.id, e]));
}

/** Declared ground truth for one applicable procedure in a fixture. */
export interface GroundTruth {
  followed: boolean;
  attribution: Attribution;
  /** Expected transitiveChainFollowed (only asserted when defined). */
  transitiveChainFollowed?: boolean | null;
}

/** A complete ground-truth fixture the judge is scored against. */
export interface Fixture {
  id: string;
  description: string;
  /** What failure-surface property this fixture pins down. */
  covers: string;
  strategy?: Strategy;
  compiledSheetIds?: string[];
  applicable: string[];
  corpus: CorpusIndex;
  chains: Chain[];
  messages: ClaudeStreamMessage[];
  floor?: FloorOpts | false;
  groundTruth: Record<string, GroundTruth>;
}
