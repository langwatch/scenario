/**
 * #734 — transcript grace-wait in the default voice call() (AC5, AC3, AC1).
 *
 * ROOT CAUSE (verified on main): `drainAgentResponse` closes the agent turn on
 * AUDIO silence (`responseTailSilence`) and NEVER waits for the transcript. A
 * hosted-ElevenLabs agent delivers the turn's text on a SEPARATE socket event
 * (`agent_response` → `lastAgentTranscript`) that can land AFTER the audio
 * boundary. `attachAgentTurnTranscript` then snapshots `lastAgentTranscript` at
 * drain-close; when the event hasn't landed, the field is `null`, no
 * `{type:"text"}` part is attached, and the turn reaches the text-only
 * user-simulator as a bare `[audio message]` → the simulator fabricates.
 *
 * These tests drive the REAL `defaultVoiceCall` runtime with a fake adapter that
 * models the race precisely: `receiveAudio` yields transcript-LESS audio (raw
 * PCM, as EL does), and `lastAgentTranscript` is set on a configurable DELAY
 * (mimicking the separate `agent_response` event). No executor state is wired,
 * so `call()` returns the merged assistant audio message directly and we assert
 * on the transcript part it carries.
 *
 * - AC5 (falsifiability): a transcript that lands AFTER audio drain but WITHIN
 *   the grace window is attached. FAILS on main (no wait → snapshot reads null →
 *   no text part); PASSES with the grace-wait.
 * - AC3 (no-regression): when the transcript is ALREADY set at drain-close, the
 *   grace-wait short-circuits — `call()` returns without spending the ceiling
 *   (timing assertion), and the transcript is still attached.
 * - Bounded: a transcript that NEVER arrives terminates the turn after the
 *   ceiling with no text part (so a genuine EL drop still ends the turn — the
 *   STT fallback, AC2, then covers it downstream).
 */
import { describe, it, expect, afterEach } from "vitest";

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

/** Every RaceAdapter built this test — disposed in afterEach so no timer leaks. */
const liveAdapters: RaceAdapter[] = [];

/** A non-silent PCM16 chunk (mono, 24kHz) carrying NO transcript — raw EL audio. */
function rawTone(durationSeconds: number): AudioChunk {
  const numSamples = Math.round(durationSeconds * PCM16_SAMPLE_RATE);
  const data = new Uint8Array(numSamples * PCM16_SAMPLE_WIDTH_BYTES);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 20000) - 10000, true);
  }
  return new AudioChunk({ data }); // no transcript — mimics EL's raw PCM frames
}

/**
 * Fake adapter modeling the EL race: audio drains with NO per-chunk transcript;
 * `lastAgentTranscript` is populated on a delay (the separate `agent_response`
 * event) — or never, when `transcriptDelayMs` is null.
 */
class RaceAdapter extends VoiceAgentAdapter {
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

  private index = 0;
  private readonly responses: AudioChunk[];
  /** Handle for the delayed-transcript timer so teardown can clear it. */
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;

  /** Clear any pending delayed-transcript timer (called on test teardown). */
  dispose(): void {
    if (this.transcriptTimer !== null) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
  }

  constructor(
    private readonly transcript: string,
    /** ms after drain-close that the transcript event lands; null = never. */
    private readonly transcriptDelayMs: number | null,
  ) {
    super();
    // One real audio frame, then end-of-stream so the drain loop exits fast.
    this.responses = [rawTone(0.5)];
    liveAdapters.push(this);
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(): Promise<void> {}

  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    if (this.index < this.responses.length) {
      const chunk = this.responses[this.index++]!;
      // On the LAST real chunk, schedule the transcript to land after drain —
      // i.e. AFTER the audio-silence boundary, modeling the lost race. Unref the
      // timer so a leaked scheduling never keeps the process (or a later test)
      // alive; `dispose()` clears it explicitly on teardown.
      if (this.index === this.responses.length && this.transcriptDelayMs !== null) {
        this.transcriptTimer = setTimeout(() => {
          this.lastAgentTranscript = this.transcript;
        }, this.transcriptDelayMs);
        this.transcriptTimer.unref?.();
      }
      return chunk;
    }
    return silentChunk(0);
  }
}

/**
 * An adapter that returns raw audio and does NOT expose the `lastAgentTranscript`
 * convention at all — models Twilio/Pipecat (raw-audio) and Composable (text on a
 * different field). The grace-wait must skip these entirely: waiting could never
 * succeed, so it would burn the full ceiling per turn for nothing (the P1).
 */
class TranscriptlessAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: true,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  // NOTE: deliberately NO `lastAgentTranscript` field declared.

  private index = 0;
  private readonly responses: AudioChunk[] = [rawTone(0.5)];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(): Promise<void> {}

  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    if (this.index < this.responses.length) return this.responses[this.index++]!;
    return silentChunk(0);
  }
}

/** Minimal AgentInput: one user turn, no executor state (recorder no-ops). */
function inputWithUserTurn(): AgentInput {
  return {
    threadId: "t-734",
    messages: [],
    newMessages: [{ role: "user", content: "hello" }],
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
  };
}

/** Pull the transcript text part (if any) from a returned assistant message. */
function transcriptOf(message: unknown): string | null {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content.find(
    (p) =>
      p &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string",
  ) as { text?: string } | undefined;
  return text?.text ?? null;
}

describe("#734 transcript grace-wait (defaultVoiceCall)", () => {
  afterEach(() => {
    // Clear any pending delayed-transcript timers so nothing fires into a later test.
    while (liveAdapters.length > 0) liveAdapters.pop()!.dispose();
  });

  it("AC5: attaches a transcript that lands AFTER audio drain but within the grace window (FAILS on main)", async () => {
    // Transcript lands 100ms after drain-close — past audio silence, well within
    // a 2s grace ceiling. On main (no wait) the snapshot reads null → no text
    // part → the message reaches the simulator as bare audio. With the fix the
    // grace-wait polls until the transcript lands and attaches it.
    const adapter = new RaceAdapter("the balance is forty two dollars", 100);
    adapter.responseTailSilence = 0.02; // shrink drain so the transcript can't win
    adapter.transcriptGraceWait = 2.0;

    const message = await defaultVoiceCall(adapter, inputWithUserTurn());

    expect(transcriptOf(message)).toBe("the balance is forty two dollars");
  });

  it("AC3: short-circuits with ZERO added latency when the transcript already won the race", async () => {
    // Transcript is present the instant audio drains (delay 0 fires within the
    // drain's own microtask window is not guaranteed — so set it eagerly here to
    // model 'already set at drain-close', the happy path).
    const adapter = new RaceAdapter("coherent reply", null);
    adapter.responseTailSilence = 0.02;
    // Long ceiling: if the wait did NOT short-circuit it would dominate the timing.
    adapter.transcriptGraceWait = 5.0;
    adapter.lastAgentTranscript = "coherent reply"; // already set at drain-close

    const start = Date.now();
    const message = await defaultVoiceCall(adapter, inputWithUserTurn());
    const elapsedMs = Date.now() - start;

    expect(transcriptOf(message)).toBe("coherent reply");
    // The 5s ceiling must not be spent — the short-circuit returns immediately.
    // Generous bound (well under the ceiling) to stay non-flaky under CI load.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("bounded: a transcript that NEVER arrives terminates the turn after the ceiling with no text part", async () => {
    // EL genuinely dropped the transcript for this turn. The grace-wait must not
    // hang forever — it elapses the (small, for the test) ceiling and returns an
    // audio-only turn. The STT fallback (AC2) then covers this downstream.
    const adapter = new RaceAdapter("never sent", null);
    adapter.responseTailSilence = 0.02;
    adapter.transcriptGraceWait = 0.1; // small ceiling so the test is fast

    const start = Date.now();
    const message = await defaultVoiceCall(adapter, inputWithUserTurn());
    const elapsedMs = Date.now() - start;

    expect(transcriptOf(message)).toBeNull(); // audio-only turn, no fabricated text
    expect(elapsedMs).toBeGreaterThanOrEqual(90); // waited ~the ceiling
    expect(elapsedMs).toBeLessThan(2000); // but bounded, did not hang
  });

  it("adds ZERO latency for an adapter that does not expose lastAgentTranscript (P1 — Twilio/Pipecat/Composable)", async () => {
    // The adapter never declares `lastAgentTranscript`, so the grace-wait could
    // never succeed. It MUST short-circuit on the absent property rather than burn
    // the ceiling: pre-fix this turn cost the full 2s; post-fix it costs ~0.
    const adapter = new TranscriptlessAdapter();
    adapter.responseTailSilence = 0.02;
    adapter.transcriptGraceWait = 2.0; // the real default — would dominate if we waited

    const start = Date.now();
    const message = await defaultVoiceCall(adapter, inputWithUserTurn());
    const elapsedMs = Date.now() - start;

    // Audio-only turn (no transcript convention), and critically NO ceiling spent.
    expect(transcriptOf(message)).toBeNull();
    expect(elapsedMs).toBeLessThan(500); // well under the 2s ceiling → wait was skipped
  });
});
