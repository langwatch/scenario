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

/** Arguments for the shared {@link transcribeAudioMessages} STT pre-pass. */
export interface TranscribeAudioMessagesArgs {
  /** Conversation history to transcribe over. */
  messages: readonly ModelMessage[];
  /** Per-run STT provider (from the resolved `cfg.voice.stt`). */
  stt: STTProvider;
  /**
   * Keep the raw audio `file` part alongside the transcribed text when true;
   * drop it (text-only) when false. Judge passes its multimodal knob here; the
   * user-simulator passes `true` so `stripAudioContent`'s echo-safety reframing
   * (which keys on a message having BOTH audio and text) still triggers.
   */
  includeAudio: boolean;
  /**
   * Optional cross-call transcript cache keyed by a STABLE audio key (the raw
   * audio payload). Prevents re-transcribing the SAME audio on every call.
   *
   * The judge builds a transcript once per verdict and passes no cache. The
   * user-simulator's STT fallback, by contrast, re-runs over the WHOLE history
   * on EVERY `proceed()` turn: without a cache, an audio-only agent turn that
   * stays in history is transcribed on turn N, again on N+1, N+2, … turning a
   * single dropped `agent_response` into O(turns^2) STT calls (#735 P2). The
   * simulator passes a per-instance Map so each distinct audio chunk hits the
   * provider at most once for the life of the simulator instance.
   */
  transcriptCache?: Map<string, string>;
  /** Warning sink — defaults to {@link console.warn}. */
  logWarn?: (message: string) => void;
}

/**
 * Shared STT pre-pass (#734): for every message carrying audio, attach the
 * spoken words as a `{ type: "text" }` part — reusing an existing text sibling
 * when present, else transcribing the audio chunk via the resolved
 * {@link STTProvider}. Optionally keeps or drops the raw audio part.
 *
 * This is the single implementation behind BOTH the judge's
 * {@link prepareJudgeInput} pre-pass and the user-simulator's STT fallback: EL
 * can fail to send `agent_response` for a turn, leaving the simulator with a
 * bare `[audio message]`; running this before `stripAudioContent` gives the
 * text-only simulator real words instead. Extracting it here keeps the STT
 * plumbing in ONE place rather than duplicating it into the simulator.
 *
 * The input array is never mutated — a new message list is returned. STT
 * failures degrade gracefully (audio dropped on the text-only path, a warning
 * logged) so the caller still processes the rest of the conversation.
 */
export async function transcribeAudioMessages(
  args: TranscribeAudioMessagesArgs,
): Promise<ModelMessage[]> {
  const { messages, stt, includeAudio, transcriptCache } = args;
  const warn = args.logWarn ?? ((m: string) => console.warn(m));
  return Promise.all(
    messages.map((msg) =>
      transcribeMessage(msg, stt, includeAudio, warn, transcriptCache),
    ),
  );
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
  const messages = await transcribeAudioMessages({
    messages: args.messages,
    stt: args.stt,
    includeAudio: args.options?.includeAudio ?? false,
    logWarn: args.logWarn,
  });
  return { messages };
}

/**
 * Stable cache key for an audio message: the raw base64 payload of its first
 * audio `file` part. The same audio chunk re-sent across `proceed()` turns
 * carries an identical payload, so this key collapses repeat transcription of
 * one chunk to a single STT call (#735 P2). Returns `null` for the legacy
 * `input_audio`/`audio` shapes (no cache — those are adapter-edge and rare).
 */
function audioCacheKey(content: readonly unknown[]): string | null {
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    if (
      part["type"] === "file" &&
      typeof part["mediaType"] === "string" &&
      (part["mediaType"] as string).startsWith("audio/") &&
      typeof part["data"] === "string"
    ) {
      return part["data"] as string;
    }
  }
  return null;
}

async function transcribeMessage(
  msg: ModelMessage,
  stt: STTProvider,
  includeAudio: boolean,
  warn: (message: string) => void,
  transcriptCache?: Map<string, string>,
): Promise<ModelMessage> {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;
  if (!content.some(isAudioFilePart)) return msg;

  // Resolve a transcript: prefer an existing text part, else the cross-call
  // cache, else run STT (and cache the result).
  let transcript: string | undefined;
  if (hasTextPart(content)) {
    // buildTranscriptFromMessages already reads the existing text part; keep
    // the message text intact and only adjust audio passthrough below.
    transcript = undefined; // sentinel — no new text part needed
  } else {
    const cacheKey = transcriptCache ? audioCacheKey(content) : null;
    if (cacheKey !== null && transcriptCache!.has(cacheKey)) {
      // Same audio already transcribed on an earlier call — reuse, no STT.
      transcript = transcriptCache!.get(cacheKey) || undefined;
    } else {
      const chunk = extractAudioChunk(msg);
      if (chunk) {
        try {
          transcript = (await stt.transcribe(chunk)) || undefined;
          // Cache whenever STT actually RAN and RETURNED — including an empty
          // result. `""` is the negative sentinel: the reuse branch above turns
          // a cached `""` back into `undefined` (no text part), so remembering
          // an empty transcript is correct AND stops the same dead chunk from
          // re-hitting STT on every later proceed() turn (#735 P2). A different
          // (good) transcript can only come from different bytes → a different
          // key, so the sentinel can never suppress a real transcript.
          if (cacheKey !== null) {
            transcriptCache!.set(cacheKey, transcript ?? "");
          }
        } catch (e) {
          // Remember the failure too: without this, a provider outage is
          // re-attempted for the SAME chunk on every subsequent call (#735 P2).
          if (cacheKey !== null) {
            transcriptCache!.set(cacheKey, "");
          }
          warn(
            `scenario.voice.judge-stt: STT failed for a ${String(
              (msg as { role?: unknown }).role ?? "?",
            )} audio message; dropping audio and continuing text-only: ` +
              `${(e as Error).message ?? e}`,
          );
        }
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
