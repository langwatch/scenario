/**
 * #705 follow-up — a VOICE agent-under-test's turn must carry its native
 * transcript into the conversation message (and thus the LangWatch snapshot +
 * recording), not just audio.
 *
 * REGRESSION: the rewritten ElevenLabs adapter captured the agent's text on
 * `lastAgentTranscript` (from the `agent_response` event) but `onAgentAudio`
 * built the returned AudioChunk from PCM ONLY — so every agent turn reached
 * LangWatch as audio with NO transcript ("missing AUT transcripts", observed
 * live by Drew). The fix attaches the adapter's `lastAgentTranscript` to the
 * merged turn chunk in `defaultVoiceCall` when the chunk carries none.
 *
 * This guards the wiring adapter-agnostically: any VoiceAgentAdapter exposing a
 * non-empty `lastAgentTranscript` for the turn gets it onto the assistant
 * message. Offline — no network.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";
import { agent, proceed, user } from "../../script";
import { AudioChunk } from "../../voice/audio-chunk";
import { createAudioMessage, extractAudio } from "../../voice/messages";
import { FakeVoiceAdapter } from "../../voice/__tests__/fixtures/fake-adapter";

/** EL-like AUT: audio-only frames on the wire (no per-chunk transcript). The
 *  turn's text lands on `lastAgentTranscript` DURING the drain — exactly the
 *  hosted-EL shape (the `agent_response` event fires while audio streams), NOT
 *  a static value. Modeling it per-drain is what makes the test faithful to the
 *  generic pre-drain reset defaultVoiceCall now does. */
const AGENT_TURN_TEXT = "Certainly — your balance is $100.";
class FakeVoiceAUTWithTranscript extends FakeVoiceAdapter {
  lastAgentTranscript: string | null = null;
  private turnEmitted = false;
  constructor() {
    super();
  }
  override async call(
    input: import("../../domain").AgentInput,
  ): Promise<AgentReturnTypes> {
    this.turnEmitted = false; // new turn
    return super.call(input);
  }
  override async receiveAudio(_timeout: number): Promise<AudioChunk> {
    if (this.turnEmitted) return new AudioChunk({ data: new Uint8Array(0) });
    this.turnEmitted = true;
    // The transcript event arrives WHILE the turn's audio streams.
    this.lastAgentTranscript = AGENT_TURN_TEXT;
    return new AudioChunk({ data: new Uint8Array(400) });
  }
}

/** Realtime-like USER returning audio+transcript (satisfies isRealtimeUserAgent). */
class FakeRealtimeUser extends AgentAdapter {
  override role = AgentRole.USER;
  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(
      new AudioChunk({ data: new Uint8Array(200), transcript: "and my recent transactions?" }),
      "user",
    );
  }
  async sendText(_t: string): Promise<void> {}
  async speakUserTurn(text: string): Promise<{ data: Uint8Array; transcript?: string }> {
    return { data: new Uint8Array(200), transcript: text };
  }
}

/** Agent-under-test holding a PRIOR turn's transcript whose CURRENT turn emits
 *  audio but no fresh transcript — the bleed case. `defaultVoiceCall` must null
 *  `lastAgentTranscript` before the drain so this turn carries NO transcript,
 *  not the stale one (devils-advocate: OpenAI Realtime as agent hit exactly this
 *  via super.call()). */
class StaleTranscriptAUT extends FakeVoiceAdapter {
  lastAgentTranscript: string | null = "STALE prior-turn transcript";
  constructor() {
    super({
      responses: [
        new AudioChunk({ data: new Uint8Array(400) }), // audio, no fresh transcript
        new AudioChunk({ data: new Uint8Array(0) }),
      ],
    });
  }
}

describe("voice agent-under-test turn carries its native transcript (#705)", () => {
  it("attaches lastAgentTranscript to the assistant audio message", async () => {
    const execution = new ScenarioExecution(
      {
        name: "agent-transcript",
        description: "agent turns must carry their transcript",
        agents: [new FakeVoiceAUTWithTranscript(), new FakeRealtimeUser()],
      },
      [agent(), proceed(2)],
      "batch-test",
    );

    await execution.execute();

    const agentMessages = execution.messages.filter((m) => m.role === "assistant");
    expect(agentMessages.length).toBeGreaterThan(0);
    // Every agent turn's audio message must carry the native transcript — before
    // the fix these were audio-only (extractAudio(...).transcript === undefined).
    for (const m of agentMessages) {
      const chunk = extractAudio(m);
      expect(chunk, "agent message had no audio part").not.toBeNull();
      expect(
        chunk!.transcript,
        "agent audio message reached the conversation with NO transcript (missing-AUT-transcript regression)",
      ).toBe(AGENT_TURN_TEXT);
    }
  });

  it("does NOT bleed a stale prior-turn transcript onto a REPLY that produces none", async () => {
    const aut = new StaleTranscriptAUT();
    // A prior USER audio turn, then the AGENT reply. The reply HAS incoming
    // audio, so the pre-drain reset fires (the greeting path, with no incoming,
    // is deliberately exempt).
    const userTurn = createAudioMessage(
      new AudioChunk({ data: new Uint8Array(200), transcript: "check my balance" }),
      "user",
    );
    const execution = new ScenarioExecution(
      {
        name: "no-transcript-bleed",
        description: "a reply with audio but no fresh transcript must not inherit the stale one",
        agents: [aut, new FakeRealtimeUser()],
      },
      [user(userTurn), agent()],
      "batch-test",
    );

    await execution.execute();

    const agentMsg = execution.messages.find((m) => m.role === "assistant");
    expect(agentMsg, "no agent reply produced").toBeDefined();
    const chunk = extractAudio(agentMsg!);
    expect(chunk, "agent message had no audio part").not.toBeNull();
    // defaultVoiceCall nulled lastAgentTranscript before the reply's drain; the
    // drain set no fresh value → the turn carries NO transcript (NOT the stale
    // prior line).
    expect(
      chunk!.transcript ?? "",
      "stale prior-turn transcript bled onto a reply that produced none",
    ).not.toContain("STALE");
    expect(chunk!.transcript ?? "").toBe("");
  });
});
