import { MessagesSnapshotEvent } from "@ag-ui/core";
import { ModelMessage } from "ai";

import { generateMessageId } from "./ids";

type AgUiMessage = MessagesSnapshotEvent["messages"][number];

/**
 * Converts an array of ModelMessage (from 'ai') to an array of AG-UI compliant messages.
 * Handles splitting tool messages, extracting tool calls, and mapping/coercing fields.
 *
 * Audio content normalisation:
 *   The canonical in-process audio shape is the AI-SDK `file` part
 *   (`{ type: "file", mediaType: "audio/...", data: <base64> }`) — see
 *   `voice/messages.ts:createAudioMessage`. The langwatch ingest endpoint
 *   externalises inline audio via a content-extractor that recognises the
 *   OpenAI Realtime `input_audio` shape but NOT the AI-SDK `file` shape; if
 *   we wired up `file` content as-is and just JSON-stringified it, the
 *   base64 bytes flowed straight through to ClickHouse `Messages.Content`
 *   and back to the list-page response (the 90 MB getSuiteRunData bug).
 *
 *   Two changes pin the fix together:
 *     1. Translate `file`+audio parts → `input_audio` shape so the backend
 *        extractor's existing handler externalises them to stored-objects.
 *     2. Stop pre-stringifying array content so the extractor — which walks
 *        array content only — actually gets a chance to run.
 *
 *   The langwatch ingest schema accepts both string and array content via
 *   `chatMessageSchema.content: union(string, array(chatRichContent))`, so
 *   passing arrays through is compatible with the wire contract. AG-UI's
 *   stricter `string`-only typing is bypassed with a cast at the conversion
 *   boundary.
 *
 * @param modelMessages - Array of ModelMessage from 'ai'
 * @returns Array of AG-UI messages (user, assistant, system, tool)
 */
export function convertModelMessagesToAguiMessages(
  modelMessages: (ModelMessage & { id?: string; traceId?: string })[]
): AgUiMessage[] {
  const aguiMessages: (AgUiMessage & { trace_id?: string })[] = [];

  for (const msg of modelMessages) {
    const id =
      "id" in msg && typeof msg.id === "string" ? msg.id : generateMessageId();

    switch (true) {
      case msg.role === "system":
        aguiMessages.push({
          trace_id: msg.traceId,
          id: id,
          role: "system",
          content: msg.content,
        });
        break;

      case msg.role === "user" && typeof msg.content === "string":
        aguiMessages.push({
          trace_id: msg.traceId,
          id: id,
          role: "user",
          content: msg.content,
        });
        break;

      case msg.role === "user" && Array.isArray(msg.content):
        aguiMessages.push({
          trace_id: msg.traceId,
          id: id,
          role: "user",
          content: normalizeContentParts(msg.content) as unknown as string,
        });
        break;

      case msg.role === "assistant" && typeof msg.content === "string":
        aguiMessages.push({
          trace_id: msg.traceId,
          id: id,
          role: "assistant",
          content: msg.content,
        });
        break;

      case msg.role === "assistant" && Array.isArray(msg.content): {
        const toolCalls = msg.content.filter((p) => p.type === "tool-call");
        const nonToolCalls = msg.content.filter((p) => p.type !== "tool-call");

        aguiMessages.push({
          trace_id: msg.traceId,
          id: id,
          role: "assistant",
          content: normalizeContentParts(nonToolCalls) as unknown as string,
          toolCalls: toolCalls.map((c) => ({
            id: c.toolCallId,
            type: "function",
            function: {
              name: c.toolName,
              arguments: JSON.stringify(c.input),
            },
          })),
        });

        break;
      }

      case msg.role === "tool":
        msg.content.map((p, i) => {
          if ("type" in p && p.type !== "tool-result") return;
          aguiMessages.push({
            trace_id: msg.traceId,
            id: `${id}-${i}`,
            role: "tool",
            toolCallId: p.toolCallId,
            content: JSON.stringify(
              p.output && "value" in p.output ? p.output.value : p.output
            ),
          });
        });
        break;

      default:
        throw new Error(`Unsupported message role: ${msg.role}`);
    }
  }

  return aguiMessages;
}

/**
 * Normalise an AI-SDK content-part array for AG-UI transport.
 *
 * - Translates AI-SDK `file`+`audio/*` parts to OpenAI Realtime `input_audio`
 *   shape so the langwatch ingest content-extractor externalises the bytes
 *   to stored-objects instead of persisting them inline.
 * - Collapses a single bare text part to a plain string (matches the pure-
 *   text fast path of older callers; keeps preview payloads small).
 * - Otherwise returns the (possibly translated) array as-is — the langwatch
 *   ingest schema accepts array content; consumers downstream walk it.
 *
 * Returns `unknown` because AG-UI's `content` is typed as `string`; callers
 * cast at the boundary. The runtime payload is valid per
 * `chatMessageSchema.content`.
 */
function normalizeContentParts(parts: readonly unknown[]): unknown {
  const translated = parts.map(translateAudioFilePart);

  if (
    translated.length === 1 &&
    isRecord(translated[0]) &&
    translated[0].type === "text" &&
    typeof translated[0].text === "string"
  ) {
    return translated[0].text;
  }

  return translated;
}

/**
 * Map an AI-SDK file part with an `audio/*` mediaType into the OpenAI
 * Realtime `input_audio` shape:
 *
 *   { type:"file", mediaType:"audio/wav", data:"<b64>" }
 *     →
 *   { type:"input_audio", input_audio:{ data:"<b64>", format:"wav", mimeType:"audio/wav" } }
 *
 * Non-audio parts pass through unchanged.
 *
 * Special case — raw `audio/pcm16`: the SDK carries in-message audio as raw
 * headerless PCM16 (the single internal format, see `voice/messages.ts`;
 * deliberately NOT WAV to keep one encoder/extractor pair). But raw PCM is
 * undecodable by a browser `<audio>` element, so the LangWatch simulations UI
 * renders an `[error]` badge instead of a player. At THIS langwatch-bound
 * boundary only, wrap the PCM in a WAV container and ship it as `audio/wav`
 * (matches the Python twin's shipped shape, `voice/messages.py` → `format:"wav"`).
 * The SDK's internal raw-PCM16 contract is untouched.
 */
function translateAudioFilePart(part: unknown): unknown {
  if (!isRecord(part)) return part;
  if (part.type !== "file") return part;
  const mediaType = part.mediaType;
  if (typeof mediaType !== "string" || !mediaType.startsWith("audio/")) {
    return part;
  }
  const data = part.data;
  if (typeof data !== "string") return part;

  // Raw PCM16 is not browser-playable; WAV-wrap it for the LangWatch app.
  if (mediaType === "audio/pcm16") {
    return {
      type: "input_audio",
      input_audio: {
        data: pcm16Base64ToWavBase64(data),
        format: "wav",
        mimeType: "audio/wav",
      },
    };
  }

  return {
    type: "input_audio",
    input_audio: {
      data,
      format: mediaTypeToFormat(mediaType),
      mimeType: mediaType,
    },
  };
}

// Canonical PCM16 recording format (24kHz / mono / 16-bit) — matches the SDK's
// AudioChunk contract and the Python twin's `_pcm16_to_wav_bytes`.
const PCM16_SAMPLE_RATE = 24000;
const PCM16_CHANNELS = 1;
const PCM16_SAMPLE_WIDTH_BYTES = 2;

/**
 * Wrap base64 raw PCM16 in a minimal 44-byte RIFF/WAVE container and return it
 * base64-encoded. Byte-identical to Python's `wave.open(...)` output for the
 * canonical format, so a browser `<audio>` element can decode it.
 */
function pcm16Base64ToWavBase64(pcmBase64: string): string {
  const pcm = Buffer.from(pcmBase64, "base64");
  const blockAlign = PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const byteRate = PCM16_SAMPLE_RATE * blockAlign;
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16); // PCM fmt chunk size
  out.writeUInt16LE(1, 20); // AudioFormat = PCM
  out.writeUInt16LE(PCM16_CHANNELS, 22);
  out.writeUInt32LE(PCM16_SAMPLE_RATE, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(PCM16_SAMPLE_WIDTH_BYTES * 8, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out.toString("base64");
}

function mediaTypeToFormat(mediaType: string): string | undefined {
  switch (mediaType) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/flac":
      return "flac";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default convertModelMessagesToAguiMessages;
