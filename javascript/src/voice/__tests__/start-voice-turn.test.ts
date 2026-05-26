/**
 * startVoiceTurn / VoiceTurnHandle bridge tests (issue #372 Tier C, Gap #8).
 *
 * The non-blocking primitive behind `agent({ wait: false })`: start the
 * agent's recv loop without awaiting, inject a mid-turn barge-in, then finish
 * to merge + record. Offline (FakeVoiceAdapter) — no network.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  type AgentInput,
} from "../../domain";
import { AudioChunk } from "../audio-chunk";
import { createAudioMessage, extractAudio } from "../messages";
import { startVoiceTurn } from "../adapter.runtime";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

function tone(transcript?: string): AudioChunk {
  const data = new Uint8Array(2400 * 2); // 0.1s @ 24kHz mono
  return new AudioChunk({ data, transcript });
}

function inputWithUserAudio(chunk: AudioChunk): AgentInput {
  return {
    threadId: "svt-thread",
    messages: [],
    newMessages: [createAudioMessage(chunk, "user") as never],
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "t",
      description: "d",
    } as AgentInput["scenarioConfig"],
  } as AgentInput;
}

describe("startVoiceTurn / VoiceTurnHandle", () => {
  it("returns a handle with injectAudio + finish", () => {
    const adapter = new FakeVoiceAdapter({
      responses: [tone("agent response")],
    });
    const handle = startVoiceTurn(adapter, inputWithUserAudio(tone("hi")));
    expect(typeof handle.injectAudio).toBe("function");
    expect(typeof handle.finish).toBe("function");
  });

  it("finish() returns the merged assistant audio message", async () => {
    const adapter = new FakeVoiceAdapter({
      responses: [tone("agent says hello")],
    });
    const handle = startVoiceTurn(adapter, inputWithUserAudio(tone("hi")));
    const result = await handle.finish();

    const chunk = extractAudio(result);
    expect(chunk).not.toBeNull();
    // The agent's audio response is carried in the assistant message.
    expect((result as { role: string }).role).toBe("assistant");
  });

  it("injectAudio() sends a mid-turn barge-in to the adapter", async () => {
    const adapter = new FakeVoiceAdapter({
      responses: [tone("agent talking")],
    });
    const handle = startVoiceTurn(adapter, inputWithUserAudio(tone("first")));

    const bargeIn = tone("wait, no!");
    await handle.injectAudio(bargeIn);
    await handle.finish();

    // The barge-in audio reached the adapter's send queue (alongside the
    // initial user audio).
    expect(adapter.sentAudio.length).toBeGreaterThanOrEqual(2);
    const transcripts = adapter.sentAudio.map((c) => c.transcript);
    expect(transcripts).toContain("wait, no!");
  });

  it("finish() is idempotent — same settled result on repeat calls", async () => {
    const adapter = new FakeVoiceAdapter({ responses: [tone("once")] });
    const handle = startVoiceTurn(adapter, inputWithUserAudio(tone("hi")));
    const a = await handle.finish();
    const b = await handle.finish();
    expect(a).toBe(b);
  });
});
