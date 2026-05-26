/**
 * Voice-adapter runtime — the executor-side wiring that PR1 left abstract.
 *
 * This module ports `python/scenario/voice/adapter.py` runtime (not the
 * abstract contract) into TypeScript:
 *
 * - `asyncio.Event` → {@link AgentSpeakingEvent}: a `Promise<void>` paired
 *   with an external `resolve` handle so the interruption path can `await`
 *   "the agent began emitting audio" without polling.
 * - `async with adapter:` → explicit {@link startVoiceAdapters} /
 *   {@link stopVoiceAdapters} the executor calls once per scenario.
 * - Hook fan-out for `on_audio_chunk` and `on_voice_event` from PR1's
 *   {@link VoiceExecutorState} surface.
 * - Default `call()` body: send audio → drain → record one segment per
 *   speaker → emit timeline events → return the merged assistant
 *   {@link AudioMessageParam}.
 *
 * Lifecycle invariant (feature spec lines 138-145):
 *   `connect()` is awaited exactly once before the first script step.
 *   `disconnect()` is awaited exactly once regardless of pass / fail /
 *   exception.
 */

import type { AgentInput, AgentReturnTypes } from "../domain/agents";
import { AudioChunk, silentChunk } from "./audio-chunk";
import type { VoiceAgentAdapter } from "./adapter";
import { createAudioMessage, extractAudio } from "./messages";
import type {
  AudioSegment,
  LatencyMetrics,
  SpeakerRole,
  VoiceEvent,
  VoiceRecording,
} from "./recording.types";
import { VoiceRecordingRuntime } from "./recording.runtime";
import type { VoiceExecutorState } from "./voice-executor-state";
import { WebRTCVadFallback } from "./vad";
import { PendingTransportError } from "./adapters/pending-transport-error";

/**
 * `asyncio.Event` analogue: a `Promise<void>` + external resolve handle.
 *
 * Awaiters call {@link wait}; producers call {@link set} the moment the
 * gating condition holds. {@link clear} resets for the next turn. Used by
 * the default `call()` to wake the interruption path the instant the
 * agent begins emitting audio.
 */
export class AgentSpeakingEvent {
  private resolved = false;
  private resolveFn!: () => void;
  private promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  /** Resolve any pending {@link wait} callers and stay resolved. */
  set(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveFn();
  }

  /** Snapshot the current state. */
  get isSet(): boolean {
    return this.resolved;
  }

  /** Resolve a `Promise<void>` once {@link set} is called. */
  wait(): Promise<void> {
    return this.promise;
  }

  /** Rebuild the underlying promise so the next turn can wait again. */
  clear(): void {
    this.resolved = false;
    this.promise = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }
}

const SAFE_DEFAULT_RESPONSE_TIMEOUT_S = 30;
const SAFE_DEFAULT_TAIL_SILENCE_S = 0.6;
const SAFE_DEFAULT_MAX_DURATION_S = 30;

/**
 * Per-scenario VAD fallback registry. Keyed by adapter instance so the
 * one-shot warning gating in {@link WebRTCVadFallback.emitFallbackWarningOnce}
 * remains the source of truth for "once per adapter name."
 */
type VadFallbackEntry = {
  fallback: WebRTCVadFallback;
  state: VoiceExecutorState;
};

const vadRegistry = new WeakMap<VoiceAgentAdapter, VadFallbackEntry>();

/**
 * Run the adapter-runtime lifecycle for every voice adapter participating
 * in the scenario: `await adapter.connect()` once, then attach a VAD
 * fallback when the adapter advertises `capabilities.nativeVad === false`.
 *
 * Symmetric with {@link stopVoiceAdapters}; the executor wraps the script
 * loop in a try/finally so this pair always balances.
 */
export async function startVoiceAdapters(
  adapters: readonly VoiceAgentAdapter[],
  state: VoiceExecutorState,
): Promise<void> {
  for (const adapter of adapters) {
    await adapter.connect();
    if (!adapter.capabilities.nativeVad) {
      attachVadFallback(adapter, state);
    }
  }
}

/**
 * Disconnect every voice adapter. Errors are swallowed so cleanup always
 * completes — matches Python `ScenarioExecutor._voice_disconnect_all`
 * (`python/scenario/scenario_executor.py:747-759`) — disconnect failures
 * must not mask the primary scenario result.
 */
export async function stopVoiceAdapters(
  adapters: readonly VoiceAgentAdapter[],
): Promise<void> {
  for (const adapter of adapters) {
    vadRegistry.delete(adapter);
    try {
      await adapter.disconnect();
    } catch {
      // Intentional swallow — see jsdoc above. Production callers
      // override `disconnect()` to log internally if they care.
    }
  }
}

/**
 * Filter heterogeneous agent arrays down to the voice adapters. Centralised
 * here so the executor stays ignorant of the voice subsystem shape. Accepts
 * an `unknown[]` because the executor's `AgentAdapter[]` type has no
 * `capabilities` field — voice adapters add it at the subclass layer.
 */
export function pickVoiceAdapters(
  agents: readonly unknown[],
): VoiceAgentAdapter[] {
  return agents.filter(isVoiceAgentAdapter);
}

function isVoiceAgentAdapter(agent: unknown): agent is VoiceAgentAdapter {
  return (
    typeof agent === "object" &&
    agent !== null &&
    "connect" in agent &&
    "disconnect" in agent &&
    "sendAudio" in agent &&
    "receiveAudio" in agent &&
    "capabilities" in agent
  );
}

/**
 * Materialise the voice-side fields on the executor state. Called once at
 * scenario start (before the first script step) when at least one voice
 * adapter is in the agents list.
 */
export function initVoiceExecutorState(state: VoiceExecutorState): void {
  if (!state.voiceRecording) {
    state.voiceRecording = emptyRecording();
  }
  if (!state.voiceTimeline) {
    state.voiceTimeline = [];
  }
  if (!state.voiceLatency) {
    state.voiceLatency = emptyLatencyMetrics();
  }
  if (state.voiceRecordingStartedAt == null) {
    state.voiceRecordingStartedAt = nowSeconds();
  }
  if (state.voiceAudioCursor == null) {
    state.voiceAudioCursor = 0;
  }
}

/**
 * The per-run recording is a {@link VoiceRecordingRuntime} instance — NOT a
 * bare object — so `result.audio.save()` / `result.audio.saveSegments()`
 * exist on the value that {@link ScenarioExecution.setResult} attaches (Gap B).
 * Its `segments` / `timeline` arrays are appended in place during the run by
 * {@link appendSegment} / {@link appendEvent}.
 */
function emptyRecording(): VoiceRecording {
  return new VoiceRecordingRuntime();
}

function emptyLatencyMetrics(): LatencyMetrics {
  return { measurements: [] };
}

function attachVadFallback(
  adapter: VoiceAgentAdapter,
  state: VoiceExecutorState,
): void {
  if (vadRegistry.has(adapter)) {
    return;
  }
  const fallback = new WebRTCVadFallback(adapter.constructor.name, {
    onSpeechStart: () => {
      appendEvent(state, {
        time: nowOffset(state),
        type: "user_start_speaking",
        metadata: { source: "vad-fallback" },
      });
    },
    onSpeechEnd: () => {
      appendEvent(state, {
        time: nowOffset(state),
        type: "user_stop_speaking",
        metadata: { source: "vad-fallback" },
      });
    },
  });
  vadRegistry.set(adapter, { fallback, state });
}

/**
 * Drive a {@link VoiceAgentAdapter} through one default `call()` cycle.
 *
 * Mirrors `python/scenario/voice/adapter.py:VoiceAgentAdapter.call`:
 * extract incoming audio (if any), transmit, drain the agent response on
 * tail-silence, record once into the executor state, return the merged
 * assistant audio message. Stateless w.r.t. the adapter aside from the
 * `_agent_speaking` event the runtime maintains here.
 */
export async function defaultVoiceCall(
  adapter: VoiceAgentAdapter,
  input: AgentInput,
): Promise<AgentReturnTypes> {
  // Gap #11 — uniform connected-state gate: a call() issued before the
  // executor's connect() (or after a dropped transport) fails with one clear
  // PendingTransportError across every leaf, not a transport-specific
  // null-deref or silent hang.
  if (!adapter.isConnected()) {
    throw new PendingTransportError(adapter.constructor.name);
  }
  const speakingEvent = getAgentSpeakingEvent(adapter);
  speakingEvent.clear();

  const state = readVoiceState(input);
  const recorder = new AdapterRecorder(state);

  const incoming = extractIncomingAudio(input.newMessages);
  if (incoming) {
    await adapter.sendAudio(incoming);
    feedVad(adapter, incoming);
    recorder.recordUser(incoming);
  }

  const merged = await drainAgentResponse(adapter, speakingEvent, () => {
    recorder.markAgentStart();
  });
  recorder.recordAgent(merged);
  // Single shared encoder (messages.ts) — the canonical AI-SDK `file` audio
  // part (EDR §4.2). Cast to AgentReturnTypes (rooted in `ai`'s ModelMessage)
  // because createAudioMessage's role/content array is broader than the
  // per-role unions; the body is a valid ModelMessage at runtime.
  return createAudioMessage(merged, "assistant") as unknown as AgentReturnTypes;
}

/**
 * Handle for a non-blocking voice turn started by {@link startVoiceTurn} — the
 * bridge that lets `agent({ wait: false })` begin receiving the agent's audio
 * without awaiting it, so the script can inject a mid-turn interruption (PRD
 * §4.4) before {@link finish} merges and records the response.
 */
export interface VoiceTurnHandle {
  /**
   * Send audio to the adapter mid-turn — the barge-in. The user-simulator's
   * interruption audio is transmitted while the agent is still speaking; the
   * server's VAD detects it and the agent stops. Records a user segment when
   * a recorder is attached.
   */
  injectAudio(audio: AudioChunk): Promise<void>;
  /**
   * Await the in-flight agent response, record the agent segment, and return
   * the merged assistant audio {@link AgentReturnTypes}. Idempotent — calling
   * twice returns the same settled result.
   */
  finish(): Promise<AgentReturnTypes>;
}

/**
 * Start a {@link VoiceAgentAdapter} turn WITHOUT blocking on the response — the
 * non-blocking primitive behind `agent({ wait: false })` (PRD §4.4 L330-350).
 *
 * Sends the incoming user audio (if any), begins draining the agent response
 * in the background, and returns a {@link VoiceTurnHandle}. The caller can
 * {@link VoiceTurnHandle.injectAudio} a barge-in while the agent speaks, then
 * {@link VoiceTurnHandle.finish} to merge + record. Mirrors the default
 * {@link defaultVoiceCall} flow but splits send from drain so an interruption
 * can land in between.
 */
export function startVoiceTurn(
  adapter: VoiceAgentAdapter,
  input: AgentInput,
): VoiceTurnHandle {
  // Same connected-state gate as defaultVoiceCall (Gap #11).
  if (!adapter.isConnected()) {
    throw new PendingTransportError(adapter.constructor.name);
  }
  const speakingEvent = getAgentSpeakingEvent(adapter);
  speakingEvent.clear();

  const state = readVoiceState(input);
  const recorder = new AdapterRecorder(state);

  // Send the incoming user audio, then kick off the drain immediately so the
  // agent is already speaking by the time the caller injects an interruption.
  const sendThenDrain = (async (): Promise<AudioChunk> => {
    const incoming = extractIncomingAudio(input.newMessages);
    if (incoming) {
      await adapter.sendAudio(incoming);
      feedVad(adapter, incoming);
      recorder.recordUser(incoming);
    }
    return drainAgentResponse(adapter, speakingEvent, () => {
      recorder.markAgentStart();
    });
  })();

  let finished: Promise<AgentReturnTypes> | null = null;

  return {
    async injectAudio(audio: AudioChunk): Promise<void> {
      // The barge-in: transmit user audio while the agent is still speaking.
      await adapter.sendAudio(audio);
      feedVad(adapter, audio);
      recorder.recordUser(audio);
    },
    finish(): Promise<AgentReturnTypes> {
      if (!finished) {
        finished = sendThenDrain.then((merged) => {
          recorder.recordAgent(merged);
          return createAudioMessage(
            merged,
            "assistant",
          ) as unknown as AgentReturnTypes;
        });
      }
      return finished;
    },
  };
}

/**
 * Pull the audio chunk from the most-recent inbound message via the shared
 * {@link extractAudio} gateway. An odd-byte (non-PCM16) payload makes the
 * {@link AudioChunk} constructor throw; we drop it rather than crashing the
 * `call()` flow — the adapter is expected to fix at its transport boundary.
 */
function extractIncomingAudio(
  newMessages: AgentInput["newMessages"],
): AudioChunk | null {
  if (newMessages.length === 0) return null;
  const last = newMessages[newMessages.length - 1];
  try {
    return extractAudio(last);
  } catch {
    return null;
  }
}

function feedVad(adapter: VoiceAgentAdapter, chunk: AudioChunk): void {
  const entry = vadRegistry.get(adapter);
  if (entry) {
    entry.fallback.process(chunk);
  }
}

async function drainAgentResponse(
  adapter: VoiceAgentAdapter,
  speakingEvent: AgentSpeakingEvent,
  onFirstChunk: () => void,
): Promise<AudioChunk> {
  const tailSilence = adapter.responseTailSilence ?? SAFE_DEFAULT_TAIL_SILENCE_S;
  const responseTimeout =
    adapter.responseTimeout ?? SAFE_DEFAULT_RESPONSE_TIMEOUT_S;
  const maxDuration =
    adapter.responseMaxDuration ?? SAFE_DEFAULT_MAX_DURATION_S;

  const first = await adapter.receiveAudio(responseTimeout);
  if (first.data.length > 0) {
    onFirstChunk();
  }
  speakingEvent.set();

  const chunks: AudioChunk[] = [first];
  let accumulated = first.durationSeconds;
  while (accumulated < maxDuration) {
    let next: AudioChunk;
    try {
      next = await adapter.receiveAudio(tailSilence);
    } catch {
      break;
    }
    if (next.data.length === 0) {
      break;
    }
    chunks.push(next);
    accumulated += next.durationSeconds;
  }
  return mergeChunks(chunks);
}

function mergeChunks(chunks: AudioChunk[]): AudioChunk {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((acc, c) => acc + c.data.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  const transcripts: string[] = [];
  for (const c of chunks) {
    data.set(c.data, offset);
    offset += c.data.length;
    if (c.transcript) transcripts.push(c.transcript);
  }
  const transcript = transcripts.length > 0 ? transcripts.join(" ") : undefined;
  return new AudioChunk({ data, transcript });
}

/**
 * Bridges a single `call()` turn's audio and timing into the executor
 * state. Kept private (one-call-per-instance) so subclasses can opt out
 * by overriding `call()` and the default flow stays short.
 *
 * Timing model (review M1): segment start/end are laid on a byte-accurate
 * AUDIO cursor — each segment occupies `[cursor, cursor + chunk.durationSeconds]`
 * and advances the cursor by its PCM byte-duration. A segment's
 * `endTime - startTime` therefore equals its true audio length, and
 * `recording.duration` (= max endTime) equals the `full.wav` byte-duration,
 * regardless of how fast an in-process transport flushed the bytes. The OLD
 * model timestamped each segment at the wall-clock instant `sendAudio` /
 * `receiveAudio` resolved, which on fast transports collapsed multi-second
 * turns to ~1 ms and made `manifest.duration` unreliable as audio-length proof.
 *
 * Latency is NOT derived from these audio offsets (consecutive turns are
 * gapless on the cursor, so an offset gap would always be ~0). It is measured
 * from the wall-clock marks {@link recordUser} / {@link markAgentStart} keep —
 * the genuine response time between the user finishing on the wire and the
 * agent's first chunk arriving.
 */
export class AdapterRecorder {
  /** Wall-clock offset (seconds) when user transmission finished — latency only. */
  private userEndWall: number | null = null;
  /** Wall-clock offset (seconds) when the agent's first chunk arrived. */
  private agentStartWall: number | null = null;
  constructor(private readonly state: VoiceExecutorState | null) {}

  recordUser(chunk: AudioChunk): void {
    if (!this.state || chunk.data.length === 0) return;
    // Wall-clock end of the user turn — kept for the latency measurement, NOT
    // for the segment timestamps (those are byte-accurate, see below).
    this.userEndWall = nowOffset(this.state);
    writeUserSegment(this.state, chunk);
  }

  markAgentStart(): void {
    if (!this.state) return;
    this.agentStartWall = nowOffset(this.state);
  }

  recordAgent(chunk: AudioChunk): void {
    if (!this.state || chunk.data.length === 0) return;
    fireAudioChunk(this.state, chunk);
    // Byte-accurate placement on the shared audio cursor (M1).
    const { start, end } = layNextSegment(this.state, "agent", chunk);
    let latency: number | undefined;
    if (this.userEndWall !== null && this.agentStartWall !== null) {
      // Real response time: wall-clock from the user finishing on the wire to
      // the agent's first chunk. Derived from the preserved wall-clock marks,
      // so the byte-accurate (gapless) audio timeline doesn't zero it out.
      const candidate = this.agentStartWall - this.userEndWall;
      // Negative latency means the agent started before the user finished
      // sending — a wire-model violation on serial adapters. Treat as a
      // measurement artefact (no record) so percentiles aren't poisoned.
      if (candidate >= 0) {
        latency = candidate;
        recordLatency(this.state, candidate);
      }
    }
    appendEvent(this.state, {
      time: start,
      type: "agent_start_speaking",
      latency,
    });
    appendEvent(this.state, { time: end, type: "agent_stop_speaking" });
  }
}

/**
 * Append a finalised user segment (byte-accurate placement) and the matching
 * start/stop timeline events. Single entry point so the default `call()` flow
 * and the interruption / barge-in path cannot drift apart on the timing model.
 */
export function writeUserSegment(
  state: VoiceExecutorState,
  chunk: AudioChunk,
): void {
  if (chunk.data.length === 0) return;
  fireAudioChunk(state, chunk);
  const { start, end } = layNextSegment(state, "user", chunk);
  appendEvent(state, { time: start, type: "user_start_speaking" });
  appendEvent(state, { time: end, type: "user_stop_speaking" });
}

/**
 * Lay one segment end-to-end on the executor's byte-accurate audio cursor:
 * `start` = the cumulative byte-duration so far, `end` = `start + this chunk's
 * byte-duration`, then advance the cursor by that duration. Gapless +
 * byte-accurate by construction, so `recording.duration` tracks `full.wav`
 * (review M1). Returns the `{ start, end }` it used so the caller can timestamp
 * the corresponding timeline events.
 */
function layNextSegment(
  state: VoiceExecutorState,
  speaker: SpeakerRole,
  chunk: AudioChunk,
): { start: number; end: number } {
  const start = state.voiceAudioCursor ?? 0;
  const end = start + chunk.durationSeconds;
  state.voiceAudioCursor = end;
  appendSegment(state, speaker, start, end, chunk);
  return { start, end };
}

function appendSegment(
  state: VoiceExecutorState,
  speaker: SpeakerRole,
  start: number,
  end: number,
  chunk: AudioChunk,
): void {
  const recording = state.voiceRecording;
  if (!recording) return;
  const segment: AudioSegment = {
    speaker,
    startTime: start,
    endTime: end,
    audio: chunk.data,
    transcript: chunk.transcript,
  };
  recording.segments.push(segment);
}

function appendEvent(state: VoiceExecutorState, event: VoiceEvent): void {
  if (state.voiceTimeline) {
    state.voiceTimeline.push(event);
  }
  if (state.voiceRecording) {
    state.voiceRecording.timeline.push(event);
  }
  const hook = state.onVoiceEvent;
  if (hook) {
    try {
      hook(event);
    } catch {
      // Hooks must never break the scenario — the contract here matches
      // Python adapter.py `_append_event`. Errors are swallowed because
      // the user's observability code shouldn't bring down the test.
    }
  }
}

function fireAudioChunk(state: VoiceExecutorState, chunk: AudioChunk): void {
  const hook = state.onAudioChunk;
  if (!hook) return;
  try {
    hook(chunk);
  } catch {
    // Same swallow rationale as appendEvent — hooks are best-effort.
  }
}

function recordLatency(state: VoiceExecutorState, latency: number): void {
  const metrics = state.voiceLatency;
  if (!metrics) return;
  metrics.measurements.push(latency);
  if (metrics.timeToFirstByte === undefined) {
    metrics.timeToFirstByte = latency;
  }
}

function nowSeconds(): number {
  return performance.now() / 1000;
}

function nowOffset(state: VoiceExecutorState): number {
  const anchor = state.voiceRecordingStartedAt;
  if (anchor == null) return 0;
  return nowSeconds() - anchor;
}

function readVoiceState(input: AgentInput): VoiceExecutorState | null {
  const state = input.scenarioState as { _executor?: unknown } | undefined;
  const executor = state?._executor;
  if (!isVoiceExecutorState(executor)) {
    return null;
  }
  return executor;
}

function isVoiceExecutorState(value: unknown): value is VoiceExecutorState {
  if (typeof value !== "object" || value === null) return false;
  return (
    "voiceRecording" in value &&
    "voiceTimeline" in value &&
    "voiceLatency" in value &&
    "voiceRecordingStartedAt" in value
  );
}

/**
 * Maintain a single {@link AgentSpeakingEvent} per adapter instance so the
 * adapter base does not need to manage it itself. Cleared at the top of
 * every default `call()`.
 */
const speakingEventRegistry = new WeakMap<VoiceAgentAdapter, AgentSpeakingEvent>();

function getAgentSpeakingEvent(adapter: VoiceAgentAdapter): AgentSpeakingEvent {
  let event = speakingEventRegistry.get(adapter);
  if (!event) {
    event = new AgentSpeakingEvent();
    speakingEventRegistry.set(adapter, event);
  }
  return event;
}

/** Re-export so tests importing the runtime get a silent chunk helper too. */
export { silentChunk };
