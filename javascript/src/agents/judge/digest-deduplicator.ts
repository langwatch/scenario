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
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = this.process(val);
    }
    return result;
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
