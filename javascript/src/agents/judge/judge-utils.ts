import { ModelMessage } from "ai";

/**
 * Truncates base64 media data to reduce token usage.
 * Handles:
 * - Data URLs: `data:image/png;base64,...`
 * - AI SDK file parts: `{ type: "file", mediaType: "audio/wav", data: "<base64>" }`
 * - Raw base64 strings over threshold (likely binary data)
 * @param value - Any value to process
 * @returns Value with base64 media replaced by markers
 */
function truncateBase64Media(value: unknown): unknown {
  if (typeof value === "string") {
    // Handle data URLs
    const dataUrlMatch = value.match(
      /^data:((image|audio|video)\/[a-z0-9+.-]+);base64,(.+)$/i
    );
    if (dataUrlMatch) {
      const mimeType = dataUrlMatch[1];
      const mediaType = dataUrlMatch[2].toUpperCase();
      const size = dataUrlMatch[3].length;
      return `[${mediaType}: ${mimeType}, ~${size} bytes]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(truncateBase64Media);
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Handle AI SDK file parts: { type: "file", mediaType: "...", data: "<base64>" }
    if (
      obj.type === "file" &&
      typeof obj.mediaType === "string" &&
      typeof obj.data === "string"
    ) {
      const mediaType = obj.mediaType;
      const category = mediaType.split("/")[0]?.toUpperCase() ?? "FILE";
      return {
        ...obj,
        data: `[${category}: ${mediaType}, ~${obj.data.length} bytes]`,
      };
    }

    // Handle image parts with raw base64: { type: "image", image: "<base64>" }
    if (obj.type === "image" && typeof obj.image === "string") {
      const imageData = obj.image;
      // Check if it's a data URL or raw base64
      const dataUrlMatch = imageData.match(
        /^data:((image)\/[a-z0-9+.-]+);base64,(.+)$/i
      );
      if (dataUrlMatch) {
        return {
          ...obj,
          image: `[IMAGE: ${dataUrlMatch[1]}, ~${dataUrlMatch[3].length} bytes]`,
        };
      }
      // Raw base64 (long string without common text patterns)
      if (imageData.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(imageData)) {
        return {
          ...obj,
          image: `[IMAGE: unknown, ~${imageData.length} bytes]`,
        };
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = truncateBase64Media(val);
    }
    return result;
  }

  return value;
}

/**
 * Utilities for the Judge agent.
 */
export const JudgeUtils = {
  /**
   * Builds a minimal transcript from messages for judge evaluation.
   * Truncates base64 media to reduce token usage.
   * @param messages - Array of ModelMessage from conversation
   * @returns Plain text transcript with one message per line
   */
  buildTranscriptFromMessages(messages: ModelMessage[]): string {
    return messages
      .map((msg) => {
        const truncatedContent = truncateBase64Media(msg.content);
        return `${msg.role}: ${JSON.stringify(truncatedContent)}`;
      })
      .join("\n");
  },
};

