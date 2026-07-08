/**
 * #734 (AC2) — user-simulator STT fallback for a suppressed agent transcript.
 *
 * The grace-wait (AC1) is the primary fix, but if hosted ElevenLabs NEVER sends
 * `agent_response` for a turn, the agent message still reaches the simulator as
 * AUDIO with no text sibling. Without a fallback, `stripAudioContent` collapses
 * it to a bare `[audio message]` and the text-only LLM fabricates a reply.
 *
 * This test forces that suppression: an assistant-role audio message carrying NO
 * transcript, plus a stub STT provider resolved off `scenarioConfig.voice.stt`
 * (the SAME per-run carrier the judge reads). It asserts the simulator's LLM
 * input carries the STT-derived text — proving the simulator now transcribes the
 * turn before stripping audio, mirroring the judge's pre-pass via the shared
 * `transcribeAudioMessages` helper (no duplicated STT plumbing).
 */
import { describe, it, expect, vi } from "vitest";

import type { AgentInput } from "../../domain";
import { AudioChunk } from "../../voice/audio-chunk";
import { createAudioMessage } from "../../voice/messages";
import type { STTProvider } from "../../voice/stt";
import { userSimulatorAgent, type UserSimulatorAgentConfig } from "../user-simulator-agent";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

/** A 4-byte PCM16 audio chunk with NO transcript — models a suppressed agent_response. */
function audioNoTranscript(): AudioChunk {
  return new AudioChunk({ data: new Uint8Array([1, 2, 3, 4]) });
}

/** Build an AgentInput whose voice config carries a stub STT provider. */
function makeInput(messages: unknown[], stt: STTProvider): AgentInput {
  return {
    threadId: "t-734-stt",
    messages: messages as AgentInput["messages"],
    newMessages: [],
    requestedRole: "User" as AgentInput["requestedRole"],
    scenarioConfig: {
      name: "test",
      description: "A test scenario description",
      voice: { stt },
    } as unknown as AgentInput["scenarioConfig"],
    scenarioState: {} as AgentInput["scenarioState"],
  };
}

/** Wire a spy LLM that records the messages it was called with and returns text. */
function captureLlm(sim: ReturnType<typeof userSimulatorAgent>) {
  const seen: { messages: Array<{ role: string; content: unknown }> } = { messages: [] };
  (sim as unknown as {
    invokeLLM: (p: { messages: Array<{ role: string; content: unknown }> }) => Promise<{
      text: string;
      toolCalls: [];
      steps: [];
    }>;
  }).invokeLLM = async ({ messages }) => {
    seen.messages = messages;
    return { text: "ok", toolCalls: [], steps: [] };
  };
  return seen;
}

/** Flatten a captured message's content to a searchable string. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? ((p as { text: string }).text)
          : "",
      )
      .join(" ");
  }
  return "";
}

describe("#734 AC2 — user-simulator STT fallback for a suppressed agent transcript", () => {
  it("transcribes an audio-only agent turn so the LLM sees real words, not [audio message]", async () => {
    const stt: STTProvider = {
      transcribe: vi.fn(async () => "we have the blue and the red option"),
    };
    const sim = userSimulatorAgent({ model: "openai/gpt-4.1-mini" } as UserSimulatorAgentConfig);
    const seen = captureLlm(sim);

    // An audio-only agent turn (assistant role, no transcript) — the suppressed
    // agent_response case. This is what reaches the simulator after the grace-wait
    // window elapses with no transcript.
    const agentTurn = createAudioMessage(audioNoTranscript(), "assistant");

    await sim.call(makeInput([agentTurn], stt));

    expect((stt.transcribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // The transcribed words must appear in what the LLM saw — reframed as the
    // agent's utterance ("[the agent said: …]") by stripAudioContent's echo-safety.
    const allContent = seen.messages.map((m) => contentText(m.content)).join(" || ");
    expect(allContent).toContain("we have the blue and the red option");
    // And the bare placeholder must NOT be what the LLM received for that turn.
    expect(allContent).not.toContain("[audio message]");
  });

  it("caches the fallback transcript: two calls over the SAME audio-only turn run STT exactly once (#735 P2)", async () => {
    // #735 P2: `call()` re-runs the STT pre-pass over the WHOLE history on every
    // proceed() turn. A dropped agent_response leaves an audio-only turn sitting
    // in history; without a per-instance cache it would be re-transcribed on
    // every subsequent turn (O(turns^2) STT calls). One simulator instance must
    // transcribe a given audio chunk at most once.
    const stt: STTProvider = {
      transcribe: vi.fn(async () => "we have the blue and the red option"),
    };
    const sim = userSimulatorAgent({ model: "openai/gpt-4.1-mini" } as UserSimulatorAgentConfig);
    captureLlm(sim);

    // The SAME suppressed audio-only agent turn, still in history across turns.
    const agentTurn = createAudioMessage(audioNoTranscript(), "assistant");

    // Two simulator calls over that same audio-only turn (models proceed() turns
    // N and N+1 where the dropped-transcript audio remains in the history).
    await sim.call(makeInput([agentTurn], stt));
    await sim.call(makeInput([agentTurn], stt));

    // STT ran ONCE, not once per call — the second call reused the cached transcript.
    expect((stt.transcribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("does NOT run STT when the agent turn already carries its transcript (no added cost)", async () => {
    const stt: STTProvider = { transcribe: vi.fn(async () => "should not be called") };
    const sim = userSimulatorAgent({ model: "openai/gpt-4.1-mini" } as UserSimulatorAgentConfig);
    captureLlm(sim);

    // Agent turn WITH a transcript (the grace-wait won the race) — the happy path.
    const withTranscript = createAudioMessage(
      new AudioChunk({ data: new Uint8Array([1, 2, 3, 4]), transcript: "here is your balance" }),
      "assistant",
    );

    await sim.call(makeInput([withTranscript], stt));

    // Fast path: no audio-without-transcript turn exists, so no provider is used.
    expect((stt.transcribe as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
