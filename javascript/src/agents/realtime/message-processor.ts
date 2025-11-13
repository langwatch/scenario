/**
 * Processes different message types and extracts relevant data
 *
 * This class handles the conversion and validation of different message formats
 * used in the Scenario framework to prepare them for the Realtime API.
 */
export class MessageProcessor {
  /**
   * Processes audio message content and extracts base64 audio data
   *
   * @param content - The message content to process
   * @returns Base64 audio data string or null if no audio found
   * @throws {Error} If audio data is invalid
   */
  processAudioMessage(content: unknown): string | null {
    if (!Array.isArray(content)) {
      return null;
    }

    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "file" &&
        "mediaType" in part &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("audio/")
      ) {
        // Type guard: ensure data is a string (base64)
        if (!("data" in part) || typeof part.data !== "string") {
          throw new Error(
            `Audio data must be base64 string, got: ${typeof part.data}`
          );
        }

        // Validate we have audio data
        if (!part.data || part.data.length === 0) {
          throw new Error(
            `Audio message has no data. Part: ${JSON.stringify(part)}`
          );
        }

        return part.data;
      }
    }

    return null;
  }

  /**
   * Extracts text content from message content
   *
   * @param content - The message content to process
   * @returns Text string or empty string if no text found
   */
  extractTextMessage(content: unknown): string {
    return typeof content === "string" ? content : "";
  }

  /**
   * Validates that a message has either text or audio content
   *
   * @param content - The message content to validate
   * @returns True if the message has valid content
   */
  hasValidContent(content: unknown): boolean {
    const hasText = this.extractTextMessage(content).length > 0;
    const hasAudio = this.processAudioMessage(content) !== null;
    return hasText || hasAudio;
  }
}
