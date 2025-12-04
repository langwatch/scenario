/**
 * Tracks seen strings and replaces duplicates with markers.
 * Only operates on strings; does not handle traversal.
 */
export class StringDeduplicator {
  private readonly seen = new Map<string, boolean>();
  private readonly threshold: number;

  constructor(params: { threshold: number }) {
    this.threshold = params.threshold;
  }

  /**
   * Resets seen strings for a new digest.
   */
  reset(): void {
    this.seen.clear();
  }

  /**
   * Processes a string, returning duplicate marker if seen before.
   * @param str - String to process
   * @returns Original string or duplicate marker
   */
  process(str: string): string {
    if (str.length < this.threshold) return str;

    const key = this.normalize(str);
    if (this.seen.has(key)) return "[DUPLICATE - SEE ABOVE]";

    this.seen.set(key, true);
    return str;
  }

  /**
   * Normalizes string for comparison (whitespace, case).
   */
  private normalize(str: string): string {
    return str
      .replace(/\\[nrt]/g, " ") // JSON-escaped whitespace
      .replace(/[\n\r\t]/g, " ") // Actual whitespace
      .replace(/\s+/g, " ") // Collapse
      .trim()
      .toLowerCase();
  }
}

