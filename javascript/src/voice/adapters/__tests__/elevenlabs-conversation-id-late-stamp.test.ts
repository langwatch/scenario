/**
 * Regression test for a lost `voice.elevenlabs.conversation_id`.
 *
 * ElevenLabs sends `conversation_initiation_metadata` asynchronously, and it
 * routinely arrives *after* `connect()` resolved and the `voice.adapter.connect`
 * span was ended in its `finally`. The websocket callback still carries that
 * ended span in its captured context, so the stamp is attempted against a span
 * that is no longer recording and is silently dropped.
 *
 * That much is only lateness. The bug was that the adapter marked the id
 * "stamped" on that dropped write, which poisoned the guard flag and stopped
 * the `sendAudio` fallback from ever retrying on a live span. The conversation
 * id then reached no span at all, and because the run's whole-call audio is
 * resolved by scanning the run's spans for exactly that attribute, the
 * recording became permanently unresolvable for that run.
 *
 * Observed in production as an intermittent failure: across three real
 * ElevenLabs runs the agent id (stamped synchronously, always on an open span)
 * landed all three times, while the conversation id landed once.
 */

import { Buffer } from "node:buffer";

import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AudioChunk } from "../../audio-chunk";
import { ElevenLabsAgentAdapter } from "../index";
import {
  FakeWebSocket,
  makeFakeConv,
} from "./fixtures/fake-elevenlabs-conversation";

// `context.with` must propagate across awaits for `currentSpan()` to mean
// anything inside the adapter; without a context manager it is always root.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

const CONVERSATION_ID_ATTR = "voice.elevenlabs.conversation_id";

function emit(socket: FakeWebSocket, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event), "utf-8"));
}

function metadataFrame(conversationId: string): Record<string, unknown> {
  return {
    type: "conversation_initiation_metadata",
    conversation_initiation_metadata_event: {
      conversation_id: conversationId,
      agent_output_audio_format: "pcm_24000",
      user_input_audio_format: "pcm_24000",
    },
  };
}

// Registered once, at module scope, on purpose. `setGlobalTracerProvider`
// keeps the FIRST provider it is given and ignores later ones, so registering
// per-test would leave every test after the first emitting into the first
// test's already-shut-down exporter and silently observing no spans at all.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

describe("given ElevenLabs conversation metadata that arrives after the connect span ended", () => {
  beforeEach(() => {
    exporter.reset();
  });

  afterEach(() => {
    exporter.reset();
  });

  async function makeConnected(): Promise<{
    adapter: ElevenLabsAgentAdapter;
    socket: FakeWebSocket;
  }> {
    const fake = makeFakeConv();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt",
      apiKey: "sk",
      webSocketFactory: fake.webSocketFactory,
      conversationClient: fake.conversationClient,
    });
    await adapter.connect();
    return { adapter, socket: fake.socket.current! };
  }

  /**
   * Reproduces the real ordering: the metadata frame is delivered while the
   * active span is one that has already ended, exactly as the late websocket
   * callback sees it. The stamp cannot land there, so it must not be recorded
   * as done — the next live span has to still receive it.
   */
  it("stamps the conversation id on the next live span instead of losing it", async () => {
    const { adapter, socket } = await makeConnected();
    const tracer = trace.getTracer("test");

    const endedSpan = tracer.startSpan("voice.adapter.connect");
    endedSpan.end();

    await context.with(trace.setSpan(context.active(), endedSpan), async () => {
      emit(socket, metadataFrame("conv_late"));
    });

    expect(adapter.conversationId).toBe("conv_late");

    const liveSpan = tracer.startSpan("voice.audio.send");
    await context.with(trace.setSpan(context.active(), liveSpan), async () => {
      await adapter.sendAudio(
        new AudioChunk({ data: new Uint8Array([0x01, 0x02, 0x03, 0x04]) }),
      );
    });
    liveSpan.end();

    await adapter.disconnect();

    const stamped = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes[CONVERSATION_ID_ATTR] !== undefined);

    expect(
      stamped.map((span) => span.name),
      "conversation id never reached any span, so the run's recording cannot be resolved",
    ).toContain("voice.audio.send");
    expect(stamped[0]?.attributes[CONVERSATION_ID_ATTR]).toBe("conv_late");
  });

  /**
   * The retry must not turn into a repeat: once the id is genuinely on a span,
   * later turns should leave it alone rather than stamping every span in the
   * call.
   */
  it("stamps the conversation id only once across later turns", async () => {
    const { adapter, socket } = await makeConnected();
    const tracer = trace.getTracer("test");

    const endedSpan = tracer.startSpan("voice.adapter.connect");
    endedSpan.end();
    await context.with(trace.setSpan(context.active(), endedSpan), async () => {
      emit(socket, metadataFrame("conv_once"));
    });

    for (const name of ["voice.audio.send.first", "voice.audio.send.second"]) {
      const span = tracer.startSpan(name);
      await context.with(trace.setSpan(context.active(), span), async () => {
        await adapter.sendAudio(
          new AudioChunk({ data: new Uint8Array([0x01, 0x02, 0x03, 0x04]) }),
        );
      });
      span.end();
    }

    await adapter.disconnect();

    const stamped = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes[CONVERSATION_ID_ATTR] !== undefined);

    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.name).toBe("voice.audio.send.first");
  });
});
