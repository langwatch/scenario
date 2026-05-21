/**
 * In-memory voice adapter for PR3 runtime tests.
 *
 * Carries no transport — `sendAudio` and `receiveAudio` move bytes
 * through in-memory queues. The adapter publishes a configurable
 * {@link AdapterCapabilities} so individual tests can flip
 * `nativeVad` on or off and the VAD-fallback contract becomes
 * observable without touching a real audio stack.
 *
 * Lifecycle bookkeeping:
 *   - `connectCount` / `disconnectCount` — counters, asserted by the
 *     lifecycle test.
 *   - `wasConnectedAtFirstCall` — `true` if `connectCount === 1` and
 *     `disconnectCount === 0` at the moment of the first `call()`,
 *     binding the "connect before first script step" half of the AC.
 *   - `sentAudio` / `responses` — visible audio queues for assertions.
 */
import { AgentRole } from "../../../domain/agents";
import {
  AdapterCapabilities,
  type AdapterCapabilitiesInit,
} from "../../capabilities";
import { AudioChunk, silentChunk } from "../../audio-chunk";
import { VoiceAgentAdapter } from "../../adapter";

export interface FakeAdapterOptions {
  /** Override the default capability matrix (defaults to nativeVad=true). */
  capabilities?: AdapterCapabilitiesInit;
  /**
   * Sequence of agent-side responses the fake adapter will yield via
   * `receiveAudio` in order. Once exhausted, it returns
   * `silentChunk(0)` to signal end-of-stream and let the drain loop
   * exit cleanly.
   */
  responses?: AudioChunk[];
  /**
   * If true, `connect()` rejects on first call. Used to exercise the
   * "disconnect still fires when connect throws" code path.
   */
  failOnConnect?: boolean;
  /**
   * If true, `disconnect()` rejects on first call. Used to exercise
   * the swallow-on-cleanup behaviour.
   */
  failOnDisconnect?: boolean;
  /**
   * If true, `call()` rejects on first invocation — used to verify the
   * "disconnect fires even when the script throws" half of the
   * lifecycle AC without needing a second AGENT-role agent that would
   * compete for the `agent()` step.
   */
  failOnCall?: boolean;
}

export class FakeVoiceAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities: AdapterCapabilities;

  /** Counter incremented every time {@link connect} resolves. */
  connectCount = 0;
  /** Counter incremented every time {@link disconnect} resolves. */
  disconnectCount = 0;
  /** Counter incremented every time {@link call} is entered. */
  callCount = 0;
  /**
   * Frozen snapshot of `(connectCount === 1 && disconnectCount === 0)`
   * at the moment of the first `call()`. Tests assert this to bind the
   * "connect before the first script step" half of the AC.
   */
  wasConnectedAtFirstCall = false;
  /** Audio chunks captured via {@link sendAudio} in order. */
  readonly sentAudio: AudioChunk[] = [];

  private readonly responses: AudioChunk[];
  private nextResponseIndex = 0;
  private readonly failOnConnect: boolean;
  private readonly failOnDisconnect: boolean;
  private readonly failOnCall: boolean;

  constructor(options: FakeAdapterOptions = {}) {
    super();
    this.capabilities = new AdapterCapabilities({
      streamingTranscripts: false,
      nativeVad: true,
      dtmf: false,
      interruption: false,
      inputFormats: ["pcm16/24000"],
      outputFormats: ["pcm16/24000"],
      ...options.capabilities,
    });
    this.responses = options.responses ?? [silentChunk(0.05)];
    this.failOnConnect = options.failOnConnect ?? false;
    this.failOnDisconnect = options.failOnDisconnect ?? false;
    this.failOnCall = options.failOnCall ?? false;
  }

  async connect(): Promise<void> {
    if (this.failOnConnect) {
      throw new Error("FakeVoiceAdapter.connect failure (test fixture)");
    }
    this.connectCount += 1;
  }

  async disconnect(): Promise<void> {
    if (this.failOnDisconnect) {
      throw new Error("FakeVoiceAdapter.disconnect failure (test fixture)");
    }
    this.disconnectCount += 1;
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.sentAudio.push(chunk);
  }

  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    if (this.nextResponseIndex < this.responses.length) {
      return this.responses[this.nextResponseIndex++]!;
    }
    // After draining all responses, return an empty chunk so the
    // tail-silence loop in the runtime exits without timing out.
    return silentChunk(0);
  }

  override async call(input: import("../../../domain/agents").AgentInput) {
    this.callCount += 1;
    if (this.callCount === 1) {
      this.wasConnectedAtFirstCall =
        this.connectCount === 1 && this.disconnectCount === 0;
    }
    if (this.failOnCall) {
      throw new Error("FakeVoiceAdapter.call failure (test fixture)");
    }
    // Delegate to the default voice runtime so this fixture exercises
    // the adapter.runtime.ts code paths under test.
    return super.call(input);
  }
}
