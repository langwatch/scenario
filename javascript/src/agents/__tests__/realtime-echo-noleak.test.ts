/**
 * AC-JS2' (no-leak) + AC-JS7 (scenario-rerun arm) — the echo reframe for issue
 * #623 must live ONLY in the copy fed to the LLM, never in the persisted /
 * caller-visible conversation.
 *
 * The fix (`user-simulator-agent.ts:stripAudioContent`) reframes a voiced agent
 * turn's transcript as `[the agent said: <transcript>]` so the role-reversed
 * simulator reads it as the OTHER party's line, not its own (breaking the echo
 * — locked by AC-JS1' in `realtime-echo-safe.test.ts`). This file locks the
 * COMPLEMENT: the reframe is simulator-view-only.
 *
 *  - AC-JS2'(a): the persisted assistant turn is UNCHANGED — its text part is
 *    the RAW `response.transcript` verbatim, with NO `[the agent said:` wrapper.
 *    (`stripAudioContent` maps to a NEW array via spread; the input objects are
 *    never mutated. This test locks that against future refactors.)
 *  - AC-JS2'(b): the wrapper `[the agent said:` IS present in the messages the
 *    simulator actually hands to `invokeLLM` — captured via a spy stub.
 *  - AC-JS7 (scenario-rerun arm): re-run the same free-running echo path with an
 *    EMPTY transcript. The reframe is a no-op (no text part to wrap → no
 *    `[the agent said:` injected), the candidate answer is unaffected (the
 *    parrot cannot echo a transcript that was never surfaced), and the run does
 *    not error.
 *
 * Mock strategy mirrors AC-JS1' (creds-free):
 *  - the agent turn is built by the REAL `ResponseFormatter.formatAudioResponse`
 *    (exact realtime wire shape);
 *  - `invokeLLM` is a spy that BOTH records the messages it received AND parrots
 *    the last user-role message's text (so an un-reframed transcript would echo).
 */

import type { ModelMessage } from "ai";
import { describe, it, expect, vi } from "vitest";

import { userSimulatorAgent } from "../user-simulator-agent";
import type { InvokeLLMParams, InvokeLLMResult } from "../types";
import { ResponseFormatter } from "../realtime/response-formatter";
import type { AudioResponseEvent } from "../realtime/realtime-event-handler";
import { AgentRole } from "../../domain";
import type { AgentInput } from "../../domain";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

const QUESTION = "what was your role on the payments team";
const REFRAME_PREFIX = "[the agent said:";

/** Plain-text of a message's content (string or content-part array). */
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

/** The raw `text` of the first text part of an assistant message. */
function firstTextPart(msg: ModelMessage): string | undefined {
  const content = msg.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part?.type === "text" && typeof part.text === "string") return part.text;
  }
  return undefined;
}

/** A realtime agent turn as surfaced by the REAL response formatter. */
function realtimeAgentTurn(transcript: string): ModelMessage {
  const audioEvent: AudioResponseEvent = {
    transcript,
    audio: Buffer.from("\x00\x00".repeat(240), "binary").toString("base64"),
  };
  return new ResponseFormatter().formatAudioResponse(
    audioEvent,
  ) as unknown as ModelMessage;
}

function makeSimulatorInput(agentTurn: ModelMessage): AgentInput {
  return {
    threadId: "echo-noleak-thread",
    messages: [agentTurn],
    newMessages: [agentTurn],
    requestedRole: AgentRole.USER,
    scenarioState: { currentTurn: 1 } as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "echo-noleak",
      description:
        "Candidate answers an interviewer's opening question about their experience.",
    } as unknown as AgentInput["scenarioConfig"],
  } as AgentInput;
}

/**
 * Spy invokeLLM: records every `messages` array it is handed, then parrots the
 * LAST user-role message's text (the echo-prone path — an un-reframed transcript
 * lands here verbatim and would be echoed back).
 */
function makeSpyParrot() {
  const seen: ModelMessage[][] = [];
  const fn = (params: InvokeLLMParams): Promise<InvokeLLMResult> => {
    const messages = (params.messages ?? []) as ModelMessage[];
    seen.push(messages);
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
  };
  return { fn, seen };
}

describe("realtime echo reframe is simulator-view-only (AC-JS2')", () => {
  it("persists the RAW transcript (no wrapper) while the LLM-input copy carries the reframe", async () => {
    const agentTurn = realtimeAgentTurn(QUESTION);

    // Snapshot the persisted turn's text part BEFORE the sim runs.
    const persistedTextBefore = firstTextPart(agentTurn);
    expect(persistedTextBefore).toBe(QUESTION);

    const input = makeSimulatorInput(agentTurn);
    const sim = userSimulatorAgent();
    const spy = makeSpyParrot();
    sim.invokeLLM = spy.fn;

    const reply = await sim.call(input);

    // --- AC-JS2'(a): the PERSISTED assistant turn is unchanged ---------------
    // The fix maps to a NEW array (spread), so neither the agentTurn object nor
    // the caller's `input.messages` is mutated: its text part is still the RAW
    // transcript, with NO `[the agent said:` wrapper.
    const persistedTextAfter = firstTextPart(agentTurn);
    expect(persistedTextAfter).toBe(QUESTION);
    expect(persistedTextAfter).not.toContain(REFRAME_PREFIX);
    // Same object identity preserved in the caller's message history.
    expect(input.messages[0]).toBe(agentTurn);
    expect(firstTextPart(input.messages[0]!)).toBe(QUESTION);

    // --- AC-JS2'(b): the LLM-input copy DOES carry the reframe ---------------
    expect(spy.seen.length).toBeGreaterThanOrEqual(1);
    const llmInput = spy.seen[0]!;
    const reframedTurn = llmInput.find(
      (m) =>
        typeof m.content === "string" && m.content.includes(REFRAME_PREFIX),
    );
    expect(reframedTurn).toBeDefined();
    expect(reframedTurn!.content).toContain(QUESTION); // wraps, not drops, the text

    // The reframe must NOT have leaked into the persisted message history.
    const persistedHasWrapper = input.messages.some(
      (m) => contentToText(m.content).includes(REFRAME_PREFIX),
    );
    expect(persistedHasWrapper).toBe(false);

    // Run-shape: the simulated exchange has the agent turn + a non-empty reply.
    const exchange: ModelMessage[] = [agentTurn, reply];
    expect(exchange.length).toBeGreaterThanOrEqual(2);
    expect(contentToText(reply.content).length).toBeGreaterThan(0);
  });
});

describe("echo reframe is a no-op for a degraded/empty transcript (AC-JS7, scenario-rerun arm)", () => {
  it("empty-transcript agent turn → no reframe injected, candidate answer unaffected, no error", async () => {
    // With the AC-JS7 formatter guard, an empty transcript surfaces ONLY the
    // audio file part (no text part) — so the simulator has no transcript text
    // to reframe and none to echo.
    const agentTurn = realtimeAgentTurn("");
    // Sanity: the degraded turn carries no surfaced transcript text.
    expect(firstTextPart(agentTurn)).toBeUndefined();

    const input = makeSimulatorInput(agentTurn);
    const sim = userSimulatorAgent();
    const spy = makeSpyParrot();
    sim.invokeLLM = spy.fn;

    const reply = await sim.call(input); // must not throw

    // No `[the agent said:` wrapper anywhere in the LLM-input copy: there was
    // no transcript text to wrap, so the reframe is a no-op.
    const llmInput = spy.seen[0]!;
    const anyReframe = llmInput.some(
      (m) => typeof m.content === "string" && m.content.includes(REFRAME_PREFIX),
    );
    expect(anyReframe).toBe(false);

    // The candidate answer is unaffected by the (absent) transcript: the parrot
    // sees the audio placeholder, never the verbatim question, so it cannot echo
    // QUESTION (which was never surfaced for this empty-transcript turn).
    const answer = contentToText(reply.content);
    expect(answer).not.toContain("payments team");

    // Run-shape: a reply was produced for the rerun.
    expect(answer.length).toBeGreaterThan(0);
  });
});
