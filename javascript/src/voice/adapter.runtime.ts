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

import type { VoiceAgentAdapter } from "./adapter";
import { PendingTransportError } from "./adapters/pending-transport-error";
import { AudioChunk, silentChunk } from "./audio-chunk";
import { createAudioMessage, extractAudio } from "./messages";
import { VoiceRecordingRuntime } from "./recording.runtime";
import type {
  AudioSegment,
  LatencyMetrics,
  SpeakerRole,
  VoiceEvent,
  VoiceRecording,
} from "./recording.types";
import { WebRTCVadFallback } from "./vad";
import type { VoiceExecutorState } from "./voice-executor-state";
import type { AgentInput, AgentReturnTypes } from "../domain/agents";
import { Logger } from "../utils/logger";

/** Shared drain logger — surfaces the #747 max-duration / ceiling warnings. */
const logger = new Logger("voice.adapter.runtime");

/**
 * A `Promise<void>` paired with its external `resolve` handle. The Promise
 * executor runs synchronously, so `resolve` is always captured before this
 * returns; the guard states that contract rather than asserting it away.
 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("createDeferred: Promise executor did not run synchronously");
  }
  return { promise, resolve };
}

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
  private resolveFn: () => void;
  private promise: Promise<void>;

  constructor() {
    const deferred = createDeferred();
    this.promise = deferred.promise;
    this.resolveFn = deferred.resolve;
  }

  /** Resolve any pending {@link wait} callers and stay resolved. */
  set(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveFn();
  }

  /**
   * Snapshot the current state. A METHOD (not a getter) so the class
   * structurally satisfies the {@link AgentSpeakingEvent} interface in
   * `adapter.ts` (`isSet(): boolean`) and the interruption path's
   * `speaking.isSet()` calls — the interface, the runtime, and every caller
   * agree on the call form.
   */
  isSet(): boolean {
    return this.resolved;
  }

  /** Resolve a `Promise<void>` once {@link set} is called. */
  wait(): Promise<void> {
    return this.promise;
  }

  /** Rebuild the underlying promise so the next turn can wait again. */
  clear(): void {
    this.resolved = false;
    const deferred = createDeferred();
    this.promise = deferred.promise;
    this.resolveFn = deferred.resolve;
  }
}

const SAFE_DEFAULT_RESPONSE_TIMEOUT_S = 30;
const SAFE_DEFAULT_TAIL_SILENCE_S = 0.6;
const SAFE_DEFAULT_MAX_DURATION_S = 30;
/**
 * Absolute ceiling on ONE agent turn's audio, as a multiple of
 * `responseMaxDuration` (#747). The old drain STOPPED at `responseMaxDuration`
 * and abandoned any audio still queued — a mid-utterance CHOP whose remainder
 * bled into the next turn. Now `responseMaxDuration` is a soft cap that only
 * WARNS: the drain keeps consuming audio that is genuinely still arriving so a
 * long-but-single utterance lands whole. This ceiling is the runaway backstop
 * that replaces the chop — a real utterance always ends earlier via tail-silence,
 * so it fires only for a transport that never signals end-of-stream (AC4b). 2x
 * leaves generous headroom for a legitimately long utterance (the real repro is
 * a ~50s greeting vs the 30s cap = 1.67x) while still bounding an infinite stream.
 *
 * SEMANTIC CHANGE (intended): `responseMaxDuration` is no longer a HARD per-turn
 * cap — it is a soft target that warns; the hard bound is now `2×` it. A
 * *never-silent* transport (a runaway/looping agent) therefore blocks the drain up
 * to ~2× longer worst-case than before (~60s at the 30s default). This is the cost
 * of not splitting a legitimately long utterance and affects only the pathological
 * never-goes-silent case — a real agent falls silent between utterances and drains
 * via tail-silence well before the ceiling. Callers needing a tighter per-turn
 * wall-clock bound should lower `responseMaxDuration`.
 */
const MAX_DURATION_CEILING_FACTOR = 2;
const SAFE_DEFAULT_TRANSCRIPT_GRACE_WAIT_S = 2.0;
/** Poll interval for the transcript grace-wait — fine enough to add no felt latency. */
const TRANSCRIPT_GRACE_POLL_MS = 10;

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
    // #747 — BEFORE committing this user turn, reconcile any audio still queued
    // from the PRIOR agent turn. At this instant (the user is replying; the
    // hosted agent has not begun its next reply) queued agent audio can only be
    // prior-turn leftover — the split remainder a >ceiling utterance or a rare
    // gap-split stranded. Attribute it to the prior agent segment (cursor-safe
    // here, BEFORE recordUser lays the user segment) so the next drain does not
    // shift it out as the fake first audio of a new turn. Skipped when there is
    // no prior agent segment (the opening greeting), so the greeting is never
    // reconciled away (AC8).
    reconcilePriorAgentAudio(adapter, state);
    await adapter.sendAudio(incoming);
    feedVad(adapter, incoming);
    recorder.recordUser(incoming);
    // This agent turn REPLIES to a user turn → turn-scope the transcript the
    // back-fill below reads: null any value the adapter still holds from a PRIOR
    // turn, so attachAgentTurnTranscript picks up only what THIS reply produces
    // during the drain. Adapters set `lastAgentTranscript` during the drain
    // (their transcript event); without this a reply that emits audio but no
    // fresh transcript (hit maxDuration before `transcript.done`, an audio-only
    // session, …) would inherit the previous turn's text — a coherence-breaking
    // bleed (the OpenAI-Realtime-as-agent path, via super.call(), hit exactly
    // this). Gated on `incoming` so a NO-incoming agent turn — the opening
    // greeting, whose transcript is legitimately set on connect BEFORE this
    // drain — is NOT wiped. Single owner of per-turn transcript scoping for the
    // shared call() path.
    resetAgentTurnTranscript(adapter);
  }

  const merged = await drainAgentResponse(adapter, speakingEvent, () => {
    recorder.markAgentStart();
  });
  // #734 — bounded grace-wait for the pending transcript BEFORE the back-fill
  // reads it. Audio silence closed the turn above (`responseTailSilence`), but a
  // live voice agent (hosted ElevenLabs) sends the turn's text on a SEPARATE
  // socket event that can land AFTER the audio-silence boundary. Snapshotting
  // `lastAgentTranscript` at drain-close would then read `null` → the turn
  // reaches the text-only simulator as a bare `[audio message]` and it
  // fabricates. Wait (bounded) for the transcript event instead of racing it.
  // Gated on `merged` having audio: a no-audio turn is never labeled anyway
  // (attachAgentTurnTranscript short-circuits on empty data), so there is
  // nothing to wait for. awaitAgentTranscript itself short-circuits both when the
  // transcript is already present AND when the adapter does not expose the
  // `lastAgentTranscript` convention at all (Twilio/Pipecat/Composable) — so a
  // transcript-less adapter pays ZERO added latency here.
  if (merged.data.length > 0 && !merged.transcript) {
    await awaitAgentTranscript(adapter);
  }
  // Carry the agent turn's NATIVE transcript onto the chunk when the merged
  // audio has none (#705). A live voice agent (hosted ElevenLabs, Gemini Live,
  // OpenAI Realtime) streams raw PCM frames with NO per-chunk transcript but
  // exposes the turn's text on `lastAgentTranscript` (set from its
  // `agent_response`/transcript event). Without this, the assistant message AND
  // the recording segment reach LangWatch as audio-only — the "missing AUT
  // transcript" defect — and only the on-disk manifest got a (slower, lossy) STT
  // back-fill. Done BEFORE recordAgent so the recording segment carries it too.
  const spoken = attachAgentTurnTranscript(adapter, merged);
  recorder.recordAgent(spoken);
  // Single shared encoder (messages.ts) — the canonical AI-SDK `file` audio
  // part (EDR §4.2). createAudioMessage returns AudioMessage (= ModelMessage),
  // which is one of the AgentReturnTypes union members; no cast needed.
  return createAudioMessage(spoken, "assistant");
}

/**
 * Return a chunk carrying the agent turn's transcript: the chunk's own
 * transcript if present, else the adapter's `lastAgentTranscript` (the live
 * voice agent's native turn text — EL `agent_response`, Gemini/Realtime
 * transcript events). Returns the input chunk unchanged when neither is
 * available (the recording's STT back-fill then fills the on-disk manifest).
 *
 * Duck-typed on `lastAgentTranscript` rather than a base-class field so it
 * composes with every adapter that follows the harness convention
 * (see `voice/adapters/composable.ts`) without widening the base contract.
 */
function attachAgentTurnTranscript(
  adapter: VoiceAgentAdapter,
  chunk: AudioChunk,
): AudioChunk {
  // A turn that produced NO audio must not be labeled with a spoken transcript:
  // that would let a no-audio turn (e.g. the #708 "text arrived, audio did not"
  // case) masquerade as a real spoken turn downstream. Audio-presence gates the
  // label — the same stance as the USER-side audio-presence invariant.
  if (chunk.data.length === 0) return chunk;
  if (chunk.transcript) return chunk;
  const native = (adapter as { lastAgentTranscript?: string | null })
    .lastAgentTranscript;
  if (typeof native === "string" && native.length > 0) {
    return new AudioChunk({ data: chunk.data, transcript: native });
  }
  return chunk;
}

/**
 * Bounded grace-wait for the agent turn's native transcript (#734).
 *
 * Audio silence closes the turn in {@link drainAgentResponse}, but a live voice
 * agent (hosted ElevenLabs) delivers the turn's text on a SEPARATE socket event
 * (`agent_response` → `lastAgentTranscript`) that can land AFTER the audio
 * boundary. This polls `lastAgentTranscript` up to `adapter.transcriptGraceWait`
 * seconds so a transcript arriving within the window is present when
 * {@link attachAgentTurnTranscript} reads it.
 *
 * Short-circuits (returns immediately, no timer, ZERO added latency) when the
 * transcript is ALREADY set at entry — the common happy path where the
 * transcript won the race (AC3, no-regression). Bounded so a genuine
 * ElevenLabs drop (transcript never sent) still terminates the turn after the
 * ceiling. A `transcriptGraceWait` of 0 disables the wait entirely.
 *
 * Duck-typed on `lastAgentTranscript` (symmetric with the read/reset) so it
 * composes with every adapter following the harness convention without widening
 * the base contract.
 *
 * CRITICAL — only adapters that actually EXPOSE the `lastAgentTranscript`
 * convention are waited on. An adapter that does NOT declare the field
 * (Twilio/Pipecat return raw audio; Composable carries its text on a different
 * field) can never populate it, so waiting on it would burn the full
 * `transcriptGraceWait` ceiling EVERY turn for nothing — seconds of artificial
 * latency across a long `proceed()` run. For those, the property is absent and
 * we skip the wait entirely (property present-but-null → wait; property absent
 * → no wait). This is why the base-class default (2.0s) is safe to ship on the
 * shared `VoiceAgentAdapter`: it only ever costs a transcript-capable adapter.
 */
async function awaitAgentTranscript(adapter: VoiceAgentAdapter): Promise<void> {
  // Absent property → this adapter does not use the native-transcript convention;
  // waiting could never succeed, so skip (zero added latency). Present-but-null →
  // the transcript event is pending; fall through and wait for it.
  if (!("lastAgentTranscript" in (adapter as object))) return;

  const hasTranscript = (): boolean => {
    const native = (adapter as { lastAgentTranscript?: string | null })
      .lastAgentTranscript;
    return typeof native === "string" && native.length > 0;
  };
  if (hasTranscript()) return;

  const ceilingS = adapter.transcriptGraceWait ?? SAFE_DEFAULT_TRANSCRIPT_GRACE_WAIT_S;
  if (ceilingS <= 0) return;

  const deadline = Date.now() + ceilingS * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_GRACE_POLL_MS));
    if (hasTranscript()) return;
  }
}

/**
 * Null the adapter's `lastAgentTranscript` at agent-turn start so the back-fill
 * ({@link attachAgentTurnTranscript}) reads only the transcript produced during
 * THIS turn's drain. Duck-typed (symmetric with the read) — adapters that do not
 * expose the convention field are left untouched.
 */
function resetAgentTurnTranscript(adapter: VoiceAgentAdapter): void {
  if ("lastAgentTranscript" in (adapter as object)) {
    (adapter as { lastAgentTranscript?: string | null }).lastAgentTranscript =
      null;
  }
}

/**
 * #747 — reconcile prior-turn leftover audio at a user-turn boundary.
 *
 * A split utterance can strand audio in a buffering adapter's queue: a single
 * utterance longer than the drain's `2× responseMaxDuration` ceiling, or a rare
 * gap-split whose continuation lands after the turn already closed. Left alone,
 * the next {@link drainAgentResponse} shifts that leftover out as the fake first
 * audio of a new agent turn — the bleed #747 fixes.
 *
 * This runs at pre-user-`sendAudio`, BEFORE {@link AdapterRecorder.recordUser}.
 * The queue is drained UNCONDITIONALLY first — so stranded prior-turn audio can
 * never bleed out as the next drain's fake first audio, even on the cursor-unsafe
 * barge-in path (where a user segment is already last on the cursor). Only the
 * ATTRIBUTION of the drained audio is position-gated:
 *
 *  - Cursor-safe (a prior AGENT segment is still last on the byte cursor —
 *    recordUser has not laid the user segment yet, review M1 invariant): grow that
 *    segment. Extending its `endTime` + advancing the cursor cannot overlap a later
 *    segment. The grown bytes are ALSO routed through {@link fireAudioChunk} (so
 *    the `onAudioChunk` hook + live playback sink receive them, like every other
 *    recorded agent chunk) and the segment is flagged for the finalize STT
 *    back-fill (its existing transcript may not cover a gap-split continuation).
 *  - Cursor-unsafe (no recording, the opening greeting with no prior agent segment
 *    → AC8, or a barge-in where a user segment is last → AC9): the audio is already
 *    out of the queue (no bleed), so it is DROPPED with a warning rather than
 *    corrupting the append-only cursor by growing an out-of-order segment. The
 *    dropped tail is the post-interrupt remainder the barge-in cut off.
 *
 * Duck-typed on `reconcilePendingAudio` (symmetric with the `lastAgentTranscript`
 * convention): adapters without a buffered queue expose no such method and are
 * untouched (Twilio/Pipecat/composable/OpenAI-Realtime/Gemini).
 *
 * Known limitation: for a SINGLE continuous utterance exceeding the drain's `2×
 * responseMaxDuration` ceiling, frames the transport delivers AFTER this snapshot
 * (during the subsequent `sendAudio`) can still bleed — this reconcile is a
 * point-in-time drain, not a subscription. The realistic case (EL bursts a >30s
 * greeting; the un-chop consumes it whole via tail-silence) is fully covered.
 */
function reconcilePriorAgentAudio(
  adapter: VoiceAgentAdapter,
  state: VoiceExecutorState | null,
): void {
  const reconcile = (
    adapter as { reconcilePendingAudio?: () => AudioChunk | null }
  ).reconcilePendingAudio;
  if (typeof reconcile !== "function" || !state) return;
  // Drain the queue FIRST, unconditionally — this is what prevents the bleed. The
  // attribution below is best-effort and never gates the drain.
  const leftover = reconcile.call(adapter);
  if (!leftover || leftover.data.length === 0) return;

  const segments = state.voiceRecording?.segments;
  const last =
    segments && segments.length > 0
      ? segments[segments.length - 1]
      : undefined;
  // Attribute only when the prior AGENT segment is still last on the cursor.
  if (!last || last.speaker !== "agent") {
    logger.warn(
      "drained prior-turn leftover audio at a boundary where it cannot be " +
        "attributed cursor-safely (no prior agent segment, or a user segment is " +
        "last, e.g. barge-in) — dropped so it is not emitted as a fake next turn " +
        "(#747)",
      { droppedSeconds: leftover.durationSeconds },
    );
    return;
  }
  // Cursor-safe: deliver the reconciled bytes to the hooks/playback sink (parity
  // with recordAgent → fireAudioChunk), then grow the segment.
  fireAudioChunk(state, leftover);
  const oldEnd = last.endTime;
  const grown = new Uint8Array(last.audio.length + leftover.data.length);
  grown.set(last.audio, 0);
  grown.set(leftover.data, last.audio.length);
  last.audio = grown;
  last.endTime = oldEnd + leftover.durationSeconds;
  state.voiceAudioCursor = last.endTime;
  // The grown audio may carry speech the segment's transcript does not cover (a
  // gap-split continuation) — flag it so the finalize STT back-fill re-transcribes
  // it (the back-fill otherwise skips segments that already have a transcript).
  last.transcriptTruncated = true;
  // Keep the timeline consistent with the grown segment: recordAgent emitted
  // agent_stop_speaking at oldEnd, so move it to the new end (this reconcile grows
  // the segment out-of-band; re-establish the recordAgent endTime↔stop invariant).
  moveAgentStopSpeaking(state, oldEnd, last.endTime);
  logger.warn(
    "reconciled prior-turn leftover audio into the previous agent segment so it " +
      "is not emitted as a fake next turn (#747)",
    { reconciledSeconds: leftover.durationSeconds },
  );
}

/**
 * Move the most-recent `agent_stop_speaking` event from `oldTime` to `newTime`
 * (#747). {@link appendEvent} pushes the SAME event object to both
 * `voiceTimeline` and `voiceRecording.timeline`, so mutating it once via the
 * recording timeline updates both sinks. No-op if no matching event is found.
 */
function moveAgentStopSpeaking(
  state: VoiceExecutorState,
  oldTime: number,
  newTime: number,
): void {
  const timeline = state.voiceRecording?.timeline;
  if (!timeline) return;
  // `findLast` walks from the end, so this is the most-recent match — the same
  // event the old reverse scan settled on. It returns `VoiceEvent | undefined`,
  // which makes the check below a real guard rather than an assertion.
  const event = timeline.findLast(
    (candidate) =>
      candidate.type === "agent_stop_speaking" &&
      Math.abs(candidate.time - oldTime) < 1e-6,
  );
  if (event) event.time = newTime;
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
  // The runaway backstop that replaces the old mid-utterance chop (#747).
  const hardCeiling = maxDuration * MAX_DURATION_CEILING_FACTOR;

  const first = await adapter.receiveAudio(responseTimeout);
  if (first.data.length > 0) {
    onFirstChunk();
  }
  speakingEvent.set();

  const chunks: AudioChunk[] = [first];
  let accumulated = first.durationSeconds;
  let softCapWarned = false;
  // Warn ONCE the first time accumulated audio crosses the soft cap — covering a
  // first chunk that already exceeds it, not only later chunks.
  const maybeWarnSoftCap = (): void => {
    if (accumulated >= maxDuration && !softCapWarned) {
      softCapWarned = true;
      logger.warn(
        "agent turn exceeded responseMaxDuration; continuing to drain in-flight " +
          "audio so the utterance is not split across turns (#747)",
        { responseMaxDurationS: maxDuration, accumulatedS: accumulated },
      );
    }
  };
  maybeWarnSoftCap();
  // Drain until a REAL turn-end signal: tail-silence (the `catch`, the agent
  // stopped talking) or a terminal empty chunk. `responseMaxDuration` no longer
  // ends the loop — it only warns — so already-arriving audio for a single long
  // utterance is not abandoned in the adapter's queue to bleed into the next turn
  // (#747). The hard ceiling still bounds a transport that never goes silent.
  while (accumulated < hardCeiling) {
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
    maybeWarnSoftCap();
  }
  if (accumulated >= hardCeiling) {
    // Reached the absolute ceiling without a tail-silence / terminal signal — a
    // transport that never signalled end-of-stream. Bounded + warned, never a
    // silent cap and never an infinite wedge (AC4b).
    logger.warn(
      "agent turn hit the absolute audio ceiling; terminating the drain (the " +
        "transport never signalled end-of-stream)",
      { ceilingS: hardCeiling, responseMaxDurationS: maxDuration },
    );
  }
  return mergeChunks(chunks);
}

function mergeChunks(chunks: AudioChunk[]): AudioChunk {
  if (chunks.length === 1) return chunks[0];
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

/**
 * Append a {@link VoiceEvent} to all active sinks: `voiceTimeline`,
 * `voiceRecording.timeline`, and the `onVoiceEvent` hook (best-effort —
 * hook errors are swallowed so observability code can never break a test).
 *
 * Canonical writer for voice timeline events — the barge-in paths in
 * `scenario-execution.ts` import this instead of inlining the 3-part
 * push/timeline/hook sequence. Issue #576.
 */
export function appendEvent(state: VoiceExecutorState, event: VoiceEvent): void {
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
  // Fan-out 1: per-run onAudioChunk hook (ScenarioConfig.onAudioChunk).
  const hook = state.onAudioChunk;
  if (hook) {
    try {
      hook(chunk);
    } catch {
      // Same swallow rationale as appendEvent — hooks are best-effort.
    }
  }
  // Fan-out 2: live local-speaker playback sink (audioPlayback === true).
  const sink = state.audioPlaybackSink;
  if (sink) {
    try {
      sink.sendChunk(chunk);
    } catch {
      // Best-effort — playback errors must not interrupt the scenario.
    }
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
  // Publish onto the adapter so the executor's barge-in path
  // (`fireUserInterrupt` → `adapter.agentSpeakingEvent`) can WAIT for the
  // agent to actually start speaking before firing the interrupt. Without
  // this the field stayed `undefined` on every adapter and barge-ins fired
  // "before speech" — nothing to cut off (issue #372 hollow-interrupt fix).
  // Mirrors Python's base-adapter `_agent_speaking_event` (adapter.py:66).
  // Unconditional assignment is idempotent (same reference on re-entry), so no
  // identity guard is needed (review H8).
  adapter.agentSpeakingEvent = event;
  return event;
}

/** Re-export so tests importing the runtime get a silent chunk helper too. */
export { silentChunk };
