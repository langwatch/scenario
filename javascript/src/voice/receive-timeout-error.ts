/**
 * The receive-deadline signal shared by every built-in voice adapter and the
 * response drain (#756).
 *
 * The drain has to tell "the agent stopped talking" from "the transport died",
 * and both reach it as a rejected `receiveAudio`. Only a receive timeout ends a
 * turn; anything else is a real failure and must propagate with its original
 * message and stack, or a dead transport is reported as a short but successful
 * agent turn.
 */
export class ReceiveTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    // `TimeoutError` rather than the class name: it is the web platform's own
    // name for this condition, so custom adapters that already reject with
    // `AbortSignal.timeout()` or a hand-rolled timeout satisfy the contract
    // without importing anything from us.
    this.name = "TimeoutError";
  }
}

/**
 * Whether `error` is the "no audio within the deadline" signal that ends a turn.
 *
 * Matched on `name`, not on the class: `AbortSignal.timeout()` rejects with a
 * `DOMException`, which is only an `Error` subclass on some runtimes, and a
 * bundle that loads this module twice would defeat `instanceof` on our own
 * class. The name is the contract documented on
 * {@link VoiceAgentAdapter.receiveAudio}, so read exactly that.
 */
export function isReceiveTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}
