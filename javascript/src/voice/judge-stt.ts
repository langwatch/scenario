/**
 * Judge STT pre-pass — the seam that hooks automatic transcription into the
 * judge path BEFORE `JudgeUtils.buildTranscriptFromMessages` (EDR §3.3 / §7.7).
 *
 * The judge does NOT "request a transcript" (there is no such tool — §7.3):
 * STT is automatic and upstream. When a voice conversation reaches the judge,
 * this pass walks the messages, transcribes any audio `file` part that lacks
 * a sibling transcript (using the per-run resolved STT provider off
 * `cfg.voice.stt`), and attaches the transcript as a `{ type: "text" }` part
 * so the judge's text path reads spoken words instead of a byte-marker.
 *
 * Audio passthrough vs. text-only:
 * - When `includeAudio` is true (multimodal judge model), the audio `file`
 *   part is KEPT alongside the transcript — the model can hear tone/prosody.
 * - When `includeAudio` is false (text-only model, or `include_audio=False`),
 *   the audio `file` part is STRIPPED, leaving only the transcript text — the
 *   judge evaluates content without the (unusable, token-heavy) audio bytes.
 *
 * Net-new in `src` (the PRD's `wrapJudgeForAudioTranscription` was only ever a
 * committed example helper, never a library API — §3.3). Does NOT run STT
 * itself in a bespoke way — it delegates per chunk to the `STTProvider`; does
 * NOT format the timeline string (the recorder owns that); no verdict.
 */

import type { ModelMessage } from "ai";

import { AudioChunk } from "./audio-chunk";
import { extractAudio } from "./messages";
import type { STTProvider } from "./stt";

/** Judge audio knobs (PRD §4.3) — resolved upstream, passed in here. */
export interface JudgeAudioOptions {
  /** Keep raw audio parts for a multimodal judge model. Default: false. */
  includeAudio?: boolean;
}

/** Output of {@link prepareJudgeInput}: messages the judge agent consumes. */
export interface JudgePreparedInput {
  /** Messages with audio transcribed to text (+ audio kept iff includeAudio). */
  messages: ModelMessage[];
}

interface PrepareJudgeInputArgs {
  /** The conversation history reaching the judge. */
  messages: readonly ModelMessage[];
  /** Per-run STT provider (from the resolved `cfg.voice.stt`). */
  stt: STTProvider;
  /** Resolved judge audio knobs. */
  options?: JudgeAudioOptions;
  /** Warning sink — defaults to {@link console.warn}. */
  logWarn?: (message: string) => void;
}

function isAudioFilePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (
    p["type"] === "file" &&
    typeof p["mediaType"] === "string" &&
    (p["mediaType"] as string).startsWith("audio/")
  ) {
    return true;
  }
  return p["type"] === "input_audio" || p["type"] === "audio";
}

function hasTextPart(content: readonly unknown[]): boolean {
  return content.some(
    (p) =>
      p &&
      typeof p === "object" &&
      (p as Record<string, unknown>)["type"] === "text" &&
      typeof (p as Record<string, unknown>)["text"] === "string" &&
      ((p as Record<string, unknown>)["text"] as string).length > 0,
  );
}

/**
 * Run the automatic STT pre-pass over a judge's input messages.
 *
 * For every message carrying audio:
 * 1. If it already has a non-empty text part, reuse it (no STT call).
 * 2. Otherwise transcribe the audio chunk via the resolved {@link STTProvider}
 *    and prepend a `{ type: "text", text }` part.
 * 3. When `includeAudio` is false, drop the audio `file` part(s) so only text
 *    survives; when true, keep them for a multimodal model.
 *
 * Non-audio messages pass through untouched. STT failures degrade
 * gracefully — the audio part is dropped (text-only path) and a warning is
 * logged; the judge still evaluates the rest of the conversation. The input
 * array is never mutated — a new message list is returned.
 */
export async function prepareJudgeInput(
  args: PrepareJudgeInputArgs,
): Promise<JudgePreparedInput> {
  const { messages, stt, options } = args;
  const includeAudio = options?.includeAudio ?? false;
  const warn = args.logWarn ?? ((m: string) => console.warn(m));

  const out = await Promise.all(
    messages.map((msg) => transcribeMessage(msg, stt, includeAudio, warn)),
  );
  return { messages: out };
}

async function transcribeMessage(
  msg: ModelMessage,
  stt: STTProvider,
  includeAudio: boolean,
  warn: (message: string) => void,
): Promise<ModelMessage> {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;
  if (!content.some(isAudioFilePart)) return msg;

  // Resolve a transcript: prefer an existing text part, else run STT.
  let transcript: string | undefined;
  if (hasTextPart(content)) {
    // buildTranscriptFromMessages already reads the existing text part; keep
    // the message text intact and only adjust audio passthrough below.
    transcript = undefined; // sentinel — no new text part needed
  } else {
    const chunk = extractAudioChunk(msg);
    if (chunk) {
      try {
        transcript = (await stt.transcribe(chunk)) || undefined;
      } catch (e) {
        warn(
          `scenario.voice.judge-stt: STT failed for a ${String(
            (msg as { role?: unknown }).role ?? "?",
          )} audio message; dropping audio and continuing text-only: ` +
            `${(e as Error).message ?? e}`,
        );
      }
    }
  }

  const rebuilt: unknown[] = [];
  if (transcript) {
    rebuilt.push({ type: "text", text: transcript });
  }
  for (const part of content) {
    if (isAudioFilePart(part)) {
      if (includeAudio) rebuilt.push(part);
      // else: drop the audio bytes (text-only judge path)
      continue;
    }
    rebuilt.push(part);
  }

  return { ...(msg as object), content: rebuilt } as ModelMessage;
}

/** Pull the first audio chunk from a message via the shared gateway. */
function extractAudioChunk(msg: ModelMessage): AudioChunk | null {
  try {
    return extractAudio(msg);
  } catch {
    return null;
  }
}
