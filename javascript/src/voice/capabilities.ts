/**
 * Adapter capability matrix.
 *
 * Every {@link VoiceAgentAdapter} publishes an {@link AdapterCapabilities}
 * instance as `adapter.capabilities`. Capability-gated script steps check
 * it and raise {@link UnsupportedCapabilityError} when the underlying
 * adapter cannot implement the requested behavior (e.g. `interrupt(after_words=N)`
 * needs streaming transcripts; `dtmf()` needs telephony; etc.).
 *
 * Python parity: `python/scenario/voice/capabilities.py`.
 */

export interface AdapterCapabilitiesInit {
  streamingTranscripts?: boolean;
  nativeVad?: boolean;
  dtmf?: boolean;
  interruption?: boolean;
  inputFormats?: readonly string[];
  outputFormats?: readonly string[];
}

/**
 * Declaration of what a voice adapter can and cannot do.
 *
 * `readonly` everywhere — the Python `@dataclass(frozen=True)` analogue in
 * TS. Concrete adapters declare this once as a class-level constant.
 */
export class AdapterCapabilities {
  /**
   * True if the adapter emits incremental transcript updates as the agent
   * speaks. Required for `interrupt(afterWords: N)`.
   */
  readonly streamingTranscripts: boolean;

  /**
   * True if the adapter itself provides voice-activity-detection events
   * (`user_start_speaking` / `user_stop_speaking`). When False, the SDK
   * falls back to webrtcvad on the incoming audio stream.
   */
  readonly nativeVad: boolean;

  /** True if the adapter can transmit DTMF tones (telephony). */
  readonly dtmf: boolean;

  /**
   * True if the adapter can send a first-class interrupt signal to the
   * agent under test (e.g. Twilio `clear`, OpenAI Realtime
   * `response.cancel`). When True, `scenario.interrupt()` uses the signal
   * path; when False, it falls back to timing-based barge-in (audio sent
   * over the wire while the agent is speaking, which the SUT detects via
   * VAD).
   */
  readonly interruption: boolean;

  /**
   * Wire formats the adapter accepts from the SDK for outgoing user audio
   * (e.g. `["pcm16/24000", "mulaw/8000"]`).
   */
  readonly inputFormats: readonly string[];

  /**
   * Wire formats the adapter emits for incoming agent audio. The SDK
   * converts these to internal PCM16/24000 mono.
   */
  readonly outputFormats: readonly string[];

  constructor(init: AdapterCapabilitiesInit = {}) {
    this.streamingTranscripts = init.streamingTranscripts ?? false;
    this.nativeVad = init.nativeVad ?? false;
    this.dtmf = init.dtmf ?? false;
    this.interruption = init.interruption ?? false;
    this.inputFormats = init.inputFormats ?? [];
    this.outputFormats = init.outputFormats ?? [];
  }
}

/**
 * Raised when a script step requests a capability the adapter does not
 * advertise. The message names the adapter and the missing capability so
 * users can pick a different adapter or fall back to a capability-free
 * alternative (e.g. `interrupt({ after: seconds })` instead of `afterWords`).
 */
export class UnsupportedCapabilityError extends Error {
  readonly adapterName: string;
  readonly capability: string;

  constructor(adapterName: string, capability: string, hint = "") {
    const suffix = hint ? ` ${hint}` : "";
    super(
      `Adapter '${adapterName}' does not support capability '${capability}'. ` +
        `See the adapter capability matrix at docs/voice/capability-matrix.md.${suffix}`,
    );
    this.name = "UnsupportedCapabilityError";
    this.adapterName = adapterName;
    this.capability = capability;
  }
}
