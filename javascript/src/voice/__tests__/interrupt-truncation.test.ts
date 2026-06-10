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
import { ScenarioExecution } from "../../execution/scenario-execution";
import { agent, interrupt, judge, user } from "../../script";
import { VoiceAgentAdapter } from "../adapter";
import { defaultVoiceCall } from "../adapter.runtime";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { createAudioMessage } from "../messages";
import type { AudioSegment, VoiceEvent } from "../recording.types";
import { markTruncatedAgentSegments } from "../segment-utils";

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

/**
 * Minimal connected adapter where each supplied chunk is its OWN turn: every
 * `receiveAudio` for a turn's audio chunk is followed by an empty end-of-stream
 * marker on the next call, so `drainAgentResponse` (which breaks on the first
 * empty chunk) consumes exactly one chunk per `call()`. `delayFirstChunkMs`
 * defers each turn's audio chunk (the one whose arrival sets the speaking
 * event), so a test can observe the cleared-but-not-yet-set window between
 * turns. (A flat `[chunkA, chunkB]` array would otherwise collapse into a
 * single turn — the drain is greedy until it hits an empty chunk.)
 */
class SpeakingAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  private idx = 0;
  private emitEos = false;
  private readonly chunks: AudioChunk[];
  private readonly delayFirstChunkMs: number;
  constructor(chunks: AudioChunk[], delayFirstChunkMs = 0) {
    super();
    this.chunks = chunks;
    this.delayFirstChunkMs = delayFirstChunkMs;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_c: AudioChunk): Promise<void> {}
  async receiveAudio(_t: number): Promise<AudioChunk> {
    // Alternate: turn's audio chunk, then an empty EOS that ends the drain.
    if (this.emitEos) {
      this.emitEos = false;
      return new AudioChunk({ data: new Uint8Array(0) });
    }
    const chunk =
      this.chunks[this.idx++] ?? new AudioChunk({ data: new Uint8Array(0) });
    if (chunk.data.length === 0) return chunk;
    this.emitEos = true;
    // This is a turn's FIRST chunk (its arrival sets the speaking event) — delay
    // it so the cleared-but-not-yet-set window is observable across a yield.
    if (this.delayFirstChunkMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayFirstChunkMs));
    }
    return chunk;
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
    // Turn-2's first chunk is delayed so the cleared-but-not-yet-set window is
    // observable across a macrotask yield. Without it the immediate chunk would
    // re-set the event before we could observe the clear.
    const adapter = new SpeakingAdapter(
      [tone(0.1, "one"), tone(0.1, "two")],
      50,
    );
    await defaultVoiceCall(adapter, bareInput);
    const ev = adapter.agentSpeakingEvent!;
    expect(ev.isSet()).toBe(true);

    // A fresh turn must CLEAR the event before draining (so a barge-in on turn
    // 2 waits for turn-2 audio, not the stale turn-1 set). The same event
    // instance is reused, re-armed.
    void defaultVoiceCall(adapter, bareInput);
    // Yield a macrotask so any synchronous-ish drain would have run — yet the
    // delayed turn-2 chunk has NOT arrived, so the event must read CLEARED. A
    // no-op clear() (the bug this guards) would leave it set from turn 1.
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.agentSpeakingEvent).toBe(ev);
    expect(ev.isSet()).toBe(false);
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
    // createAudioMessage returns AudioMessage (= ModelMessage), a member of
    // the AgentReturnTypes union — no cast needed.
    return createAudioMessage(tone(0.1, `user line ${this.turn}`), "user");
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

  // Boundary cases — load-bearing because the cursor-based interrupt time
  // lands EXACTLY on a segment boundary (review NIT + the BLOCKER fix relies on
  // inclusive containment).
  it("flags an agent segment when the interrupt lands EXACTLY on its endTime", () => {
    // Fast transport: the agent segment was already laid when the barge-in
    // fired, so the cursor == its endTime.
    const segments = [seg("agent", 2.25, 5.85), seg("user", 5.85, 9.3)];
    markTruncatedAgentSegments(segments, [interruptAt(5.85)]);
    expect(segments[0]!.transcriptTruncated).toBe(true);
    expect(segments[1]!.transcriptTruncated).toBeUndefined();
  });

  it("flags an agent segment when the interrupt lands EXACTLY on its startTime", () => {
    // Slow transport: the interrupted agent segment is recorded AFTER the
    // barge-in cursor capture, so the cursor == its startTime.
    const segments = [seg("user", 0, 2.25), seg("agent", 2.25, 5.85)];
    markTruncatedAgentSegments(segments, [interruptAt(2.25)]);
    expect(segments[1]!.transcriptTruncated).toBe(true);
  });

  // THE BLOCKER regression. The byte-accurate cursor and the wall clock
  // diverge on fast transports (Gemini receives "faster than real-time"):
  // the agent segment occupies the byte span [3.85, 10.33] on the cursor, but
  // the barge-in's WALL-CLOCK offset was 11.865 (outside the byte span — see
  // the committed gemini_live_interruption recording). Timestamping the
  // interrupt on the cursor (== the segment boundary) marks it; the old
  // wall-clock timestamp would NOT have (containment fails), which is exactly
  // why the inline workaround was needed. With the cursor fix the post-hoc
  // pass alone is correct.
  it("marks truncation on the byte cursor even when the wall clock diverged", () => {
    const segments = [
      seg("user", 0, 3.85),
      seg("agent", 3.85, 10.33),
      seg("user", 10.33, 13.13),
    ];
    // What the OLD code recorded: a wall-clock-derived offset (11.865) that
    // sits PAST the agent segment's byte endTime (10.33).
    const wallClockInterrupt = interruptAt(11.865);
    markTruncatedAgentSegments(structuredClone(segments), [wallClockInterrupt]);
    // Sanity: the wall-clock time is genuinely outside the byte span, so the
    // post-hoc pass alone could not have marked it (that's the bug).
    expect(
      segments[1]!.startTime <= wallClockInterrupt.time &&
        wallClockInterrupt.time <= segments[1]!.endTime,
    ).toBe(false);

    // What the FIXED code records: the cursor at the barge-in instant — here
    // the segment's endTime (the fast transport had already laid it).
    const cursorInterrupt = interruptAt(10.33);
    markTruncatedAgentSegments(segments, [cursorInterrupt]);
    expect(
      segments[1]!.transcriptTruncated,
      "cursor-timestamped interrupt did not mark the agent segment it cut off",
    ).toBe(true);
  });
});

describe("the barge-in path fires a user_interrupt during a real run", () => {
  it("interrupt() mid-reply records a user_interrupt event AND truncates the cut-off reply", async () => {
    const exec = new ScenarioExecution(
      {
        name: "barge-in / event fires",
        description: "interrupt() mid-reply records a user_interrupt event",
        agents: [new VerboseVoiceAdapter(), new AudioUserSim(), new PassingJudge()],
      },
      // interrupt() itself fires the in-flight (non-blocking) agent turn, waits
      // for it to start speaking, then barges in with the interrupting audio —
      // so it must NOT be preceded by a separate agent({ wait: false }) (that
      // would register a SECOND, empty turn and the barge-in would land on the
      // empty one, leaving the real reply un-truncated).
      [user(), interrupt({ content: "wait, stop" }), agent(), judge()],
      "test-batch-id",
    );
    const result = await exec.execute();
    const interrupts = (result.timeline ?? []).filter((e) => e.type === "user_interrupt");
    expect(
      interrupts.length,
      "no user_interrupt event — barge-in never fired (the speaking-event wiring is the precondition)",
    ).toBeGreaterThan(0);
    // The interrupt fired AFTER the agent began speaking — the agent's long
    // (1.5s) first chunk keeps the turn draining while interrupt() runs, so the
    // speaking-event gate resolves and the barge-in lands mid-utterance. A
    // `fired_before_speech` here would mean nothing was cut off (hollow).
    const outcome = interrupts[0]!.metadata?.outcome;
    expect(
      outcome,
      "barge-in did not land mid-utterance — nothing was cut off",
    ).toBe("fired_after_speech");
    // And the cut-off agent reply is flagged truncated by the cursor-based
    // post-hoc pass (the ONE truncation mechanism — no inline workaround).
    const truncated = (result.audio?.segments ?? []).filter(
      (s) => s.speaker === "agent" && s.transcriptTruncated,
    );
    expect(
      truncated.length,
      "no agent segment marked transcriptTruncated — the interrupt did not cut off a reply",
    ).toBeGreaterThan(0);
  });
});
