/**
 * SPIKE #779 — `fromTranscript()` builder facade (the Strategy-B shape).
 *
 * One call: raw CC JSONL path → a seed you can drop straight into a Scenario `script`.
 * This is the productizable seam. It deliberately has NO dependency on the scenario SDK
 * (the seed step is just `(state) => state.addMessage(...)`), so the reader/converter
 * stay unit-testable without spinning up a run.
 *
 * The seed step is the DoD-4 fix: it pushes the ENTIRE captured history via the
 * turn-free `state.addMessage()` side-door, so a 20- or 200-message transcript never
 * consumes the shared `maxTurns` budget (unlike message()/user()/agent() steps, which
 * each cost a turn — verified in scenario-execution.ts:scriptCallAgent→newTurn).
 */
import type { ModelMessage } from "ai";
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
  droppedBySafetyFilter: number;
  stats: {
    rawLines: number;
    chainLength: number;
    normalizedTurns: number;
    seededMessages: number;
    humanTurns: number;
    injectedTurns: number;
    toolResultTurns: number;
    assistantTurns: number;
    forkTurnIndex: number;
  };
}

function forkIndex(turns: NormalizedTurn[], forkAt: ForkAt | undefined): number {
  if (forkAt && "uuid" in forkAt) {
    const i = turns.findIndex((t) => t.uuid === forkAt.uuid);
    if (i < 0) throw new Error(`forkAt uuid ${forkAt.uuid} not found in transcript`);
    return i;
  }
  if (forkAt && "index" in forkAt) return forkAt.index;
  // default: beforeLastAssistant — the last assistant turn is the "next turn" the live agent replaces
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return i;
  }
  return turns.length; // no assistant turn → seed everything
}

export function buildScenarioFromTranscript(path: string, opts: FromTranscriptOptions = {}): SeededScenario {
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
    const re = opts.dropMatching;
    const before = seedMessages.length;
    seedMessages = seedMessages.filter((m) => !re.test(JSON.stringify(m.content)));
    dropped = before - seedMessages.length;
  }

  const lastHuman = [...seededTurns].reverse().find((t) => t.role === "user" && t.userKind === "human");

  return {
    seedMessages,
    seedStep: (state) => {
      for (const m of seedMessages) state.addMessage(m);
    },
    lastHumanText: lastHuman?.text,
    originalNextText: originalNext?.text,
    turns,
    droppedBySafetyFilter: dropped,
    stats: {
      rawLines: raw.length,
      chainLength: chain.length,
      normalizedTurns: turns.length,
      seededMessages: seedMessages.length,
      humanTurns: turns.filter((t) => t.role === "user" && t.userKind === "human").length,
      injectedTurns: turns.filter((t) => t.role === "user" && t.userKind === "injected").length,
      toolResultTurns: turns.filter((t) => t.role === "tool").length,
      assistantTurns: turns.filter((t) => t.role === "assistant").length,
      forkTurnIndex: fi,
    },
  };
}
