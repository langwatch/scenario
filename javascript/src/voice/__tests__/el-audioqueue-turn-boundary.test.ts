/**
 * #747 — the EL adapter's audioQueue is never reconciled at turn boundaries, so
 * a SPLIT agent utterance bleeds its remainder into a fake next agent turn.
 *
 * ROOT CAUSE (verified in code at javascript/v0.5.1): the shared drain
 * `drainAgentResponse` (adapter.runtime.ts) closes a turn with
 * `while (accumulated < responseMaxDuration)` — a HARD CHOP. Hosted ElevenLabs
 * delivers a turn's audio in a near-instant burst onto the adapter's audioQueue
 * (elevenlabs.ts:340; push :554 / shift :778, never reconciled), so when an
 * utterance's audio exceeds `responseMaxDuration` the drain stops mid-utterance
 * and ABANDONS the already-arrived remainder in the queue. The NEXT agent() turn
 * then shifts that stale remainder out instantly (gap=0) as the start of a FAKE
 * agent turn — the doubled greeting the judge fails the run on.
 *
 * These tests drive the REAL `defaultVoiceCall` through a fake adapter that
 * models EL's burst delivery precisely: one shared queue, pre-loaded with a whole
 * utterance, drained instantly per receiveAudio, empty (silent) once exhausted.
 * No executor state is wired, so call() returns the merged assistant audio
 * message directly and we assert on the audio it carries.
 *
 * - AC4a (un-chop): a continuous utterance longer than responseMaxDuration lands
 *   WHOLE in the turn. FAILS on main (chopped to responseMaxDuration).
 * - AC2 (no bleed): the remainder never surfaces as the next turn's audio.
 *   FAILS on main (turn 2 = the stale remainder, arriving instantly).
 */
import { describe, it, expect, vi } from "vitest";

import { AgentRole, type AgentInput } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { defaultVoiceCall } from "../adapter.runtime";
import {
  AudioChunk,
  silentChunk,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
} from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { extractAudio, createAudioMessage } from "../messages";
import { VoiceRecordingRuntime } from "../recording.runtime";
import type { AudioSegment, VoiceRecording } from "../recording.types";
import type { VoiceExecutorState } from "../voice-executor-state";

/** A non-silent PCM16 (mono, 24kHz) chunk of the given duration, carrying no transcript. */
function tone(durationSeconds: number): AudioChunk {
  const numSamples = Math.round(durationSeconds * PCM16_SAMPLE_RATE);
  const data = new Uint8Array(numSamples * PCM16_SAMPLE_WIDTH_BYTES);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 20000) - 10000, true);
  }
  return new AudioChunk({ data });
}

/** Seconds of audio carried by a returned assistant message (0 if none). */
function audioSecondsOf(message: unknown): number {
  const chunk = extractAudio(message);
  return chunk ? chunk.durationSeconds : 0;
}

/**
 * Models hosted ElevenLabs' burst delivery: the WHOLE utterance is pushed onto
 * one shared queue up front; each `receiveAudio` shifts the next frame instantly
 * (gap=0, exactly EL's measured burst), and returns an empty/silent chunk once
 * the queue drains. The queue PERSISTS across `receiveAudio` calls and across
 * turns — which is precisely why an undrained remainder bleeds into the next turn.
 */
class BurstQueueAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: true,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  lastAgentTranscript: string | null = null;

  /** The shared, never-reconciled queue — models elevenlabs.ts:340 audioQueue. */
  private readonly queue: AudioChunk[];

  constructor(frames: AudioChunk[]) {
    super();
    this.queue = [...frames];
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(): Promise<void> {}

  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    const next = this.queue.shift();
    // Empty chunk == audio silence: the drain reads it as end-of-turn.
    return next ?? silentChunk(0);
  }

  /** How many frames remain queued (test introspection). */
  get queuedFrames(): number {
    return this.queue.length;
  }

  /**
   * Models the EL adapter's #747 seam: synchronously drain+merge every queued
   * chunk, or null when empty. The runtime's turn-boundary reconcile calls this.
   */
  reconcilePendingAudio(): AudioChunk | null {
    if (this.queue.length === 0) return null;
    const chunks = this.queue.splice(0, this.queue.length);
    const total = chunks.reduce((acc, c) => acc + c.data.length, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      data.set(c.data, offset);
      offset += c.data.length;
    }
    return new AudioChunk({ data });
  }
}

/**
 * Models a transport that NEVER signals end-of-stream: every `receiveAudio`
 * returns a non-empty frame, forever. The drain must terminate this at the
 * absolute ceiling (2x responseMaxDuration), not run to the 30s default and not
 * wedge (AC4b).
 */
class NeverSilentAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: true,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  lastAgentTranscript: string | null = null;

  constructor(private readonly frameSeconds: number) {
    super();
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(): Promise<void> {}

  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    return tone(this.frameSeconds); // never empty — models an un-terminating stream
  }
}

/** Minimal AgentInput: one user turn, no executor state (recorder no-ops). */
function inputWithUserTurn(): AgentInput {
  return {
    threadId: "t-747",
    messages: [],
    newMessages: [{ role: "user", content: "hello" }],
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
  };
}

/** A fresh voice executor state the runtime recorder writes segments into. */
function makeVoiceState(): VoiceExecutorState {
  return {
    voiceRecording: new VoiceRecordingRuntime(),
    voiceTimeline: [],
    voiceLatency: { measurements: [] },
    voiceRecordingStartedAt: 0,
    voiceAudioCursor: 0,
  } as unknown as VoiceExecutorState;
}

/**
 * AgentInput wired to a voice executor state so `defaultVoiceCall` records
 * segments. `incoming` (a user-audio message) makes this an agent turn REPLYING
 * to a user turn — the branch that triggers the #747 boundary reconcile; omit it
 * for the opening greeting turn.
 */
function inputWithState(
  state: VoiceExecutorState,
  incoming?: AudioChunk,
): AgentInput {
  const newMessages = incoming
    ? [createAudioMessage(incoming, "user") as never]
    : [];
  return {
    threadId: "t-747",
    messages: [],
    newMessages,
    requestedRole: AgentRole.AGENT,
    scenarioState: { _executor: state } as unknown as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
  };
}

/** The recording a voice state carries — fails loudly if it was never wired. */
function recordingOf(state: VoiceExecutorState): VoiceRecording {
  const recording = state.voiceRecording;
  if (!recording) {
    throw new Error("voice executor state carries no recording");
  }
  return recording;
}

/** Agent segments of a recording, in order. */
function agentSegments(state: VoiceExecutorState): AudioSegment[] {
  return recordingOf(state).segments.filter((s) => s.speaker === "agent");
}

/** The first agent segment — fails loudly if the run recorded none. */
function firstAgentSegment(state: VoiceExecutorState): AudioSegment {
  const segment = agentSegments(state)[0];
  if (!segment) {
    throw new Error("expected at least one agent segment in the recording");
  }
  return segment;
}

/**
 * Every segment starts at or after the previous one ends — the append-only
 * audio-cursor invariant the reconcile must never break.
 */
function expectMonotonicSegments(state: VoiceExecutorState): void {
  const segs = recordingOf(state).segments;
  for (let i = 1; i < segs.length; i++) {
    expect(segs[i].startTime).toBeGreaterThanOrEqual(segs[i - 1].endTime - 1e-6);
  }
}

/** Byte-duration (s) of a PCM16/24k/mono segment. */
function segSeconds(audio: Uint8Array): number {
  return audio.length / PCM16_SAMPLE_WIDTH_BYTES / PCM16_SAMPLE_RATE;
}

describe("#747 EL audioQueue turn-boundary reconciliation (defaultVoiceCall)", () => {
  // Three 0.5s frames = 1.5s of ONE continuous utterance, all queued up front
  // (EL burst). With responseMaxDuration = 1.0, main chops after 1.0s and leaves
  // 0.5s stranded. 1.5x the cap mirrors the real repro (a ~50s greeting vs the
  // 30s cap = 1.67x) and sits within the fix's absolute ceiling (2x the cap).
  const FRAME_S = 0.5;
  const TOTAL_S = 1.5;
  const CAP_S = 1.0;

  function buildFrames(): AudioChunk[] {
    const n = Math.round(TOTAL_S / FRAME_S);
    return Array.from({ length: n }, () => tone(FRAME_S));
  }

  it("AC4a: a continuous utterance longer than responseMaxDuration lands WHOLE (FAILS on main)", async () => {
    const adapter = new BurstQueueAdapter(buildFrames());
    adapter.responseMaxDuration = CAP_S; // 1.0s cap, utterance is 3.0s
    adapter.responseTailSilence = 0.05;
    adapter.transcriptGraceWait = 0;

    const message = await defaultVoiceCall(adapter, inputWithUserTurn());

    // Main chops at the 1.0s cap and abandons 0.5s in the queue → ~1.0s here.
    // The fix drains the already-arrived remainder → the whole 1.5s utterance.
    expect(audioSecondsOf(message)).toBeCloseTo(TOTAL_S, 1);
  });

  it("AC2: the capped remainder does NOT bleed into the next agent turn (FAILS on main)", async () => {
    const adapter = new BurstQueueAdapter(buildFrames());
    adapter.responseMaxDuration = CAP_S;
    adapter.responseTailSilence = 0.05;
    adapter.transcriptGraceWait = 0;

    // Turn 1 (e.g. the greeting / first agent turn).
    await defaultVoiceCall(adapter, inputWithUserTurn());
    // Turn 2 (the next agent turn, after a user turn). On main the drain shifts
    // the STALE remainder out of the persistent queue instantly — a fake turn
    // built entirely from turn 1's leftover audio. With the fix, turn 1 drained
    // the whole utterance, so the queue is empty and turn 2 carries no audio.
    const turn2 = await defaultVoiceCall(adapter, inputWithUserTurn());

    expect(audioSecondsOf(turn2)).toBeCloseTo(0, 1);
  });

  it("AC4b: a never-silent stream terminates at the 2x ceiling with a warning (no wedge)", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new NeverSilentAdapter(FRAME_S);
      adapter.responseMaxDuration = CAP_S; // ceiling = 2 * 1.0 = 2.0s
      adapter.responseTailSilence = 0.05;
      adapter.transcriptGraceWait = 0;

      // If the drain did not bound a never-silent stream this call would never
      // resolve — the test completing at all is the no-wedge proof.
      const message = await defaultVoiceCall(adapter, inputWithUserTurn());

      const secs = audioSecondsOf(message);
      // Bounded at ~2x the cap — not the 30s default, not unbounded.
      expect(secs).toBeGreaterThanOrEqual(CAP_S * 2 - FRAME_S);
      expect(secs).toBeLessThanOrEqual(CAP_S * 2 + FRAME_S);
      // And it warned about hitting the ceiling (never a silent cap).
      const warnedCeiling = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("ceiling"),
      );
      expect(warnedCeiling).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("#747 turn-boundary reconcile (defaultVoiceCall + executor state)", () => {
  // Greeting = 5 frames (2.5s) = 2.5x the 1.0s cap, so the un-chop ceiling (2.0s)
  // strands the last 0.5s in the queue — the >2x residual the reconcile catches.
  const FRAME_S = 0.5;
  const CAP_S = 1.0;
  const GREETING_FRAMES = 5;
  const GREETING_S = FRAME_S * GREETING_FRAMES; // 2.5s

  function greetingAdapter(): BurstQueueAdapter {
    const frames = Array.from({ length: GREETING_FRAMES }, () => tone(FRAME_S));
    const adapter = new BurstQueueAdapter(frames);
    adapter.responseMaxDuration = CAP_S; // ceiling 2.0s
    adapter.responseTailSilence = 0.05;
    adapter.transcriptGraceWait = 0;
    return adapter;
  }

  it("AC3: stale ceiling remainder is attributed to the prior agent segment, not emitted as a new turn", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = makeVoiceState();
      const adapter = greetingAdapter();

      // Turn 1 — the greeting (no incoming). Un-chop drains to the 2.0s ceiling
      // and strands 0.5s in the queue; the greeting agent segment is 2.0s.
      await defaultVoiceCall(adapter, inputWithState(state));
      expect(adapter.queuedFrames).toBe(1); // 0.5s stranded
      expect(agentSegments(state)).toHaveLength(1);
      expect(segSeconds(firstAgentSegment(state).audio)).toBeCloseTo(2.0, 1);

      // Capture the greeting's agent_stop_speaking event (emitted at endTime 2.0)
      // and wire an onAudioChunk hook so we can assert the reconciled bytes are
      // delivered to hook/playback consumers, not silently spliced.
      const stopEvent = recordingOf(state).timeline.find(
        (e) => e.type === "agent_stop_speaking",
      );
      if (!stopEvent) {
        throw new Error("greeting turn emitted no agent_stop_speaking event");
      }
      expect(stopEvent.time).toBeCloseTo(2.0, 1);
      const hookChunks: AudioChunk[] = [];
      (state as unknown as { onAudioChunk?: (c: AudioChunk) => void }).onAudioChunk =
        (c) => hookChunks.push(c);

      // Turn 2 — a user turn commits. The reconcile fires BEFORE recordUser and
      // grows the greeting segment by the stranded 0.5s; the queue is emptied so
      // turn 2's own agent drain carries none of it.
      const turn2 = await defaultVoiceCall(
        adapter,
        inputWithState(state, tone(FRAME_S)),
      );

      // (a) no bleed: turn 2's agent audio does not contain the stale remainder.
      expect(audioSecondsOf(turn2)).toBeCloseTo(0, 1);
      // (b) attributed: the greeting segment grew by exactly the stranded 0.5s.
      expect(segSeconds(firstAgentSegment(state).audio)).toBeCloseTo(GREETING_S, 1);
      expect(adapter.queuedFrames).toBe(0);
      // (c) a warning named the reconciliation.
      const warnedReconcile = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("reconciled prior-turn leftover"),
      );
      expect(warnedReconcile).toBe(true);
      // (d) the reconciled bytes reached the onAudioChunk hook (parity with
      // recordAgent → fireAudioChunk), not just the saved segment.
      const hookSeconds = hookChunks.reduce((a, c) => a + c.durationSeconds, 0);
      expect(hookSeconds).toBeGreaterThanOrEqual(FRAME_S - 1e-6);
      // (e) the agent_stop_speaking event moved to the grown endTime (timeline
      // stays consistent with the segment it describes).
      expect(stopEvent.time).toBeCloseTo(GREETING_S, 1);
      // (f) the grown segment is flagged for the finalize STT back-fill so its
      // transcript can be re-derived to cover the reconciled continuation.
      expect(firstAgentSegment(state).transcriptTruncated).toBe(true);
      // Cursor stays monotonic: user segment starts at/after the grown agent end.
      expectMonotonicSegments(state);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("AC8: the opening greeting turn (no incoming user audio) is never reconciled away", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = makeVoiceState();
      const adapter = greetingAdapter();

      // First agent() with NO incoming — the reconcile branch (inside
      // `if (incoming)`) must not run, so the greeting is delivered as turn 1.
      const greeting = await defaultVoiceCall(adapter, inputWithState(state));

      expect(audioSecondsOf(greeting)).toBeCloseTo(2.0, 1); // greeting delivered
      expect(agentSegments(state)).toHaveLength(1);
      const reconciled = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("reconciled prior-turn leftover"),
      );
      expect(reconciled).toBe(false); // greeting never reconciled
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("AC9: on the barge-in (user-last) shape the reconcile DRAINS the queue (no bleed) but does not grow the segment", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = makeVoiceState();
      const adapter = greetingAdapter();

      // Turn 1 greeting → agent segment, 0.5s stranded in the queue.
      await defaultVoiceCall(adapter, inputWithState(state));
      expect(adapter.queuedFrames).toBe(1);
      // Simulate a barge-in recording shape: a USER segment is now the LAST on
      // the cursor (as fireUserInterrupt lays it after the interrupted agent
      // segment). The reconcile must NOT grow the earlier agent segment here…
      recordingOf(state).segments.push({
        speaker: "user",
        startTime: 2.0,
        endTime: 2.5,
        audio: tone(FRAME_S).data,
      });
      state.voiceAudioCursor = 2.5; // advance the cursor as the real recorder does
      const agentAudioBefore = segSeconds(firstAgentSegment(state).audio);

      const turn2 = await defaultVoiceCall(
        adapter,
        inputWithState(state, tone(FRAME_S)),
      );

      // …but it MUST still drain the queue, so the stranded audio can never bleed
      // into this drain (the #747 core fix on the barge-in path — pre-fix this
      // returned WITHOUT draining and the 0.5s surfaced as turn 2's first audio).
      expect(adapter.queuedFrames).toBe(0);
      expect(audioSecondsOf(turn2)).toBeCloseTo(0, 1);
      // The agent segment was NOT grown (cursor-unsafe shape) — the drained audio
      // is dropped with a warning, not attributed.
      expect(segSeconds(firstAgentSegment(state).audio)).toBeCloseTo(
        agentAudioBefore,
        3,
      );
      const droppedWarn = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("dropped"),
      );
      expect(droppedWarn).toBe(true);
      const grownWarn = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("reconciled prior-turn leftover"),
      );
      expect(grownWarn).toBe(false);
      // …and every segment boundary stays monotonic (no overlap).
      expectMonotonicSegments(state);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("AC10: responseTailSilence = 2.0 (the documented workaround) still drains a turn whole", async () => {
    const state = makeVoiceState();
    // A single sub-cap utterance (3 frames = 1.5s) delivered as a burst.
    const adapter = new BurstQueueAdapter(
      Array.from({ length: 3 }, () => tone(FRAME_S)),
    );
    adapter.responseMaxDuration = 30;
    adapter.responseTailSilence = 2.0; // the interim workaround
    adapter.transcriptGraceWait = 0;

    const message = await defaultVoiceCall(adapter, inputWithState(state));

    // Drains the whole utterance and terminates (no double-waiting / wedge).
    expect(audioSecondsOf(message)).toBeCloseTo(1.5, 1);
  });
});
