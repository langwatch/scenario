/**
 * Audio message type surface — the ONE in-message audio format.
 *
 * Per EDR §4.2 the voice subsystem standardizes on the **AI-SDK `file`
 * part** as the in-message representation: `{ type: "file", mediaType:
 * "audio/pcm16", data: <base64> }`. This is the shape the runtime and the
 * judge's `buildTranscriptFromMessages` (`judge-utils.ts`) already handle,
 * and the shape the realtime path already emits
 * (`realtime/response-formatter.ts`). OpenAI-convention `input_audio` /
 * `audio` shapes are *adapter-edge* conversions only — they do not flow
 * through the execution loop.
 *
 * Types only — no conversion logic (that lives in `messages.ts`), no
 * runtime import cycle.
 */

import type { FilePart, ModelMessage, TextPart } from "ai";

/** An AI-SDK `file` part whose media type is an `audio/*` subtype. */
export type AudioFilePart = FilePart & { mediaType: `audio/${string}` };

/** A plain text content part (transcript or instruction). */
export type AudioTextPart = TextPart;

/** The parts an audio message carries: the audio file part + optional transcript. */
export interface AudioMessageParts {
  /** The canonical audio `file` part. */
  audio: AudioFilePart;
  /** Optional transcript text part (emitted before the audio part). */
  transcript?: AudioTextPart;
}

/**
 * An audio message is just a {@link ModelMessage} — audio rides in any role
 * (user / assistant / tool) as a `file` content part. No `forceUserRole`
 * workaround, no bespoke message shape.
 */
export type AudioMessage = ModelMessage;

/** Roles audio messages may flow under — every role, no forceUserRole. */
export type AudioMessageRole = "system" | "user" | "assistant" | "tool";
