/**
 * normalize — turn the raw Claude Code `stream-json` event array into the
 * {@link NormalizedTurn} view the floor and judge reason over.
 *
 * The single most important classification here: a `user`-type stream event is
 * NOT necessarily a human turn. Claude Code wraps TOOL RESULTS as `user`-role
 * messages (content = `[{type:"tool_result", ...}]`). So:
 *   - `user` event carrying tool_result blocks  -> role "tool"   (action output)
 *   - `user` event carrying text/string content -> role "human"  (real prompt)
 * Getting this wrong would let a tool-result masquerade as the "real human user
 * turn" the run-shape floor requires.
 *
 * `text` and `thinking` are captured but are PROSE — the judge never treats them
 * as evidence-of-following. `injected` flags hook-injected turns (e.g. an H1
 * instruction sheet delivered via a UserPromptSubmit hook); those are ignored as
 * following-evidence too. Fixtures mark an injected event with `_injected: true`
 * (tolerated by the open stream-json wire shape).
 */

import type {
  ClaudeStreamMessage,
  NormalizedTurn,
  NormToolResult,
  NormToolUse,
  ActionRecord,
} from "./types.ts";

/** `JSON.stringify` that never throws. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

/** Render a `tool_result` block's content (string | text-parts | object) to text. */
function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return safeStringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  return safeStringify(content);
}

/** True when a raw event (or its inner message) is marked hook-injected. */
function isInjected(raw: ClaudeStreamMessage): boolean {
  if ((raw as Record<string, unknown>)["_injected"] === true) return true;
  const msg = raw.message as Record<string, unknown> | undefined;
  if (msg && msg["_injected"] === true) return true;
  // A system event whose subtype names a hook (e.g. "user_prompt_submit_hook").
  const subtype = (raw as Record<string, unknown>)["subtype"];
  if (typeof subtype === "string" && /hook/i.test(subtype)) return true;
  return false;
}

interface BlocksAcc {
  text: string[];
  thinking: string[];
  toolUses: NormToolUse[];
  toolResults: NormToolResult[];
}

function walkBlocks(content: unknown, acc: BlocksAcc): void {
  if (typeof content === "string") {
    if (content) acc.text.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    switch (b["type"]) {
      case "text":
        if (typeof b["text"] === "string") acc.text.push(b["text"]);
        break;
      case "thinking":
        // thinking content may live under `thinking` or `text`
        if (typeof b["thinking"] === "string") acc.thinking.push(b["thinking"]);
        else if (typeof b["text"] === "string") acc.thinking.push(b["text"]);
        break;
      case "tool_use": {
        const input = b["input"];
        acc.toolUses.push({
          id: typeof b["id"] === "string" ? b["id"] : undefined,
          name: typeof b["name"] === "string" ? b["name"] : "unknown",
          input,
          inputText: safeStringify(input),
        });
        break;
      }
      case "tool_result":
        acc.toolResults.push({
          toolUseId:
            typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : undefined,
          content: renderToolResultContent(b["content"]),
          isError: b["is_error"] === true,
        });
        break;
      default:
        break;
    }
  }
}

/**
 * Classify and normalize a raw stream-json event array into ordered turns.
 * Events that carry no `message` (e.g. `system`/`result`/`rate_limit_event`) are
 * still emitted as turns (role "system"/"result"/"other") so the floor can count
 * total run shape, but they carry no tool evidence.
 */
export function normalizeTurns(messages: ClaudeStreamMessage[]): NormalizedTurn[] {
  const turns: NormalizedTurn[] = [];
  messages.forEach((raw, index) => {
    const type = typeof raw.type === "string" ? raw.type : "other";
    const injected = isInjected(raw);
    const acc: BlocksAcc = { text: [], thinking: [], toolUses: [], toolResults: [] };

    if (raw.message) walkBlocks(raw.message.content, acc);

    let role: NormalizedTurn["role"];
    switch (type) {
      case "assistant":
        role = "assistant";
        break;
      case "user":
        // A user event with tool_result blocks is TOOL output, not a human turn.
        role = acc.toolResults.length > 0 ? "tool" : "human";
        break;
      case "system":
        role = "system";
        break;
      case "result":
        role = "result";
        break;
      default:
        role = "other";
        break;
    }

    turns.push({
      index,
      role,
      text: acc.text.join("\n"),
      thinking: acc.thinking.join("\n"),
      toolUses: acc.toolUses,
      toolResults: acc.toolResults,
      injected,
      raw,
    });
  });
  return turns;
}

/**
 * The judge's evidence log: every tool_use and tool_result IN ORDER, with
 * injected turns EXCLUDED. Prose/thinking are intentionally absent — this is the
 * ONLY thing `followed` is scored from.
 */
export function extractActionLog(turns: NormalizedTurn[]): ActionRecord[] {
  const log: ActionRecord[] = [];
  for (const t of turns) {
    if (t.injected) continue;
    for (const tu of t.toolUses) {
      log.push({ turnIndex: t.index, kind: "tool_use", name: tu.name, input: tu.input });
    }
    for (const tr of t.toolResults) {
      log.push({
        turnIndex: t.index,
        kind: "tool_result",
        content: tr.content,
        isError: tr.isError,
      });
    }
  }
  return log;
}

/** Format the action log as compact, judge-readable lines. */
export function formatActionLog(log: ActionRecord[]): string {
  if (log.length === 0) return "(no tool actions in transcript)";
  return log
    .map((r) => {
      if (r.kind === "tool_use") {
        return `#${r.turnIndex} tool_use ${r.name} input=${safeStringify(r.input).slice(0, 600)}`;
      }
      return `#${r.turnIndex} tool_result${r.isError ? " (error)" : ""} ${String(
        r.content,
      ).slice(0, 600)}`;
    })
    .join("\n");
}

export { safeStringify };
