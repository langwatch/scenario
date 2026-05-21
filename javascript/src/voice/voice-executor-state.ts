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
import type { InterruptionConfig } from "./interruption";
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
}
