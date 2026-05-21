/**
 * VoiceAgentAdapter — base class for voice-capable agents.
 *
 * PR1 shipped this surface as signatures only. PR3 (this commit) wires
 * the default `call()` body and the executor connect / disconnect
 * lifecycle in {@link ./adapter.runtime} so subclasses can extend just
 * the four transport primitives. Source-of-truth port:
 * `python/scenario/voice/adapter.py`.
 *
 * Extends {@link AgentAdapter} (text-based) with audio send/receive
 * primitives and a capability matrix. Concrete subclasses will live under
 * `scenario.voice.adapters` once the transports ship (Pipecat, Twilio,
 * OpenAI Realtime, Gemini Live, ElevenLabs).
 */

import { AgentAdapter, type AgentInput } from "../domain/agents";
import type { AgentReturnTypes } from "../domain/agents/types/agent-return.types";
import { AudioChunk } from "./audio-chunk";
import { AdapterCapabilities, UnsupportedCapabilityError } from "./capabilities";
import { defaultVoiceCall } from "./adapter.runtime";

/**
 * Abstract base for voice agents that exchange audio with the agent under
 * test.
 *
 * Subclasses must implement {@link connect}, {@link disconnect},
 * {@link sendAudio}, and {@link receiveAudio}. They must also publish an
 * {@link AdapterCapabilities} instance as the {@link capabilities} field —
 * declared once per concrete adapter, not per instance.
 *
 * The default {@link call} implementation lives in {@link defaultVoiceCall}:
 * it extracts audio from the latest user message, transmits via
 * {@link sendAudio}, drains the agent response on tail silence, and
 * records one user + one agent segment into the executor state.
 * Subclasses can override `call()` for specialised flows but will
 * usually inherit it.
 */
export abstract class VoiceAgentAdapter extends AgentAdapter {
  /**
   * Declaration of what this adapter can and cannot do. Concrete subclasses
   * MUST publish a non-default value; the base instance defaults to "nothing
   * supported" so capability-gated steps fail safely when an adapter forgets
   * to declare.
   */
  abstract readonly capabilities: AdapterCapabilities;

  /**
   * Default `call()` body, ported from Python `VoiceAgentAdapter.call`.
   *
   * Threads the latest user-message audio through {@link sendAudio},
   * drains the agent response on tail silence, records one user and one
   * agent segment into the executor state, and returns the merged
   * assistant audio message. Subclasses may override for specialised
   * flows but will usually inherit it.
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    return defaultVoiceCall(this, input);
  }

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
