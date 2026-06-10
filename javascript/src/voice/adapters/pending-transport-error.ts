/**
 * Shared error for adapter transports that have not yet been wired up.
 *
 * Python parity: `python/scenario/voice/adapters/_stub.py`. Lifted into
 * its own module here so future TS adapters (LiveKit, WebRTC, …) can
 * import it without depending on a specific adapter file.
 */

export class PendingTransportError extends Error {
  readonly adapterName: string;

  constructor(adapterName: string) {
    super(
      `${adapterName}: transport implementation is not yet wired up. ` +
        "Options: (1) run this scenario as an @integration test against a " +
        `live endpoint, (2) subclass ${adapterName} and implement ` +
        "sendAudio/receiveAudio — and re-audit the inherited " +
        "`capabilities` field so the matrix matches what your subclass " +
        "can actually do. Claiming streamingTranscripts=true in a " +
        "subclass without a real transcript stream will silently break " +
        "afterWords interruption.",
    );
    this.name = "PendingTransportError";
    this.adapterName = adapterName;
  }
}
