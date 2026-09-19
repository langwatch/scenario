/**
 * #779 — `fromTranscript()` builder facade (Strategy B — adapter-specific, JSONL-sourced).
 *
 * One call: raw CC JSONL path → a seed you can drop straight into a Scenario `script`.
 * It deliberately has NO dependency on the scenario SDK
 * (the seed step is just `(state) => state.addMessage(...)`), so the reader/converter
 * stay unit-testable without spinning up a run.
 *
 * The seed step is the DoD-4 fix: it pushes the ENTIRE captured history via the
 * turn-free `state.addMessage()` side-door, so a 20- or 200-message transcript never
 * consumes the shared `maxTurns` budget (unlike message()/user()/agent() steps, which
 * each cost a turn — verified in scenario-execution.ts:scriptCallAgent→newTurn).
 */
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import {
  parseSessionFile,
  linearize,
  normalize,
  toModelMessages,
  type NormalizedTurn,
} from "./cc-transcript";

export type ForkAt =
  | { uuid: string }
  | { index: number } // fork BEFORE this normalized-turn index
  | { beforeLastAssistant: true }; // fork right before the final assistant reply (default)

export interface FromTranscriptOptions {
  forkAt?: ForkAt;
  includeThinking?: boolean;
  /** Fold tool I/O into assistant text (robust cross-model seed — see cc-transcript EmitOptions). */
  flattenTools?: boolean;
  /** Drop any seeded message whose text matches — used to reproduce an "absent config/memory" failure. */
  dropMatching?: RegExp;
}

export interface SeededScenario {
  seedMessages: ModelMessage[];
  /** DoD-4 side-door: bulk-seed with zero turn-budget cost. */
  seedStep: (state: { addMessage: (m: ModelMessage) => void }) => void;
  lastHumanText?: string;
  /** The real assistant turn we forked out (what the live agent must now re-produce). */
  originalNextText?: string;
  turns: NormalizedTurn[];
  stats: {
    parsedNodes: number;
    chainLength: number;
    normalizedTurns: number;
    seededMessages: number;
    humanTurns: number;
    injectedTurns: number;
    toolResultTurns: number;
    assistantTurns: number;
    forkTurnIndex: number;
    prunedOrphanToolParts: number;
    /** Messages removed by `dropMatching` (used to reproduce an "absent config/memory" failure). */
    droppedByMatch: number;
  };
}

function forkIndex(turns: NormalizedTurn[], forkAt: ForkAt | undefined): number {
  if (forkAt && "uuid" in forkAt) {
    // match against ALL source uuids folded into a turn, so a uuid pointing at a merged-away
    // (non-first) line of a same-message.id assistant still resolves to its turn.
    const i = turns.findIndex((t) => t.uuids.includes(forkAt.uuid));
    if (i < 0) throw new Error(`forkAt uuid ${forkAt.uuid} not found in transcript`);
    return i;
  }
  if (forkAt && "index" in forkAt) {
    const idx = forkAt.index;
    if (!Number.isInteger(idx) || idx < 0 || idx > turns.length) {
      throw new Error(`forkAt index ${idx} out of range [0, ${turns.length}]`);
    }
    return idx;
  }
  // default: beforeLastAssistant — the last assistant turn is the "next turn" the live agent replaces
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return i;
  }
  return turns.length; // no assistant turn → seed everything
}

/** Visible text of a ModelMessage — what a human wrote/read, incl. tool inputs/outputs — for
 *  dropMatching to test against (NOT JSON.stringify, whose escaping breaks anchors/special chars). */
function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as Array<TextPart | ToolCallPart | ToolResultPart>)
    .map((p) => {
      if (p.type === "text") return p.text ?? "";
      if (p.type === "tool-call") return JSON.stringify(p.input ?? {});
      if (p.type === "tool-result") {
        // `output` is a discriminated union; only text/json members carry `value`.
        const value = "value" in p.output ? p.output.value : undefined;
        return typeof value === "string" ? value : JSON.stringify(p.output);
      }
      return "";
    })
    .join("\n");
}

/** Remove tool parts left dangling after a drop/fork: a tool-result whose tool-call was removed,
 *  or a tool-call whose result was removed. Otherwise the provider rejects the message list
 *  (400: tool result with no matching call). No-op for the flattened (string-content) seed. */
function pruneOrphanToolParts(msgs: ModelMessage[]): { messages: ModelMessage[]; pruned: number } {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const p of m.content as Array<TextPart | ToolCallPart | ToolResultPart>) {
        if (p.type === "tool-call") callIds.add(p.toolCallId);
        if (p.type === "tool-result") resultIds.add(p.toolCallId);
      }
    }
  }
  let pruned = 0;
  const out: ModelMessage[] = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const content = m.content as Array<TextPart | ToolCallPart | ToolResultPart>;
    const kept = content.filter((p) => {
      if (p.type === "tool-call" && !resultIds.has(p.toolCallId)) return false;
      if (p.type === "tool-result" && !callIds.has(p.toolCallId)) return false;
      return true;
    });
    pruned += content.length - kept.length;
    if (kept.length === 0) continue; // drop a now-empty message
    out.push({ ...m, content: kept } as ModelMessage);
  }
  return { messages: out, pruned };
}

export function fromTranscript(path: string, opts: FromTranscriptOptions = {}): SeededScenario {
  const raw = parseSessionFile(path);
  const chain = linearize(raw, opts.forkAt && "uuid" in opts.forkAt ? opts.forkAt.uuid : undefined);
  const turns = normalize(chain);

  const fi = forkIndex(turns, opts.forkAt);
  const seededTurns = turns.slice(0, fi);
  const originalNext = turns[fi];

  let seedMessages = toModelMessages(seededTurns, {
    includeThinking: opts.includeThinking,
    flattenTools: opts.flattenTools,
  });

  let dropped = 0;
  if (opts.dropMatching) {
    // Strip g/y flags: RegExp.test is stateful for those (lastIndex carries across .filter calls
    // and silently skips matches). Test against visible text, not JSON.stringify.
    const re = new RegExp(opts.dropMatching.source, opts.dropMatching.flags.replace(/[gy]/g, ""));
    const before = seedMessages.length;
    seedMessages = seedMessages.filter((m) => !re.test(messageText(m)));
    dropped = before - seedMessages.length;
  }

  // A drop or a mid-exchange fork can orphan a tool-call/tool-result across the pair; prune so the
  // seed is a provider-valid message list. No-op on the flattened (string-content) seed.
  const { messages: prunedMessages, pruned } = pruneOrphanToolParts(seedMessages);
  seedMessages = prunedMessages;

  const lastHuman = [...seededTurns].reverse().find((t) => t.role === "user" && t.userKind === "human");

  return {
    seedMessages,
    seedStep: (state) => {
      for (const m of seedMessages) state.addMessage(m);
    },
    lastHumanText: lastHuman?.text,
    originalNextText: originalNext?.text,
    turns,
    stats: {
      parsedNodes: raw.length,
      chainLength: chain.length,
      normalizedTurns: turns.length,
      seededMessages: seedMessages.length,
      humanTurns: turns.filter((t) => t.role === "user" && t.userKind === "human").length,
      injectedTurns: turns.filter((t) => t.role === "user" && t.userKind === "injected").length,
      toolResultTurns: turns.filter((t) => t.role === "tool").length,
      assistantTurns: turns.filter((t) => t.role === "assistant").length,
      forkTurnIndex: fi,
      prunedOrphanToolParts: pruned,
      droppedByMatch: dropped,
    },
  };
}
