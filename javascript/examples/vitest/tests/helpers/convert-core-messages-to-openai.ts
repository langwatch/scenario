import { CoreMessage } from "ai";
import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.mjs";

// =============================================================================
// CONSTANTS AND TYPES
// =============================================================================

/**
 * OpenAI supported audio formats for input_audio
 */
type OpenAIAudioFormat = "wav" | "mp3";

/**
 * Comprehensive mapping from MIME types to OpenAI audio formats
 * Follows RFC 6838 standard for media type naming
 */
const MIME_TYPE_TO_OPENAI_FORMAT: Record<string, OpenAIAudioFormat> = {
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpeg3": "mp3",
  "audio/x-mpeg-3": "mp3",
} as const;

/**
 * Audio file part type definition
 */
type AudioFilePart = {
  type: "file";
  mimeType: string;
  data: string;
};

/**
 * Error messages for consistent error handling
 */
const ERROR_MESSAGES = {
  INVALID_INPUT: "Input must be an array of CoreMessage objects",
  INVALID_MESSAGE: "Invalid CoreMessage: missing role or content",
  INVALID_MIME_TYPE: "MIME type must be a non-empty string",
  UNSUPPORTED_MEDIA_TYPE: (mimeType: string) =>
    `Unsupported media type: ${mimeType}. Only audio types are supported.`,
  UNSUPPORTED_AUDIO_TYPE: (mimeType: string, supportedTypes: string) =>
    `Unsupported audio MIME type: ${mimeType}. Supported types: ${supportedTypes}`,
} as const;

// =============================================================================
// TYPE GUARDS AND VALIDATION
// =============================================================================

/**
 * Type guard to check if a content part is an audio file part
 *
 * @param part - Unknown content part to check
 * @returns true if part is an audio file part
 */
export function isAudioFilePart(part: unknown): part is AudioFilePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "file" &&
    "mimeType" in part &&
    typeof part.mimeType === "string" &&
    part.mimeType.startsWith("audio/") &&
    "data" in part &&
    typeof part.data === "string"
  );
}

/**
 * Validates that a message has the required structure
 *
 * @param msg - Message to validate
 * @throws Error if message is invalid
 */
function validateMessage(msg: CoreMessage): void {
  if (
    !msg ||
    typeof msg.role !== "string" ||
    typeof msg.content === "undefined"
  ) {
    throw new Error(ERROR_MESSAGES.INVALID_MESSAGE);
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Converts a MIME type to OpenAI audio format with proper validation
 *
 * @param mimeType - The MIME type from the file part
 * @returns OpenAI-compatible audio format
 * @throws Error if MIME type is unsupported
 */
function convertMimeTypeToOpenAIAudioFormat(
  mimeType: string
): OpenAIAudioFormat {
  if (!mimeType || typeof mimeType !== "string") {
    throw new Error(ERROR_MESSAGES.INVALID_MIME_TYPE);
  }

  const normalizedMimeType = mimeType.toLowerCase().trim();

  if (!normalizedMimeType.startsWith("audio/")) {
    throw new Error(ERROR_MESSAGES.UNSUPPORTED_MEDIA_TYPE(mimeType));
  }

  const openaiFormat = MIME_TYPE_TO_OPENAI_FORMAT[normalizedMimeType];

  if (!openaiFormat) {
    const supportedTypes = Object.keys(MIME_TYPE_TO_OPENAI_FORMAT).join(", ");
    throw new Error(
      ERROR_MESSAGES.UNSUPPORTED_AUDIO_TYPE(mimeType, supportedTypes)
    );
  }

  return openaiFormat;
}

/**
 * Extracts text content from various content part formats
 *
 * @param textPart - Content part that may contain text
 * @returns Extracted text content or empty string
 */
function extractTextContent(textPart: unknown): string {
  if (typeof textPart === "string") {
    return textPart;
  }

  if (typeof textPart === "object" && textPart !== null && "text" in textPart) {
    return (textPart as { text: string }).text;
  }

  return "";
}

// =============================================================================
// MESSAGE CONVERSION FUNCTIONS
// =============================================================================

/**
 * Converts a tool message to OpenAI format
 *
 * @param msg - Tool message to convert
 * @returns OpenAI-compatible tool message
 */
function convertToolMessage(msg: CoreMessage): ChatCompletionToolMessageParam {
  return {
    role: "tool",
    content:
      msg.content as unknown as ChatCompletionToolMessageParam["content"],
    tool_call_id: "id" in msg && typeof msg.id === "string" ? msg.id : "",
  } as ChatCompletionToolMessageParam;
}

/**
 * Converts an audio message to OpenAI format
 *
 * @param msg - Audio message to convert
 * @param filePart - Audio file part containing the audio data
 * @returns OpenAI-compatible audio message
 */
function convertAudioMessage(
  msg: CoreMessage,
  filePart: AudioFilePart
): ChatCompletionMessageParam {
  const format = convertMimeTypeToOpenAIAudioFormat(filePart.mimeType);
  const textPart = (msg.content as unknown[])[0];
  const textContent = extractTextContent(textPart);

  return {
    ...msg,
    role: "user",
    content: [
      {
        type: "text",
        text: textContent,
      },
      {
        type: "input_audio",
        input_audio: {
          data: filePart.data,
          format: format,
        },
      },
    ],
  } as ChatCompletionMessageParam;
}

/**
 * Converts a regular message to OpenAI format
 *
 * @param msg - Regular message to convert
 * @returns OpenAI-compatible message
 */
function convertRegularMessage(msg: CoreMessage): ChatCompletionMessageParam {
  return {
    role: msg.role as "user" | "assistant" | "system",
    content: msg.content,
  } as ChatCompletionMessageParam;
}

// =============================================================================
// MAIN PUBLIC FUNCTION
// =============================================================================

/**
 * Converts an array of CoreMessage objects (from 'ai') to an array of OpenAI ChatCompletionMessageParam objects.
 *
 * Handles user, assistant, system, and tool roles, including multimodal and tool call content.
 * Supports audio content conversion with proper MIME type handling.
 *
 * @param coreMessages - Array of CoreMessage objects to convert
 * @returns Array of ChatCompletionMessageParam objects for OpenAI API
 * @throws Error if input is invalid or message conversion fails
 *
 * @example
 * ```typescript
 * const messages = convertCoreMessagesToOpenAIMessages([
 *   { role: "user", content: "Hello" },
 *   { role: "assistant", content: "Hi there!" }
 * ]);
 * ```
 */
export function convertCoreMessagesToOpenAIMessages(
  coreMessages: (CoreMessage & { id?: string })[]
): ChatCompletionMessageParam[] {
  if (!Array.isArray(coreMessages)) {
    throw new Error(ERROR_MESSAGES.INVALID_INPUT);
  }

  // We need to strip the id, or the openai client will throw an error
  return coreMessages.map(({ id: _id, ...msg }): ChatCompletionMessageParam => {
    validateMessage(msg);

    if (msg.role === "tool") {
      return convertToolMessage(msg);
    }

    if (Array.isArray(msg.content) && msg.content.length > 1) {
      const filePart = msg.content[1];
      if (isAudioFilePart(filePart)) {
        return convertAudioMessage(msg, filePart);
      }
    }

    return convertRegularMessage(msg);
  });
}
