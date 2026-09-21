/**
 * #994 — a callee voice turn (e.g. Twilio, which has no native
 * `lastAgentTranscript`) must not reach LangWatch as audio-only when no
 * per-chunk transcript and no adapter-native transcript exist. This exercises
 * the third tier `attachAgentTurnTranscript` (adapter.runtime.ts) adds: an STT
 * fallback over the turn's own audio via the resolved `voice.stt` provider.
 *
 * Follows the #705 test's architecture (`voice-agent-transcript.test.ts`) for
 * the ScenarioExecution wiring, and the #734 test's STT-stub pattern
 * (`user-simulator-stt-fallback.test.ts`) for injecting a fake STTProvider via
 * the scenario config's `voice.stt` carrier. Offline — no network.
 */
import { describe, it, expect, vi } from "vitest";

import { ScenarioExecution } from "../../execution/scenario-execution";
import { agent } from "../../script";
import { AudioChunk } from "../audio-chunk";
import { extractAudio } from "../messages";
import type { STTProvider } from "../stt";
import { AudioUserSimulator } from "./fixtures/audio-user-simulator";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

describe("#994 — callee turn STT fallback for a missing native transcript", () => {
  it("attaches STT-derived text to a Twilio-shaped (no lastAgentTranscript) callee turn", async () => {
    const fakeStt: STTProvider = {
      transcribe: vi.fn().mockResolvedValue("hello from STT"),
    };
    // Base FakeVoiceAdapter — no `lastAgentTranscript` override, i.e. Twilio-shaped:
    // audio-only frames with no native transcript signal at all.
    const aut = new FakeVoiceAdapter({
      responses: [new AudioChunk({ data: new Uint8Array(400) })],
    });

    const execution = new ScenarioExecution(
      {
        name: "callee-stt-fallback",
        description: "a callee turn with no native transcript gets STT text",
        agents: [
          aut,
          new AudioUserSimulator(new AudioChunk({ data: new Uint8Array(200) })),
        ],
        voice: { stt: fakeStt },
      },
      [agent()],
      "batch-test",
    );

    await execution.execute();

    const agentMsg = execution.messages.find((m) => m.role === "assistant");
    expect(agentMsg, "no agent turn produced").toBeDefined();
    const chunk = extractAudio(agentMsg!);
    expect(chunk, "agent message had no audio part").not.toBeNull();
    expect(chunk!.transcript).toBe("hello from STT");
    expect((fakeStt.transcribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // No simple public accessor exists in this codebase to reach the recorded
    // VoiceRecording segment's transcript from this test without adding new
    // production API surface — skipped per the brief rather than inventing one.
  });

  it("degrades to audio-only when the STT fallback fails, and the run still completes", async () => {
    const fakeStt: STTProvider = {
      transcribe: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const aut = new FakeVoiceAdapter({
      responses: [new AudioChunk({ data: new Uint8Array(400) })],
    });

    const execution = new ScenarioExecution(
      {
        name: "callee-stt-fallback-failure",
        description: "an STT failure must not fail the run",
        agents: [
          aut,
          new AudioUserSimulator(new AudioChunk({ data: new Uint8Array(200) })),
        ],
        voice: { stt: fakeStt },
      },
      [agent()],
      "batch-test",
    );

    await expect(execution.execute()).resolves.not.toThrow();

    const agentMsg = execution.messages.find((m) => m.role === "assistant");
    expect(agentMsg, "no agent turn produced").toBeDefined();
    const chunk = extractAudio(agentMsg!);
    expect(chunk, "agent message had no audio part").not.toBeNull();
    expect(chunk!.transcript ?? "").toBe("");
    // Called at least once by the adapter-runtime fallback; the pre-existing
    // scenario-execution STT back-fill may also retry on the still-unset
    // transcript and fail again — exact count isn't the point of this test.
    expect(fakeStt.transcribe).toHaveBeenCalled();
  });
});
