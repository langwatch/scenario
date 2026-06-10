/**
 * AC-JS1' — Echo-safety for the free-running JS user simulator facing the
 * realtime adapter.
 *
 * LATENT BUG (issue #623): when a free-running `userSimulatorAgent` faces the
 * realtime agent adapter, the agent's voiced turn is surfaced as
 *   [{ type: "text", text: transcript }, { type: "file", mediaType: "audio/pcm16", ... }]
 * (see `ResponseFormatter.formatAudioResponse`). `messageRoleReversal` swaps
 * that assistant turn to a `user` turn but passes its content through UNCHANGED
 * — so the transcript text lands on the reversed `user` turn, the LLM reads it
 * as its own prior words, and parrots it back as the candidate's answer (echo).
 *
 * Python has `_strip_audio_content`, which — before role-reversal — reframes a
 * voiced agent turn's text as `[the agent said: <transcript>]` so the simulator
 * reads it as the OTHER party's utterance, not its own line. JS has no
 * equivalent. This test is the creds-free repro of that gap.
 *
 * Mock strategy (no live key):
 * - The assistant turn the simulator sees is built by the REAL
 *   `ResponseFormatter.formatAudioResponse(...)` — i.e. the exact realtime
 *   adapter wire shape, not a hand-rolled stand-in.
 * - `agent.invokeLLM` is stubbed to a PARROT that returns the text of the last
 *   user-role message it is handed. After reversal the agent's audio turn is the
 *   last `user` message; if its transcript flows through verbatim, the parrot
 *   echoes the agent's question back as the candidate answer.
 *
 * Two arms IN THE SAME TEST:
 *   - post-fix = drive the REAL `userSimulatorAgent.call(...)` (the production
 *     path the coder will fix). Today there is no reframe, so this currently
 *     behaves like the naive arm (echo) and the `< 0.8` assertion FAILS → RED.
 *   - naive   = feed the same realtime assistant turn through the production
 *     `messageRoleReversal` directly (verbatim pass-through, no reframe) and
 *     parrot the result. This is the red-capability control: echo IS present.
 *
 * Contract (mirrors the Python echo test):
 *   Q = the agent's spoken question (the surfaced transcript)
 *   U = the simulator's generated reply (candidate answer)
 *   post-fix:        jaccard(U, Q) <  0.8   (reframe breaks verbatim echo)
 *   naive (control): jaccard(U, Q) >= 0.8   (metric is red-capable at the JS layer)
 *   margin:          jaccard_naive - jaccard_postfix >= 0.3
 *
 * Until the reframe exists, post-fix == naive (both echo) → all three
 * assertions fail. The RED lands on the ECHO/Jaccard assertion, NOT a
 * compile/import error.
 */

import type { ModelMessage } from "ai";
import { describe, it, expect, vi } from "vitest";

import { userSimulatorAgent } from "../user-simulator-agent";
import { messageRoleReversal } from "../utils";
import type { InvokeLLMParams, InvokeLLMResult } from "../types";
import { ResponseFormatter } from "../realtime/response-formatter";
import type { AudioResponseEvent } from "../realtime/realtime-event-handler";
import { AgentRole } from "../../domain";
import type { AgentInput } from "../../domain";

// Mock getProjectConfig so no real model config / filesystem is needed and the
// stubbed invokeLLM is never bypassed (mirrors judge-agent.test.ts).
vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const QUESTION = "what was your role on the payments team";

/** Jaccard word overlap — mirrors the Python `jaccard` helper. */
function jaccard(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1.0;
  const intersection = new Set([...wa].filter((w) => wb.has(w)));
  const union = new Set([...wa, ...wb]);
  return intersection.size / union.size;
}

/**
 * Pull the plain-text of a message's content, whether it is a string or an
 * array of content parts. Mirrors how the simulator's prompt is read by an
 * LLM: text parts are concatenated; non-text parts (audio/file) contribute
 * nothing on their own.
 */
function contentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "type" in part) {
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Parrot LLM stub: returns the text of the LAST user-role message it is handed.
 *
 * After `messageRoleReversal` the agent's audio turn becomes a `user` message.
 * If its transcript flowed through verbatim, the last-user text IS the agent's
 * question Q — so the parrot echoes Q. With the reframe applied, the last-user
 * text is `[the agent said: Q]`, so the parrot returns that framing, not Q.
 */
function parrotInvokeLLM(params: InvokeLLMParams): Promise<InvokeLLMResult> {
  const messages = (params.messages ?? []) as ModelMessage[];
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserText = contentToText(messages[i]!.content);
      break;
    }
  }
  return Promise.resolve({
    text: lastUserText,
    content: [],
    toolCalls: [],
    toolResults: [],
  } as unknown as InvokeLLMResult);
}

/** A realtime agent turn as surfaced by the REAL response formatter. */
function realtimeAgentTurn(transcript: string = QUESTION): ModelMessage {
  const formatter = new ResponseFormatter();
  const audioEvent: AudioResponseEvent = {
    transcript,
    // Minimal silent PCM16 stand-in, base64 — the bytes are irrelevant to the
    // echo metric; only that an audio `file` part rides alongside the text part.
    audio: Buffer.from("\x00\x00".repeat(240), "binary").toString("base64"),
  };
  return formatter.formatAudioResponse(audioEvent) as unknown as ModelMessage;
}

/** AgentInput the free-running simulator consumes (it reads scenarioConfig + messages). */
function makeSimulatorInput(agentTurn: ModelMessage): AgentInput {
  return {
    threadId: "echo-safe-thread",
    messages: [agentTurn],
    newMessages: [agentTurn],
    requestedRole: AgentRole.USER,
    scenarioState: { currentTurn: 1 } as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "echo-safe",
      description:
        "Candidate answers an interviewer's opening question about their experience.",
    } as unknown as AgentInput["scenarioConfig"],
  } as AgentInput;
}

// ---------------------------------------------------------------------------
// AC-JS1' — main echo test (post-fix arm + naive red-capability control)
// ---------------------------------------------------------------------------

describe("realtime echo-safety (AC-JS1')", () => {
  it("free-running sim must NOT echo the realtime agent transcript back as its answer", async () => {
    const agentTurn = realtimeAgentTurn(QUESTION);

    // --- post-fix arm: drive the REAL production simulator path ---
    // This is the path the coder will fix (reframe inside `messageRoleReversal`
    // or a strip step ahead of it). Until then it echoes.
    const sim = userSimulatorAgent();
    sim.invokeLLM = parrotInvokeLLM;
    const postFixReply = await sim.call(makeSimulatorInput(agentTurn));
    const postFixAnswer = contentToText(postFixReply.content);
    const jPostFix = jaccard(postFixAnswer, QUESTION);

    // --- naive control arm: verbatim pass-through (no reframe) ---
    // Reproduces today's behaviour explicitly so the metric is provably
    // red-capable at the JS layer: the realtime turn goes straight through the
    // production reversal, and the parrot sees the agent's transcript verbatim.
    const naiveReversed = messageRoleReversal([
      { role: "system", content: "you are pretending to be a user" },
      { role: "assistant", content: "Hello, how can I help you today" },
      agentTurn,
    ]);
    const naiveResult = await parrotInvokeLLM({
      messages: naiveReversed,
    } as unknown as InvokeLLMParams);
    const naiveAnswer = naiveResult.text ?? "";
    const jNaive = jaccard(naiveAnswer, QUESTION);

    // Run-shape floor (AC-JS1'): the simulated exchange has >= 3 messages
    // (system + agent turn + simulator reply) and at least one user-role turn.
    const exchange: ModelMessage[] = [
      { role: "system", content: "you are pretending to be a user" },
      agentTurn,
      postFixReply,
    ];
    expect(exchange.length).toBeGreaterThanOrEqual(3);
    expect(exchange.some((m) => m.role === "user")).toBe(true);

    // Diagnostics (visible on failure).
    // eslint-disable-next-line no-console
    console.log(`[POST-FIX] Q=${JSON.stringify(QUESTION)}`);
    // eslint-disable-next-line no-console
    console.log(`[POST-FIX] U=${JSON.stringify(postFixAnswer)}`);
    // eslint-disable-next-line no-console
    console.log(`[POST-FIX] Jaccard=${jPostFix.toFixed(3)}`);
    // eslint-disable-next-line no-console
    console.log(`[NAIVE]    U=${JSON.stringify(naiveAnswer)}`);
    // eslint-disable-next-line no-console
    console.log(`[NAIVE]    Jaccard=${jNaive.toFixed(3)}`);

    // Naive control: the echo metric IS red-capable at the JS layer.
    expect(jNaive).toBeGreaterThanOrEqual(0.8);

    // Post-fix: the reframe must break the verbatim echo. RED until the coder
    // adds the reframe to the production simulator path.
    expect(jPostFix).toBeLessThan(0.8);

    // Margin floor: the reframe must move the metric by a real amount, not just
    // squeak under an absolute line.
    expect(jNaive - jPostFix).toBeGreaterThanOrEqual(0.3);
  });
});
