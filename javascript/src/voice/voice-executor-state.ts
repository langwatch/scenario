/**
 * Voice executor state contract (Decision 1(b) — see issue #372).
 *
 * Python `python/scenario/voice/adapter.py` reaches into the executor via
 * 6 untyped `getattr(executor, "_voice_*", None)` indirections. Duck-typing
 * collapses in TS, so we commit explicitly to the shape that the executor
 * must expose to the voice subsystem.
 *
 * Concrete `ScenarioExecutor` implementations satisfy this interface
 * structurally — no nominal `implements`, no inheritance change required.
 * The voice adapter and recorder read these properties through this typed
 * surface instead of `(executor as any)._voiceRecording`.
 */

import type { AudioChunk } from "./audio-chunk";
import type { ResolvedVoiceConfig } from "./config";
import type { InterruptionConfig } from "./interruption";
import type { AudioPlaybackSink } from "./playback";
import type {
  LatencyMetrics,
  VoiceEvent,
  VoiceRecording,
} from "./recording.types";

export interface VoiceBackgroundNoise {
  source: string;
  volume: number;
}

export interface VoiceExecutorState {
  voiceRecording: VoiceRecording | null;
  voiceTimeline: VoiceEvent[] | null;
  voiceLatency: LatencyMetrics | null;
  /** `performance.now()` (or equivalent monotonic clock) anchor in seconds. */
  voiceRecordingStartedAt: number | null;
  /**
   * Byte-accurate audio cursor in seconds — the cumulative PCM byte-duration
   * of every segment recorded so far. Segments are laid end-to-end on this
   * cursor (not on wall-clock) so a segment's `endTime - startTime` equals its
   * true audio length and `recording.duration` equals the `full.wav`
   * byte-duration — independent of in-process send latency (review M1).
   * Latency is measured separately from the wall-clock marks the recorder
   * keeps, so the response-time signal is preserved. `undefined`/`null` before
   * the first segment (treated as 0).
   */
  voiceAudioCursor?: number | null;
  /**
   * The resolved per-run voice config (ADR-002, Gap #7). Populated at run
   * start from `cfg.voice` via `resolveVoiceConfig` when at least one voice
   * adapter is present. The judge's STT pass and the user-simulator's TTS
   * pass read the resolved provider/knobs here — never a module global.
   * `null` when the run has no voice config.
   */
  voiceConfig?: ResolvedVoiceConfig | null;
  /**
   * Interruption configuration declared by `voiceProceed({ interruptions })`.
   * The executor reads this at the top of each turn during `proceed()` and
   * decides whether to fire a barge-in.
   */
  voiceInterruptions?: InterruptionConfig;
  /**
   * Background ambience declared by `backgroundNoise(source, volume)`. The
   * audio-effects subsystem reads this when mixing user-simulator audio.
   */
  voiceBackgroundNoise?: VoiceBackgroundNoise;
  onVoiceEvent?: (event: VoiceEvent) => void;
  onAudioChunk?: (chunk: AudioChunk) => void;
  /**
   * Live local-speaker playback sink. Populated by the executor when
   * `audioPlayback === true` (per-run `run({ voice: { audioPlayback } })` wins
   * over module-global `configure({ audioPlayback })` per ADR-002). Each
   * agent/user audio chunk is fanned out here alongside the recording.
   *
   * `undefined` when audioPlayback is disabled; `null` after `close()` is
   * called at the end of a run.
   */
  audioPlaybackSink?: AudioPlaybackSink | null;
}
