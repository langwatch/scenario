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
 * One timestamped event on the voice conversation timeline.
 *
 * Types include: `user_start_speaking`, `user_stop_speaking`,
 * `agent_start_speaking`, `agent_stop_speaking`, `tool_call`, `tool_result`,
 * `user_interrupt`.
 *
 * `latency` is populated for `agent_start_speaking` events and measures the
 * response time from the preceding `user_stop_speaking` event.
 *
 * `metadata` is a free-form dict for type-specific context. Examples:
 * - `user_interrupt`: `{ adapter: "PipecatAgentAdapter", native: true }`
 * - `tool_call`: `{ call_id: "..." }`
 */
export interface VoiceEvent {
  time: number;
  type: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  latency?: number;
  metadata?: Record<string, unknown>;
}

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
