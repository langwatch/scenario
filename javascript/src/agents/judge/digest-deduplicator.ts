/**
 * Utility for deduplicating string content in span attribute values.
 * Normalizes strings for comparison and replaces duplicates with markers.
 */
export class DigestDeduplicator {
  private readonly seen = new Map<string, string>();
  private readonly threshold: number;

  constructor(params: { threshold: number }) {
    this.threshold = params.threshold;
  }

  /**
   * Resets the deduplication state for a new digest.
   */
  reset(): void {
    this.seen.clear();
  }

  /**
   * Processes a value, deduplicating strings recursively.
   * @param value - Any value to process
   * @returns Processed value with duplicates replaced
   */
  process(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return this.processString(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      return this.processArray(value);
    }

    if (typeof value === "object") {
      return this.processObject(value as Record<string, unknown>);
    }

    return value;
  }

  private processString(str: string): string {
    // Truncate base64 media data URLs before any other processing
    const truncated = this.truncateBase64Media(str);
    if (truncated !== str) {
      return truncated;
    }

    // Try to parse as JSON and process recursively
    if (this.looksLikeJson(str)) {
      try {
        const parsed = JSON.parse(str);
        const processed = this.process(parsed);
        return JSON.stringify(processed);
      } catch {
        // Not valid JSON, treat as plain string
      }
    }

    if (str.length < this.threshold) {
      return str;
    }

    const normalized = this.normalize(str);

    if (this.seen.has(normalized)) {
      return "[DUPLICATE - SEE ABOVE]";
    }

    this.seen.set(normalized, str);
    return str;
  }

  /**
   * Detects and truncates base64 media data URLs (images, audio, video).
   * @param str - String to check
   * @returns Truncated marker if base64 media, original string otherwise
   */
  private truncateBase64Media(str: string): string {
    const match = str.match(
      /^data:((image|audio|video)\/[a-z0-9+.-]+);base64,(.+)$/i
    );
    if (match) {
      const mimeType = match[1];
      const mediaType = match[2].toUpperCase();
      const size = match[3].length;
      return `[${mediaType}: ${mimeType}, ~${size} bytes]`;
    }
    return str;
  }

  private looksLikeJson(str: string): boolean {
    const trimmed = str.trim();
    return (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    );
  }

  private processArray(arr: unknown[]): unknown[] {
    return arr.map((item) => this.process(item));
  }

  private processObject(obj: Record<string, unknown>): Record<string, unknown> {
    // Handle AI SDK media parts first
    const mediaPart = this.truncateMediaParts(obj);
    if (mediaPart) {
      return mediaPart;
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = this.process(val);
    }
    return result;
  }

  /**
   * Handles AI SDK file/image parts with embedded base64.
   * @param obj - Object to check
   * @returns Processed object with base64 truncated, or null if not a media part
   */
  private truncateMediaParts(
    obj: Record<string, unknown>
  ): Record<string, unknown> | null {
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

    return null;
  }

  private normalize(str: string): string {
    return str
      .replace(/\\n/g, " ") // JSON-escaped newlines
      .replace(/\\r/g, " ") // JSON-escaped carriage returns
      .replace(/\\t/g, " ") // JSON-escaped tabs
      .replace(/\n/g, " ") // Actual newlines
      .replace(/\r/g, " ") // Actual carriage returns
      .replace(/\t/g, " ") // Actual tabs
      .replace(/\s+/g, " ") // Collapse whitespace
      .trim()
      .toLowerCase();
  }
}
