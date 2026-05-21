/**
 * VoiceAgentAdapter — base class for voice-capable agents (SIGNATURE ONLY).
 *
 * PR1 surface: types + abstract signatures only. Runtime (default `call()`
 * implementation, executor recording bridge, drain-on-tail-silence loop)
 * lands in PR2+. See `python/scenario/voice/adapter.py` for the eventual
 * behavior; this file pins the contract.
 *
 * Extends {@link AgentAdapter} (text-based) with audio send/receive
 * primitives and a capability matrix. Concrete subclasses will live under
 * `scenario.voice.adapters` once the transports ship (Pipecat, Twilio,
 * OpenAI Realtime, Gemini Live, ElevenLabs).
 */

import { AgentAdapter } from "../domain/agents";
import { AudioChunk } from "./audio-chunk";
import { AdapterCapabilities, UnsupportedCapabilityError } from "./capabilities";

/**
 * Minimal one-shot event the adapter sets when its first agent audio
 * chunk arrives for the current turn. {@link scenario.interrupt} waits on
 * `wait()` (with a bounded timeout) before firing the barge-in so the
 * server-VAD has real audio to detect against.
 */
export interface AgentSpeakingEvent {
  isSet(): boolean;
  wait(): Promise<void>;
}

/**
 * Abstract base for voice agents that exchange audio with the agent under
 * test.
 *
 * Subclasses must implement {@link connect}, {@link disconnect},
 * {@link sendAudio}, and {@link receiveAudio}. They must also publish an
 * {@link AdapterCapabilities} instance as the {@link capabilities} field —
 * declared once per concrete adapter, not per instance.
 *
 * The {@link AgentAdapter.call} method from the parent class remains
 * abstract on this base in PR1; PR2 will introduce the shared `call()`
 * implementation that threads audio extracted from the latest user message
 * through the transport and records segments into the executor state. PR1
 * intentionally leaves it unimplemented so no executor coupling lands with
 * the contract surface.
 */
export abstract class VoiceAgentAdapter extends AgentAdapter {
  /**
   * Declaration of what this adapter can and cannot do. Concrete subclasses
   * MUST publish a non-default value; the base instance defaults to "nothing
   * supported" so capability-gated steps fail safely when an adapter forgets
   * to declare.
   */
  abstract readonly capabilities: AdapterCapabilities;

  /** Seconds to wait for agent audio after sending user audio. */
  responseTimeout = 30.0;

  /**
   * Tail silence: once the first agent chunk arrives, keep draining
   * {@link receiveAudio} until no chunk shows up within this many seconds
   * — that's how we detect the agent finished talking.
   */
  responseTailSilence = 0.6;

  /**
   * Hard cap on a single agent turn's audio. Prevents runaway loops if a
   * transport never signals end-of-stream. 30s = a long sentence.
   */
  responseMaxDuration = 30.0;

  /** Open the transport and prepare to exchange audio. */
  abstract connect(): Promise<void>;

  /** Close the transport and release resources. */
  abstract disconnect(): Promise<void>;

  /** Transmit an {@link AudioChunk} to the agent under test. */
  abstract sendAudio(chunk: AudioChunk): Promise<void>;

  /** Receive the next {@link AudioChunk} from the agent. */
  abstract receiveAudio(timeout: number): Promise<AudioChunk>;

  /**
   * Set when the adapter has emitted its first agent audio chunk for the
   * current turn — gates timing-based barge-in. Concrete adapters expose
   * this so {@link scenario.interrupt} can wait for real speech before
   * firing the interruption. Optional: adapters without server-VAD-style
   * interrupt sequencing can leave it `undefined`.
   */
  agentSpeakingEvent?: AgentSpeakingEvent;

  /**
   * Incremental transcript text emitted while the agent speaks. Populated
   * by adapters that advertise `capabilities.streamingTranscripts`. Read
   * by {@link scenario.interrupt} when `afterWords: N` is set.
   */
  streamingTranscript?: string;

  /**
   * Transmit DTMF tones to the telephony peer. Adapters that advertise
   * `capabilities.dtmf` MUST implement this; the default raises
   * {@link UnsupportedCapabilityError} so an adapter that forgot to ship
   * `sendDtmf` while claiming the capability fails loudly instead of
   * silently routing through a PCM fallback.
   */
  sendDtmf(_tones: string): Promise<void> {
    throw new UnsupportedCapabilityError(
      this.constructor.name,
      "dtmf",
      "This adapter declares capabilities.dtmf = true but did not " +
        "implement sendDtmf(). Override sendDtmf on the concrete adapter " +
        "or flip capabilities.dtmf to false.",
    );
  }

  /**
   * Send a first-class interrupt signal to the agent under test.
   *
   * Adapters that advertise `capabilities.interruption === true` override
   * this to send the transport-native interrupt (e.g. Twilio `clear`,
   * OpenAI Realtime `response.cancel`). The default raises
   * {@link UnsupportedCapabilityError}; callers (`scenario.interrupt()`)
   * check `capabilities.interruption` and fall back to timing-based
   * barge-in when this returns false.
   */
  interrupt(): Promise<void> {
    throw new UnsupportedCapabilityError(
      this.constructor.name,
      "interruption",
      "This adapter has no native interrupt signal. Use the timing-based " +
        "barge-in pattern instead: agent({ wait: false }) + sleep(N) + " +
        "user(content), where the user audio overlaps with the agent's TTS " +
        "and the SUT's VAD detects it.",
    );
  }
}
