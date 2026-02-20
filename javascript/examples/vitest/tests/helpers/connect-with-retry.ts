import type { RealtimeAgentAdapter } from "@langwatch/scenario";

/**
 * Connects a RealtimeAgentAdapter with retry logic for transient failures
 * (e.g. 504 Gateway Timeout from OpenAI's Realtime API).
 */
export async function connectWithRetry(
  adapter: RealtimeAgentAdapter,
  { maxRetries = 3, delayMs = 2000 }: { maxRetries?: number; delayMs?: number } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await adapter.connect();
      return;
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[connectWithRetry] Attempt ${attempt}/${maxRetries} failed: ${message}. Retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
