/**
 * Audio types and utilities for voice-first-class support in Scenario.
 *
 * Provides core types for representing audio data and utilities for
 * loading, encoding, and converting audio between formats.
 */

/**
 * Supported audio MIME types.
 */
export type AudioMimeType =
  | "audio/wav"
  | "audio/mp3"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/webm"
  | "audio/pcm";

/**
 * Supported TTS voice options.
 * Based on OpenAI TTS voices.
 */
export type Voice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

/**
 * Represents audio data with metadata.
 */
export interface AudioData {
  /**
   * Base64-encoded audio data.
   */
  data: string;

  /**
   * Media type of the audio (MIME type).
   * Uses 'mediaType' to match AI SDK conventions.
   */
  mediaType: AudioMimeType;

  /**
   * Optional transcript of the audio content.
   */
  transcript?: string;

  /**
   * Optional duration in milliseconds.
   */
  durationMs?: number;
}

/**
 * Options for text-to-speech conversion.
 */
export interface TextToSpeechOptions {
  /**
   * Voice to use for synthesis.
   * @default "nova"
   */
  voice?: Voice;

  /**
   * Output audio format.
   * @default "wav"
   */
  format?: "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm";
}

/**
 * Options for the audio script step.
 */
export interface AudioStepOptions {
  /**
   * Role for the audio message.
   */
  role: "user" | "assistant";

  /**
   * Voice to use for TTS (when text is provided).
   */
  voice?: Voice;
}

/**
 * Input types for the audio script step.
 */
export type AudioInput =
  | string // file path
  | AudioData // raw audio data
  | { text: string; voice?: Voice }; // TTS input

