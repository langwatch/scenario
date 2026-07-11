/**
 * SPIKE #779 — Claude Code transcript reader + Anthropic→AI-SDK message adapter.
 *
 * THROWAWAY prototype (Strategy A/B). This is the CC-adapter-specific knowledge:
 * how to turn a raw Claude Code session JSONL into a linear AI-SDK `ModelMessage[]`
 * that a Scenario can be seeded with.
 *
 * A Claude Code session JSONL is an append log threaded as a TREE via parentUuid/uuid
 * (not a flat list). The "live" conversation is the path from the chosen leaf back to
 * root, so we WALK the parentUuid chain — we never read the file top-to-bottom.
 *
 * Load-bearing normalizations (all exercised by reader.test.ts against a real transcript):
 *   1. Walk parentUuid leaf→root, then reverse to root→leaf order.
 *   2. Drop non-conversational metadata lines (attachment/system/file-history-snapshot/…).
 *   3. `role:"user"` is OVERLOADED — classify each as human | injected(command/skill) | tool_result.
 *   4. One assistant message is SPLIT across multiple JSONL lines (one per content block),
 *      all sharing one `message.id` — re-merge them into a single assistant turn.
 *   5. Pair each Anthropic `tool_result` back to its `tool_use` by id to recover toolName
 *      (AI-SDK v6 tool-result parts REQUIRE a toolName; Anthropic tool_result carries only the id).
 *   6. `thinking` blocks ARE captured — preserved in the normalized model, but DROPPED by
 *      default when emitting to AI-SDK (feeding Anthropic reasoning to a non-Anthropic model
 *      is invalid). Toggle with includeThinking.
 */
import { readFileSync } from "node:fs";
import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Raw JSONL node types (only the fields we use)
// ---------------------------------------------------------------------------

export interface RawNode {
  type?: string; // "user" | "assistant" | "attachment" | "system" | ...
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | AnthropicBlock[];
  };
}

export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

export type UserKind = "human" | "injected" | "tool_result";

// ---------------------------------------------------------------------------
// 1. Parse + walk the tree
// ---------------------------------------------------------------------------

export function parseSessionFile(path: string): RawNode[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as RawNode;
      } catch {
        return null;
      }
    })
    .filter((n): n is RawNode => !!n && !!n.uuid);
}

/**
 * Walk the parentUuid chain from a leaf back to the root, returning root→leaf order.
 * If `forkAtUuid` is given, that node is treated as the leaf (fork point) and the
 * walk starts there — everything after it in the tree is discarded.
 * Otherwise the leaf is the last-in-file node that is nobody's parent (the live tip).
 */
export function linearize(nodes: RawNode[], forkAtUuid?: string): RawNode[] {
  const byUuid = new Map<string, RawNode>();
  for (const n of nodes) byUuid.set(n.uuid!, n);

  let leaf = forkAtUuid;
  if (!leaf) {
    const parents = new Set<string | null | undefined>(nodes.map((n) => n.parentUuid));
    const leaves = nodes.filter((n) => !parents.has(n.uuid));
    // pick the leaf that appears last in file order = the live conversation tip
    leaf = leaves.length ? leaves[leaves.length - 1].uuid : nodes[nodes.length - 1]?.uuid;
  }

  const chain: RawNode[] = [];
  let cur: string | null | undefined = leaf;
  const seen = new Set<string>(); // guard against pathological cycles
  while (cur && byUuid.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(byUuid.get(cur)!);
    cur = byUuid.get(cur)!.parentUuid;
  }
  return chain.reverse();
}

export function isConversational(n: RawNode): boolean {
  return n.type === "user" || n.type === "assistant";
}

/** Classify an overloaded `role:"user"` line. */
export function classifyUser(n: RawNode): UserKind {
  const c = n.message?.content;
  if (typeof c === "string") return "human";
  if (Array.isArray(c)) {
    if (c.some((b) => (b as AnthropicBlock).type === "tool_result")) return "tool_result";
    // array of text blocks with no tool_result = a command/skill injection carried as a user turn
    return "injected";
  }
  return "injected";
}

// ---------------------------------------------------------------------------
// 2. Normalized, provenance-tagged view (fidelity-preserving; keeps thinking)
// ---------------------------------------------------------------------------

export interface NormalizedTurn {
  role: "user" | "assistant" | "tool";
  userKind?: UserKind; // only when role==="user"
  uuid: string;
  timestamp?: string;
  text?: string; // human/injected user text OR assistant visible text
  thinking?: string[]; // assistant reasoning (preserved, may be dropped on emit)
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolResults?: { id: string; name: string; output: string; isError: boolean }[];
}

function blockText(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => (b as AnthropicBlock).type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? (b as { text: string }).text : JSON.stringify(b)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * Convert a linearized chain into normalized turns:
 *  - drops metadata nodes,
 *  - re-merges same-message.id assistant blocks into one turn,
 *  - recovers toolName for each tool_result via a tool_use id→name map.
 */
export function normalize(chain: RawNode[]): NormalizedTurn[] {
  const idToName = new Map<string, string>();
  const out: NormalizedTurn[] = [];

  for (const n of chain) {
    if (!isConversational(n)) continue;

    if (n.type === "assistant") {
      const blocks = Array.isArray(n.message?.content) ? (n.message!.content as AnthropicBlock[]) : [];
      const thinking = blocks.filter((b) => b.type === "thinking").map((b) => (b as { thinking: string }).thinking);
      const text = blockText(n.message?.content);
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const tu = b as { id: string; name: string; input: unknown };
          idToName.set(tu.id, tu.name);
          return { id: tu.id, name: tu.name, input: tu.input };
        });

      const msgId = n.message?.id;
      const prev = out[out.length - 1];
      // Merge consecutive assistant lines that belong to the same underlying message.
      if (prev && prev.role === "assistant" && msgId && (prev as any)._msgId === msgId) {
        if (text) prev.text = [prev.text, text].filter(Boolean).join("\n");
        if (thinking.length) prev.thinking = [...(prev.thinking ?? []), ...thinking];
        if (toolCalls.length) prev.toolCalls = [...(prev.toolCalls ?? []), ...toolCalls];
        continue;
      }
      out.push({
        role: "assistant",
        uuid: n.uuid!,
        timestamp: n.timestamp,
        text: text || undefined,
        thinking: thinking.length ? thinking : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        ...(msgId ? { _msgId: msgId } : {}),
      } as NormalizedTurn);
      continue;
    }

    // role: "user"
    const kind = classifyUser(n);
    if (kind === "tool_result") {
      const blocks = n.message!.content as AnthropicBlock[];
      const toolResults = blocks
        .filter((b) => b.type === "tool_result")
        .map((b) => {
          const tr = b as { tool_use_id: string; content: unknown; is_error?: boolean };
          return {
            id: tr.tool_use_id,
            name: idToName.get(tr.tool_use_id) ?? "unknown_tool",
            output: stringifyToolResult(tr.content),
            isError: !!tr.is_error,
          };
        });
      out.push({ role: "tool", uuid: n.uuid!, timestamp: n.timestamp, toolResults });
    } else {
      let text = kind === "human" ? (n.message!.content as string) : blockText(n.message?.content);
      text = text.replace(/^user:\s*/, ""); // strip harness "user: " prefix if present
      out.push({ role: "user", userKind: kind, uuid: n.uuid!, timestamp: n.timestamp, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Emit AI-SDK v6 ModelMessage[]  (Anthropic blocks → {OpenAI|AI-SDK} shape)
// ---------------------------------------------------------------------------

export interface EmitOptions {
  includeThinking?: boolean; // default false — see class note (6)
  /**
   * Fold tool_use / tool_result into readable assistant TEXT instead of structured
   * AI-SDK tool parts. Use this when seeding a DIFFERENT model family than the one that
   * produced the transcript (e.g. replaying a Claude session's context into an OpenAI
   * agent-under-test): structured cross-model tool-call linkage trips provider-side
   * validation (400 "tool_call_ids did not have response messages"). This is the honest
   * Strategy-A "artificial context injection" emit. Default false = faithful structured.
   */
  flattenTools?: boolean;
}

const trunc = (s: string, n = 600) => (s.length <= n ? s : s.slice(0, n) + `…(+${s.length - n}ch)`);

export function toModelMessages(turns: NormalizedTurn[], opts: EmitOptions = {}): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      msgs.push({ role: "user", content: t.text ?? "" });
    } else if (t.role === "tool") {
      if (opts.flattenTools) {
        const text = (t.toolResults ?? [])
          .map((r) => `[tool ${r.name} ${r.isError ? "ERROR" : "→"}] ${trunc(r.output)}`)
          .join("\n");
        // fold into the preceding assistant turn if there is one, else stand alone
        const prev = msgs[msgs.length - 1];
        if (prev && prev.role === "assistant" && typeof prev.content === "string") {
          prev.content = [prev.content, text].filter(Boolean).join("\n");
        } else {
          msgs.push({ role: "assistant", content: text || " " });
        }
        continue;
      }
      msgs.push({
        role: "tool",
        content: (t.toolResults ?? []).map((r) => ({
          type: "tool-result" as const,
          toolCallId: r.id,
          toolName: r.name,
          output: { type: "text" as const, value: r.isError ? `ERROR: ${r.output}` : r.output },
        })),
      });
    } else if (opts.flattenTools) {
      const bits: string[] = [];
      if (opts.includeThinking && t.thinking?.length) bits.push(t.thinking.map((th) => `[thinking] ${th}`).join("\n"));
      if (t.text) bits.push(t.text);
      for (const tc of t.toolCalls ?? []) bits.push(`[called ${tc.name}] ${trunc(JSON.stringify(tc.input))}`);
      msgs.push({ role: "assistant", content: bits.join("\n") || " " });
    } else {
      // assistant: may carry text and/or tool-calls (and thinking, usually dropped)
      const parts: any[] = [];
      if (opts.includeThinking && t.thinking?.length) {
        parts.push({ type: "text", text: t.thinking.map((th) => `[thinking] ${th}`).join("\n") });
      }
      if (t.text) parts.push({ type: "text", text: t.text });
      for (const tc of t.toolCalls ?? []) {
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input: tc.input });
      }
      if (parts.length === 1 && parts[0].type === "text") {
        msgs.push({ role: "assistant", content: parts[0].text });
      } else if (parts.length === 0) {
        msgs.push({ role: "assistant", content: "" });
      } else {
        msgs.push({ role: "assistant", content: parts });
      }
    }
  }
  return msgs;
}
