/**
 * Default token threshold for switching to structure-only trace rendering.
 * Traces exceeding this estimated token count will be rendered in
 * structure-only mode with expand/grep tools available to the judge.
 *
 */
export const DEFAULT_TOKEN_THRESHOLD = 8192;

/**
 * Estimates the number of tokens in a text string using a byte-based heuristic.
 * Uses UTF-8 byte length divided by 4, which accounts for multi-byte characters
 * (emojis, CJK, etc.) that typically consume more tokens than ASCII text.
 *
 * @param text - The text to estimate token count for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  const byteLength = new TextEncoder().encode(text).byteLength;
  return Math.ceil(byteLength / 4);
}
