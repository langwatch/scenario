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

import { defaultVoiceCall } from "./adapter.runtime";
import { AudioChunk } from "./audio-chunk";
import { AdapterCapabilities, UnsupportedCapabilityError } from "./capabilities";
import { AgentAdapter, type AgentInput } from "../domain/agents";
import type { AgentReturnTypes } from "../domain/agents/types/agent-return.types";

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

  /**
   * Bounded grace-wait (seconds) for the agent turn's transcript AFTER audio
   * drains (#734). Audio silence closes the turn (`responseTailSilence`), but a
   * live voice agent (hosted ElevenLabs) delivers the turn's text on a SEPARATE
   * socket event (`agent_response` → `lastAgentTranscript`). When that event
   * lands after the audio-silence boundary, snapshotting `lastAgentTranscript`
   * at drain-close reads `null` and the turn reaches the text-only simulator as
   * a bare `[audio message]` — the simulator then fabricates.
   *
   * The default `call()` flow ({@link defaultVoiceCall}) polls this field up to
   * this ceiling for a pending transcript before reading it. It short-circuits
   * the INSTANT `lastAgentTranscript` is already set (zero added latency on the
   * happy path — the common case where the transcript won the race) and only
   * elapses when the transcript genuinely never arrives, so a real ElevenLabs
   * drop still terminates the turn. Set to `0` to disable the wait.
   */
  transcriptGraceWait = 2.0;

  /** Open the transport and prepare to exchange audio. */
  abstract connect(): Promise<void>;

  /** Close the transport and release resources. */
  abstract disconnect(): Promise<void>;

  /**
   * Whether the transport is currently open and ready to exchange audio
   * (Gap #11). The default {@link call} flow ({@link defaultVoiceCall})
   * consults this BEFORE sending audio and raises {@link PendingTransportError}
   * uniformly when it returns `false` — so a `call()` issued before the
   * executor's `connect()` fails with one clear error across every transport
   * instead of a transport-specific null-dereference or silent hang.
   *
   * Base default is `true`: adapters with no meaningful "not connected" state
   * (in-process composable, test doubles) never trip the gate. Network
   * transport leaves override this to report their real socket/session state.
   */
  isConnected(): boolean {
    return true;
  }

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
