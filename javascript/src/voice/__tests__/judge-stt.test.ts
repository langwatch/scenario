/**
 * Judge STT pre-pass tests (EDR §3.3 / §7.7, issue #372 Tier C).
 *
 * Covers the net-new `prepareJudgeInput` seam directly (unit) AND its wiring
 * into `JudgeAgent.call()` (integration with a stubbed STT + stubbed LLM —
 * no network, no real keys): the judge's transcript view contains the spoken
 * words, not a base64 byte-marker. There is NO "judge requests transcript"
 * tool (§7.3) — STT is automatic and upstream.
 */

import type { ModelMessage } from "ai";
import { describe, it, expect, vi } from "vitest";

import { AudioChunk } from "../audio-chunk";
import { createAudioMessage } from "../messages";
import { prepareJudgeInput } from "../judge-stt";
import type { STTProvider } from "../stt";
import { judgeAgent } from "../../agents/judge/judge-agent";
import type { JudgeAgentConfig } from "../../agents/judge/judge-agent";
import {
  AgentRole,
  type AgentInput,
} from "../../domain";

// JudgeAgent.call() reads project config from disk; mock it so the test is
// hermetic (matches judge-agent.test.ts).
vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4o-mini", temperature: 0 },
  }),
}));

function tone(transcript?: string): AudioChunk {
  const data = new Uint8Array(2400 * 2); // 0.1s @ 24kHz mono
  return new AudioChunk({ data, transcript });
}

function sttReturning(text: string): STTProvider & { calls: number } {
  let calls = 0;
  return {
    async transcribe(_audio: AudioChunk): Promise<string> {
      calls += 1;
      return text;
    },
    get calls() {
      return calls;
    },
  } as STTProvider & { calls: number };
}

describe("prepareJudgeInput (judge STT pre-pass)", () => {
  it("transcribes an audio message lacking a transcript to a text part (text-only by default)", async () => {
    const stt = sttReturning("I need help with my bill");
    const audioMsg = createAudioMessage(tone(), "user") as ModelMessage;

    const { messages } = await prepareJudgeInput({
      messages: [audioMsg],
      stt,
    });

    expect(stt.calls).toBe(1);
    const content = (messages[0] as { content: unknown[] }).content;
    // A text part with the transcript was prepended.
    const textParts = content.filter(
      (p) => (p as { type?: string }).type === "text",
    );
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe(
      "I need help with my bill",
    );
    // The audio bytes were dropped (includeAudio default false).
    const filePart = content.find(
      (p) => (p as { type?: string }).type === "file",
    );
    expect(filePart).toBeUndefined();
  });

  it("keeps the audio part when includeAudio is true (multimodal model)", async () => {
    const stt = sttReturning("hello");
    const audioMsg = createAudioMessage(tone(), "user") as ModelMessage;

    const { messages } = await prepareJudgeInput({
      messages: [audioMsg],
      stt,
      options: { includeAudio: true },
    });

    const content = (messages[0] as { content: unknown[] }).content;
    const filePart = content.find(
      (p) => (p as { type?: string }).type === "file",
    );
    expect(filePart).toBeDefined();
  });

  it("reuses an existing transcript text part without calling STT", async () => {
    const stt = sttReturning("SHOULD NOT BE USED");
    // createAudioMessage attaches a leading text part when the chunk has a transcript.
    const audioMsg = createAudioMessage(
      tone("already transcribed"),
      "user",
    ) as ModelMessage;

    const { messages } = await prepareJudgeInput({
      messages: [audioMsg],
      stt,
    });

    expect(stt.calls).toBe(0);
    const content = (messages[0] as { content: unknown[] }).content;
    const textParts = content.filter(
      (p) => (p as { type?: string }).type === "text",
    );
    expect((textParts[0] as { text: string }).text).toBe("already transcribed");
  });

  it("degrades gracefully when STT throws (drops audio, logs, continues)", async () => {
    const failing: STTProvider = {
      async transcribe() {
        throw new Error("stt boom");
      },
    };
    const warn = vi.fn();
    const audioMsg = createAudioMessage(tone(), "user") as ModelMessage;

    const { messages } = await prepareJudgeInput({
      messages: [audioMsg],
      stt: failing,
      logWarn: warn,
    });

    expect(warn).toHaveBeenCalledOnce();
    // Audio dropped, no text added (best-effort) — message survives.
    const content = (messages[0] as { content: unknown[] }).content;
    expect(
      content.find((p) => (p as { type?: string }).type === "file"),
    ).toBeUndefined();
  });

  it("passes non-audio messages through untouched", async () => {
    const stt = sttReturning("x");
    const textMsg: ModelMessage = { role: "user", content: "plain text" };

    const { messages } = await prepareJudgeInput({
      messages: [textMsg],
      stt,
    });

    expect(stt.calls).toBe(0);
    expect(messages[0]).toBe(textMsg); // same reference — untouched
  });
});

describe("JudgeAgent.call() wires the STT pre-pass (EDR §3.3)", () => {
  function judgeInputWithAudio(stt: STTProvider): AgentInput {
    const audioMsg = createAudioMessage(tone(), "user") as ModelMessage;
    return {
      threadId: "judge-stt-thread",
      messages: [audioMsg],
      newMessages: [audioMsg],
      requestedRole: AgentRole.JUDGE,
      judgmentRequest: { criteria: ["Agent helps the caller"] },
      scenarioState: { currentTurn: 1 },
      scenarioConfig: {
        name: "voice judge",
        description: "judge sees transcribed audio",
        maxTurns: 5,
        voice: { stt },
      },
    } as unknown as AgentInput;
  }

  it("the judge's transcript view contains transcribed text, not a byte-marker", async () => {
    const stt = sttReturning("Yeah I got charged twice");
    const config: JudgeAgentConfig = { criteria: ["Agent helps the caller"] };
    const agent = judgeAgent(config);

    let userContent = "";
    agent.invokeLLM = async (params) => {
      // The judge embeds the transcript in the second (user) message.
      const userMsg = (params.messages ?? []).find((m) => m.role === "user");
      userContent =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : JSON.stringify(userMsg?.content);
      return {
        text: "",
        content: [],
        toolCalls: [
          {
            toolName: "finish_test",
            input: {
              criteria: { agent_helps_the_caller: "true" },
              reasoning: "ok",
              verdict: "success",
            },
            type: "tool-call" as const,
            toolCallId: "tc-1",
          },
        ],
        toolResults: [],
      } as never;
    };

    await agent.call(judgeInputWithAudio(stt));

    expect(stt.calls).toBe(1);
    expect(userContent).toContain("Yeah I got charged twice");
    // No raw base64 audio data leaked into the transcript.
    expect(userContent).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  });
});
