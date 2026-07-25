/**
 * Internal timeout signal shared by voice adapters and the response drain.
 *
 * `drainAgentResponse` treats only this error (or an adapter-defined error
 * named `TimeoutError`) as expected tail silence. Every other receive failure
 * must propagate so transport and adapter defects are not hidden as a normal
 * end of turn.
 */
export class ReceiveTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function isReceiveTimeoutError(error: unknown): boolean {
  return error instanceof ReceiveTimeoutError ||
    (error instanceof Error && error.name === "TimeoutError");
}
