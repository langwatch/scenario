/**
 * Voice recording, timeline events, and latency metrics — type contracts only.
 *
 * PR1 ships the type surface; PR2+ adds the runtime that populates these
 * (writing segments + events on each adapter turn, computing latencies,
 * saving WAV/MP3 via ffmpeg). Python parity: `python/scenario/voice/recording.py`.
 *
 * These are the output-side types attached to a `ScenarioResult` for voice
 * runs: `result.audio` (a {@link VoiceRecording}), `result.timeline` (a
 * `VoiceEvent[]`), and `result.latency` (a {@link LatencyMetrics}).
 */

export type SpeakerRole = "user" | "agent";

/**
 * A contiguous span of audio attributed to one speaker.
 *
 * `transcriptTruncated` is true when an agent segment was cut short by a
 * `user_interrupt` event during the run — the audio bytes are
 * authoritative; the transcript may reflect what the agent INTENDED to say,
 * not what the user actually heard.
 */
export interface AudioSegment {
  speaker: SpeakerRole;
  startTime: number;
  endTime: number;
  /** PCM16 little-endian bytes, mono, 24kHz. */
  audio: Uint8Array;
  transcript?: string;
  transcriptTruncated?: boolean;
}

/**
 * All legal discriminant values for a {@link VoiceEvent}.
 *
 * - `user_start_speaking` / `user_stop_speaking` — VAD-detected user speech
 *   boundaries.
 * - `agent_start_speaking` / `agent_stop_speaking` — TTS/stream playback
 *   boundaries for the agent.
 * - `user_interrupt` — user barged in mid-agent-utterance.
 */
export type VoiceEventType =
  | "user_start_speaking"
  | "user_stop_speaking"
  | "agent_start_speaking"
  | "agent_stop_speaking"
  | "user_interrupt";

/** Base fields shared by every {@link VoiceEvent} variant. */
interface VoiceEventBase {
  /** Byte-accurate audio cursor position in seconds at the moment of the event. */
  time: number;
  /** Optional free-form context; semantics are variant-specific. */
  metadata?: Record<string, unknown>;
}

/**
 * Events that carry only `time` + optional `metadata` — no extra fields.
 *
 * Groups user VAD boundaries (`user_start_speaking`, `user_stop_speaking`)
 * with `agent_stop_speaking` (agent-side), all of which share the same
 * timestamp-only shape. Named for the shape rather than a single event kind
 * to avoid the misleading "speaking boundary" label that previously mixed
 * user-VAD and agent-side events under one concept.
 */
interface VoiceEventTimestampOnly extends VoiceEventBase {
  type:
    | "user_start_speaking"
    | "user_stop_speaking"
    | "agent_stop_speaking";
}

/**
 * Agent speech start — carries the response-time latency measured from the
 * preceding `user_stop_speaking` event on the same audio clock.
 */
interface VoiceEventAgentStart extends VoiceEventBase {
  type: "agent_start_speaking";
  /** Response latency in seconds from preceding user stop; undefined when unmeasurable. */
  latency?: number;
}

/**
 * User barge-in. `metadata` typically carries `{ source, native, outcome }`.
 * Example: `{ source: "barge-in", native: true, outcome: "fired_after_speech" }`.
 */
interface VoiceEventUserInterrupt extends VoiceEventBase {
  type: "user_interrupt";
}

/**
 * One timestamped event on the voice conversation timeline.
 *
 * This is a discriminated union — narrow on `event.type` to access
 * variant-specific fields like `latency` (agent_start_speaking).
 *
 * Common `metadata` fields by type:
 * - `user_interrupt`: `{ adapter: "PipecatAgentAdapter", native: true }`
 * - `user_start_speaking` / `user_stop_speaking` (VAD fallback): `{ source: "vad-fallback" }`
 */
export type VoiceEvent =
  | VoiceEventTimestampOnly
  | VoiceEventAgentStart
  | VoiceEventUserInterrupt;

/** Summary of agent response timing across the conversation. */
export interface LatencyMetrics {
  measurements: number[];
  timeToFirstByte?: number;
  interruptResponseTime?: number;
  /** Mean of `measurements`; undefined when no measurements recorded. */
  avgResponseTime?: number;
  /** Median of `measurements`. */
  p50ResponseTime?: number;
  /** 95th percentile of `measurements` (ceiling-style index). */
  p95ResponseTime?: number;
}

/**
 * The full audio record of a voice scenario, segmented by speaker.
 *
 * PR1 defines the contract; PR2+ adds the WAV/MP3 save methods, segment
 * directory layout, and JSON manifest schema (see Python `VoiceRecording`
 * for the eventual API).
 */
export interface VoiceRecording {
  segments: AudioSegment[];
  timeline: VoiceEvent[];
  /** Total duration (max segment endTime) in seconds. */
  duration?: number;
}
