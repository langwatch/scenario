/**
 * Shared voice-layer utilities.
 *
 * Kept separate from `adapter.runtime.ts` (which imports heavy deps like
 * `vad`) so this file can be imported by thin callers (pipecat adapter,
 * voice-steps, scenario-execution) without pulling in the full adapter
 * runtime graph.
 */

/**
 * Promise-based sleep for async delays.
 *
 * Single canonical implementation — replaces the four inline
 * `new Promise((r) => setTimeout(r, ms))` expressions scattered across
 * the voice subsystem (scenario-execution.ts, voice-steps.ts,
 * pipecat.ts). Issue #576.
 *
 * @param ms Delay in milliseconds. Values ≤ 0 resolve immediately (no
 *           timer allocation).
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
