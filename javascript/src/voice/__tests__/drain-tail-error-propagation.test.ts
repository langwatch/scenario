/**
 * Binds `specs/voice-drain-error-propagation.feature` (#756).
 *
 * The response drain ends a turn when the agent stops talking, and it learns
 * that from a rejected `receiveAudio`. It used to end the turn on ANY rejection,
 * so a dead transport, a misconfigured adapter or a tripped assertion was
 * reported as a short but successful agent turn. That is the worst failure mode
 * for a test framework: the scenario keeps running and asserts against a turn
 * that never happened. It is what hid the #697 P0 through CI, five rounds of
 * automated review and a human reproduction.
 *
 * These tests pin the split. A receive deadline still closes the turn cleanly
 * and keeps the audio collected so far; anything else reaches the caller with
 * its identity intact and produces NO agent messages.
 *
 * Mic-free and clock-free: the scripted adapter decides each `receiveAudio`
 * outcome, so nothing here waits on a real deadline.
 *
 * Run with `pnpm test src/voice/__tests__/drain-tail-error-propagation.test.ts`
 * from `javascript/`.
 */
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Register a context manager ONCE so context.with propagates across awaits.
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import { AgentRole, type AgentInput } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { createAudioMessage } from "../messages";
import { ReceiveTimeoutError } from "../receive-timeout-error";

const SR = 24000; // PCM16 mono 24kHz

function tone(seconds: number, transcript = "agent"): AudioChunk {
  const data = new Uint8Array(Math.round(seconds * SR) * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i % 250) + 1;
  return new AudioChunk({ data, transcript });
}

/** The empty chunk every adapter uses to mean "end of stream, cleanly". */
function terminal(): AudioChunk {
  return new AudioChunk({ data: new Uint8Array(0) });
}

/** A transport failure of the kind the drain must never absorb. */
class DeadTransportError extends Error {
  readonly streamId = "stream-42";
  constructor() {
    super("no live media stream");
    this.name = "DeadTransportError";
  }
}

/** What a scripted `receiveAudio` call does: yield a chunk, or reject with this. */
type RecvAction = AudioChunk | { rejectWith: unknown };

class ScriptedAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: true,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  lastAgentTranscript: string | null = "agent";
  receiveCalls = 0;
  private actions: RecvAction[];

  constructor(actions: RecvAction[]) {
    super();
    this.actions = [...actions];
  }
  override isConnected(): boolean {
    return true;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_chunk: AudioChunk): Promise<void> {}
  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    this.receiveCalls += 1;
    const action = this.actions.shift();
    // Running off the end means the drain asked for more than the script
    // covers; a terminal chunk ends the turn rather than hanging the suite.
    if (action === undefined) return terminal();
    if (action instanceof AudioChunk) return action;
    throw action.rejectWith;
  }
}

function audioInput(incoming?: AudioChunk): AgentInput {
  const newMessages = incoming ? [createAudioMessage(incoming, "user")] : [];
  return { newMessages } as unknown as AgentInput;
}

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

describe("drain tail-receive error classification (#756)", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });
  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  describe("a hard error reaches the caller", () => {
    it("rejects call() with the adapter's own error object, unwrapped", async () => {
      const boom = new DeadTransportError();
      const adapter = new ScriptedAdapter([tone(0.1), { rejectWith: boom }]);

      // Identity, not just the message: the caller needs the original class,
      // its custom fields and its stack to diagnose the transport.
      const caught = await adapter.call(audioInput(tone(0.05))).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(caught).toBe(boom);
      expect(caught).toBeInstanceOf(DeadTransportError);
      expect((caught as DeadTransportError).streamId).toBe("stream-42");
      expect((caught as Error).stack).toBeDefined();
    });

    it("yields no agent turn, so the run cannot assert against audio the agent never sent", async () => {
      const adapter = new ScriptedAdapter([
        tone(0.1),
        { rejectWith: new DeadTransportError() },
      ]);

      // The pre-fix behaviour: call() RESOLVED here with the 0.1s of audio
      // collected before the failure, and the scenario scored that truncated
      // turn as a real one.
      let resolvedWith: unknown = "did-not-resolve";
      await adapter.call(audioInput(tone(0.05))).then(
        (value) => {
          resolvedWith = value;
        },
        () => {},
      );
      expect(resolvedWith).toBe("did-not-resolve");
    });

    it("marks the receive span ERROR without claiming tail silence", async () => {
      const adapter = new ScriptedAdapter([
        tone(0.1),
        { rejectWith: new DeadTransportError() },
      ]);
      await expect(adapter.call(audioInput(tone(0.05)))).rejects.toThrow(
        "no live media stream",
      );

      const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
      expect(recv.status.code).toBe(SpanStatusCode.ERROR);
      // The whole point: the trace must not read as a turn that ended normally.
      expect(recv.attributes["voice.audio.terminated_reason"]).not.toBe("tail_silence");
    });

    it("propagates a thrown non-Error value instead of reading it as a deadline", async () => {
      // A `throw "string"` has no `name`, so the classifier must reject it.
      const adapter = new ScriptedAdapter([tone(0.1), { rejectWith: "recv exploded" }]);
      await expect(adapter.call(audioInput(tone(0.05)))).rejects.toBe("recv exploded");
    });

    it("stops draining at the failure rather than swallowing and retrying", async () => {
      const adapter = new ScriptedAdapter([
        tone(0.1),
        { rejectWith: new DeadTransportError() },
        tone(0.1),
      ]);
      await expect(adapter.call(audioInput(tone(0.05)))).rejects.toThrow();
      expect(adapter.receiveCalls).toBe(2);
    });
  });

  describe("a receive deadline still ends the turn cleanly", () => {
    it("closes the drain on the shared ReceiveTimeoutError and keeps the audio so far", async () => {
      const adapter = new ScriptedAdapter([
        tone(0.1),
        tone(0.1),
        { rejectWith: new ReceiveTimeoutError("no audio received within 600ms") },
      ]);

      const messages = await adapter.call(audioInput(tone(0.05)));

      const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
      expect(recv.attributes["voice.audio.terminated_reason"]).toBe("tail_silence");
      expect(recv.status.code).not.toBe(SpanStatusCode.ERROR);
      // Both chunks survive: a deadline ends the turn, it does not discard it.
      expect(recv.attributes["voice.audio.chunk_count"]).toBe(2);
      expect(messages).toBeTruthy();
    });

    it("accepts a custom adapter's own error named TimeoutError", async () => {
      // The documented contract for third-party adapters: no import from us.
      const err = new Error("MyAdapter: receiveAudio timed out");
      err.name = "TimeoutError";
      const adapter = new ScriptedAdapter([tone(0.1), { rejectWith: err }]);

      await adapter.call(audioInput(tone(0.05)));

      const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
      expect(recv.attributes["voice.audio.terminated_reason"]).toBe("tail_silence");
    });

    it("accepts the DOMException AbortSignal.timeout() rejects with", async () => {
      // A custom adapter built on the platform primitive gets this for free, and
      // a DOMException is not an Error subclass on every runtime.
      const adapter = new ScriptedAdapter([
        tone(0.1),
        { rejectWith: new DOMException("The operation timed out.", "TimeoutError") },
      ]);

      await adapter.call(audioInput(tone(0.05)));

      const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
      expect(recv.attributes["voice.audio.terminated_reason"]).toBe("tail_silence");
    });

    it("keeps a deliberate agent hangup a clean end of turn, not a failure", async () => {
      // #839/#849: an agent that hangs up wakes the parked receive with the
      // empty end-of-stream chunk rather than throwing, so narrowing the catch
      // must not turn correct agent behaviour into a failed run.
      const adapter = new ScriptedAdapter([tone(0.1), terminal()]);
      adapter.agentHungUp = true;

      const messages = await adapter.call(audioInput(tone(0.05)));

      expect(messages).toBeTruthy();
      expect(adapter.agentHungUp).toBe(true);
      const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
      expect(recv.attributes["voice.audio.terminated_reason"]).toBe("terminal_chunk");
      expect(recv.status.code).not.toBe(SpanStatusCode.ERROR);
    });
  });
});
