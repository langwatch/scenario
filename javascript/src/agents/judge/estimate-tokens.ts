/**
 * Default token threshold for switching to structure-only trace rendering.
 * Traces exceeding this estimated token count will be rendered in
 * structure-only mode with expand/grep tools available to the judge.
 *
 */
export const DEFAULT_TOKEN_THRESHOLD = 8192;

/**
 * Estimates the number of tokens in a text string using a character-based heuristic.
 * Uses approximately 4 characters per token ratio, which is a reasonable
 * approximation for English text with typical LLM tokenizers.
 *
 * @param text - The text to estimate token count for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
