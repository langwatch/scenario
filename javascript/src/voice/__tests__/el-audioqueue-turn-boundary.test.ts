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
import { extractAudio } from "../messages";
import { AdapterCapabilities } from "../capabilities";

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
