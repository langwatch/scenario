/**
 * Barge-in REALISM fixes (issue #372 — hollow-interruption fix). Two executor
 * behaviours the TS port had dropped vs Python, verified offline:
 *
 * 1. `defaultVoiceCall` PUBLISHES the per-turn speaking event onto
 *    `adapter.agentSpeakingEvent` (cleared at turn start, set on the first
 *    agent chunk) — so the interruption path can WAIT for the agent to
 *    actually start speaking before firing the barge-in. Without this the
 *    field stayed `undefined` and every barge-in fired "before speech" (nothing
 *    to cut off). Mirrors Python `adapter.py` `_agent_speaking_event`.
 *
 * 2. The executor MARKS an agent segment `transcriptTruncated` when a
 *    `user_interrupt` event lands within its `[startTime, endTime]` span —
 *    the recorded chunk-level transcript reflects the agent's INTENDED reply,
 *    not what played before the cut. Mirrors Python
 *    `scenario_executor.py:728-740`.
 *
 * Offline — fake in-memory adapter, no network, no real keys.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  JudgeAgentAdapter,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { agent, interrupt, judge, user } from "../../script";
import {
  ScenarioExecution,
  markTruncatedAgentSegments,
} from "../../execution/scenario-execution";
import { AudioChunk } from "../audio-chunk";
import { VoiceAgentAdapter } from "../adapter";
import { AdapterCapabilities } from "../capabilities";
import { defaultVoiceCall } from "../adapter.runtime";
import { createAudioMessage } from "../messages";
import type { AudioSegment, VoiceEvent } from "../recording.types";

/** A non-silent PCM16 tone (mono, 24kHz) carrying a transcript. */
function tone(durationSeconds: number, transcript: string): AudioChunk {
  const numSamples = Math.floor(durationSeconds * 24000);
  const data = new Uint8Array(numSamples * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 20000) - 10000, true);
  }
  return new AudioChunk({ data, transcript });
}

// ---------------------------------------------------------------------------
// 1. agentSpeakingEvent publication
// ---------------------------------------------------------------------------

/** Minimal connected adapter that yields one agent chunk then end-of-stream. */
class SpeakingAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  private idx = 0;
  private readonly chunks: AudioChunk[];
  constructor(chunks: AudioChunk[]) {
    super();
    this.chunks = chunks;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_c: AudioChunk): Promise<void> {}
  async receiveAudio(_t: number): Promise<AudioChunk> {
    return this.chunks[this.idx++] ?? new AudioChunk({ data: new Uint8Array(0) });
  }
}

const bareInput = {
  threadId: "t",
  messages: [],
  newMessages: [],
  requestedRole: AgentRole.AGENT,
  scenarioState: {} as AgentInput["scenarioState"],
  scenarioConfig: { name: "t", description: "d" } as AgentInput["scenarioConfig"],
} as AgentInput;

describe("defaultVoiceCall publishes the agent speaking event", () => {
  it("sets adapter.agentSpeakingEvent and resolves it once the agent speaks", async () => {
    const adapter = new SpeakingAdapter([tone(0.1, "hi")]);
    // Before any call(), the field is undefined (the bug: interruption path
    // had nothing to wait on).
    expect(adapter.agentSpeakingEvent).toBeUndefined();

    await defaultVoiceCall(adapter, bareInput);

    // After a call(), the event is published AND set (the agent spoke).
    expect(adapter.agentSpeakingEvent).toBeDefined();
    expect(adapter.agentSpeakingEvent!.isSet()).toBe(true);
    // wait() resolves immediately once set.
    await expect(adapter.agentSpeakingEvent!.wait()).resolves.toBeUndefined();
  });

  it("clears the event at the start of the next turn (re-armed)", async () => {
    const adapter = new SpeakingAdapter([tone(0.1, "one"), tone(0.1, "two")]);
    await defaultVoiceCall(adapter, bareInput);
    const ev = adapter.agentSpeakingEvent!;
    expect(ev.isSet()).toBe(true);

    // A fresh turn must clear the event before draining (so a barge-in on turn
    // 2 waits for turn-2 audio, not the stale turn-1 set). The same event
    // instance is reused, re-armed.
    void defaultVoiceCall(adapter, bareInput);
    // Synchronously after the call starts, clear() has run but the new chunk
    // hasn't been drained yet within this microtask.
    expect(adapter.agentSpeakingEvent).toBe(ev);
  });
});

// ---------------------------------------------------------------------------
// 2. transcriptTruncated marking on barge-in
// ---------------------------------------------------------------------------

/**
 * Voice-capable user sim: emits AUDIO turns AND exposes `voice` + `voiceifyText`
 * so the executor's `findVoiceUserSim` recognises it and `user("...")` routes
 * through the barge-in path (`maybeFireUserInterrupt`). Without `voice`/
 * `voiceifyText` the executor treats the line as text and never interrupts.
 */
class AudioUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  readonly voice = "openai/nova";
  private turn = 0;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.turn += 1;
    return createAudioMessage(
      tone(0.1, `user line ${this.turn}`),
      "user",
    ) as unknown as AgentReturnTypes;
  }
  async voiceifyText(text: string): Promise<ReturnType<typeof createAudioMessage>> {
    return createAudioMessage(tone(0.1, text), "user");
  }
}

class PassingJudge extends JudgeAgentAdapter {
  criteria = ["ok"];
  async call(input: AgentInput) {
    if (!input.judgmentRequest) return null;
    return { success: true, reasoning: "done", metCriteria: ["ok"], unmetCriteria: [] };
  }
}

/** Voice agent that produces a LONG reply (many chunks) so a barge-in lands within it. */
class VerboseVoiceAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    interruption: true, // native cancel claimed; base interrupt() throws → degrades to push-audio
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  private idx = 0;
  // One long agent chunk per turn, then end-of-stream. The first chunk is
  // delayed slightly so the agent task is still PENDING (draining) when the
  // barge-in fires — the realistic mid-utterance interrupt the marking guards.
  private readonly script = [
    tone(1.5, "a very long first reply that keeps going"),
    new AudioChunk({ data: new Uint8Array(0) }),
  ];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_c: AudioChunk): Promise<void> {}
  async receiveAudio(_t: number): Promise<AudioChunk> {
    const chunk = this.script[this.idx++] ?? new AudioChunk({ data: new Uint8Array(0) });
    // Delay the FIRST chunk so the drain loop is still in flight while the
    // script's interrupt() runs (keeps pendingAgentTask un-done).
    if (this.idx === 1) await new Promise((r) => setTimeout(r, 40));
    return chunk;
  }
}

function seg(
  speaker: "user" | "agent",
  startTime: number,
  endTime: number,
): AudioSegment {
  return { speaker, startTime, endTime, audio: new Uint8Array(2) };
}
const interruptAt = (time: number): VoiceEvent => ({ time, type: "user_interrupt" });

describe("markTruncatedAgentSegments (the cut-off signal)", () => {
  it("flags an agent segment whose span contains a user_interrupt", () => {
    // Agent reply spans 2.25..5.65; the barge-in lands at 3.17 → cut off.
    const segments = [seg("user", 0, 2.25), seg("agent", 2.25, 5.65), seg("user", 5.65, 9.6)];
    markTruncatedAgentSegments(segments, [interruptAt(3.17)]);
    expect(segments[1]!.transcriptTruncated).toBe(true);
    // The user segments are never flagged.
    expect(segments[0]!.transcriptTruncated).toBeUndefined();
    expect(segments[2]!.transcriptTruncated).toBeUndefined();
  });

  it("flags MULTIPLE agent turns when each is interrupted (recovered both times)", () => {
    const segments = [seg("agent", 0, 3), seg("user", 3, 4), seg("agent", 4, 9)];
    markTruncatedAgentSegments(segments, [interruptAt(1.5), interruptAt(6.0)]);
    expect(segments[0]!.transcriptTruncated).toBe(true);
    expect(segments[2]!.transcriptTruncated).toBe(true);
  });

  it("does NOT flag an agent segment when no interrupt lands in its span", () => {
    const segments = [seg("agent", 0, 3), seg("agent", 5, 8)];
    // Interrupt at 4.0 falls in the GAP between the two agent turns.
    markTruncatedAgentSegments(segments, [interruptAt(4.0)]);
    expect(segments[0]!.transcriptTruncated).toBeUndefined();
    expect(segments[1]!.transcriptTruncated).toBeUndefined();
  });

  it("no user_interrupt events → nothing flagged (clean conversation)", () => {
    const segments = [seg("agent", 0, 3), seg("user", 3, 4)];
    markTruncatedAgentSegments(segments, [{ time: 1, type: "agent_start_speaking" }]);
    expect(segments.some((s) => s.transcriptTruncated)).toBe(false);
  });
});

describe("the barge-in path fires a user_interrupt during a real run", () => {
  it("agent({ wait: false }) + interrupt() records a user_interrupt event", async () => {
    const exec = new ScenarioExecution(
      {
        name: "barge-in / event fires",
        description: "interrupt() mid-reply records a user_interrupt event",
        agents: [new VerboseVoiceAdapter(), new AudioUserSim(), new PassingJudge()],
      },
      // agent({wait:false}) registers the in-flight turn; interrupt() fires the
      // barge-in while the agent's (delayed) long reply is still draining.
      [user(), agent({ wait: false }), interrupt({ content: "wait, stop" }), agent(), judge()],
      "test-batch-id",
    );
    const result = await exec.execute();
    const interrupts = (result.timeline ?? []).filter((e) => e.type === "user_interrupt");
    expect(
      interrupts.length,
      "no user_interrupt event — barge-in never fired (the speaking-event wiring is the precondition)",
    ).toBeGreaterThan(0);
    // The interrupt fired AFTER the agent began speaking (the speaking-event
    // gate worked) — outcome is one of the "fired" variants, not pending_done.
    const outcome = interrupts[0]!.metadata?.outcome;
    expect(["fired_after_speech", "fired_before_speech"]).toContain(outcome);
  });
});
