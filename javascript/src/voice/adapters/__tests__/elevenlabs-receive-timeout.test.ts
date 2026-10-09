/**
 * Binds `specs/voice-receive-timeout-diagnosis.feature`.
 *
 * `receiveAudio` bounds a turn with two deadlines: an IDLE one of
 * `responseTimeout` that every inbound frame re-arms, and an ABSOLUTE ceiling of
 * `max(responseTimeout, 45s)` that nothing re-arms. These tests pin the default
 * budget (60s, the same number Python uses) and pin each deadline to its own
 * rejection, so a silent agent and a pinging one stay separate diagnoses.
 *
 * Keyless: the real SDK `Conversation` runs against the in-memory
 * `FakeWebSocket`, and fake timers stand in for the wall clock, so a 60s budget
 * costs milliseconds.
 *
 * Run with `pnpm test src/voice/adapters/__tests__/elevenlabs-receive-timeout.test.ts`
 * from `javascript/`.
 */
import { Buffer } from "node:buffer";

import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect, vi } from "vitest";

import { AudioChunk } from "../../audio-chunk";
import { ElevenLabsAgentAdapter } from "../index";
import { FakeWebSocket, makeFakeConv } from "./fixtures/fake-elevenlabs-conversation";

// `context.with` must propagate into receiveAudio for `currentSpan()` to see the
// receive span; without a context manager the active context is always root.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

/** Python's `VoiceAgentAdapter.response_timeout`, which JS now matches. */
const PYTHON_RESPONSE_TIMEOUT_S = 60;

/** `KEEPALIVE_HARD_CEILING_S` in both SDKs. Not exported, so restated here. */
const KEEPALIVE_HARD_CEILING_S = 45;

const TROUBLESHOOTING_ANCHOR =
  "https://scenario.langwatch.ai/voice/troubleshooting#receiveaudio-timed-out-hosted-elevenlabs";

/** 8 bytes of valid PCM16 (even byte count), base64 as EL sends it. */
const PCM_B64 = Buffer.from("\x12\x34".repeat(4)).toString("base64");

/** Feed one inbound EL ConvAI frame to the SDK over the fake socket. */
function emit(socket: FakeWebSocket, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event), "utf-8"));
}

async function makeConnected(): Promise<{
  adapter: ElevenLabsAgentAdapter;
  socket: FakeWebSocket;
}> {
  const fake = makeFakeConv();
  const adapter = new ElevenLabsAgentAdapter({
    agentId: "agt-receive-timeout",
    apiKey: "sk-receive-timeout",
    webSocketFactory: fake.webSocketFactory,
    conversationClient: fake.conversationClient,
  });
  await adapter.connect();
  return { adapter, socket: fake.socket.current! };
}

/**
 * Run `body` against a connected adapter under fake timers, tearing both down
 * however the body ends. The pump interval and the receive deadlines are the
 * only clocks involved, so nothing here waits on the real one.
 */
async function withFakeClock(
  body: (ctx: { adapter: ElevenLabsAgentAdapter; socket: FakeWebSocket }) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers();
  let adapter: ElevenLabsAgentAdapter | undefined;
  try {
    const connected = await makeConnected();
    adapter = connected.adapter;
    await body(connected);
  } finally {
    await adapter?.disconnect();
    vi.useRealTimers();
  }
}

/** Settle a receive promise without letting a rejection escape as unhandled. */
function track(promise: Promise<unknown>): { error: () => Error | undefined } {
  let error: Error | undefined;
  promise.catch((err: Error) => {
    error = err;
  });
  return { error: () => error };
}

describe("receiveAudio timeout budget and diagnosis", () => {
  it("defaults responseTimeout to the same 60s budget Python uses", () => {
    const adapter = new ElevenLabsAgentAdapter({ agentId: "agt", apiKey: "sk" });
    expect(adapter.responseTimeout).toBe(PYTHON_RESPONSE_TIMEOUT_S);
  });

  it("resolves for an agent that answers after 35s, inside the default budget", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      const recv = adapter.receiveAudio(adapter.responseTimeout);
      const settled = track(recv);

      // Past the old 30s budget, which rejected here, and short of the 60s one.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(settled.error(), "rejected before the agent got its 60s").toBeUndefined();

      emit(socket, { type: "audio", audio_event: { audio_base_64: PCM_B64 } });
      await vi.advanceTimersByTimeAsync(20);

      const chunk = await recv;
      expect(chunk.data.length).toBeGreaterThan(0);
    });
  });

  it("names the idle deadline when the agent goes completely silent", async () => {
    await withFakeClock(async ({ adapter }) => {
      const recv = adapter.receiveAudio(adapter.responseTimeout);
      const settled = track(recv);

      await vi.advanceTimersByTimeAsync(PYTHON_RESPONSE_TIMEOUT_S * 1000 + 50);

      const message = settled.error()?.message ?? "";
      expect(message).toContain("receiveAudio timed out");
      expect(message).toContain("The idle deadline of 60s elapsed");
      expect(message).toContain("not even a keepalive ping");
      expect(message).toContain("responseTimeout");
      expect(message).toContain(TROUBLESHOOTING_ANCHOR);
      // The silent case is NOT the ceiling case, even though at the default
      // budget both deadlines land on the same instant.
      expect(message).not.toContain("absolute ceiling");
    });
  });

  it("names the absolute ceiling when the agent pings but never speaks", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      const recv = adapter.receiveAudio(adapter.responseTimeout);
      const settled = track(recv);

      // A ping every 20s keeps re-arming the 60s idle deadline, so only the
      // ceiling can end this wait.
      for (let elapsed = 0; elapsed < 70_000; elapsed += 20_000) {
        emit(socket, { type: "ping", ping_event: { event_id: elapsed, ping_ms: 5 } });
        await vi.advanceTimersByTimeAsync(20_000);
      }

      const message = settled.error()?.message ?? "";
      expect(message).toContain("receiveAudio timed out");
      expect(message).toContain("The absolute ceiling of 60s elapsed");
      expect(message).toContain("kept sending frames, keepalive pings or transcripts, but never audio");
      expect(message).toContain("responseTimeout");
      expect(message).toContain(TROUBLESHOOTING_ANCHOR);
      expect(message).not.toContain("The idle deadline");
    });
  });

  it("honours a raised responseTimeout on the idle path", async () => {
    await withFakeClock(async ({ adapter }) => {
      adapter.responseTimeout = 90;
      const recv = adapter.receiveAudio(adapter.responseTimeout);
      const settled = track(recv);

      await vi.advanceTimersByTimeAsync(PYTHON_RESPONSE_TIMEOUT_S * 1000 + 50);
      expect(settled.error(), "rejected at the default instead of the override").toBeUndefined();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled.error()?.message ?? "").toContain("The idle deadline of 90s elapsed");
    });
  });

  it("honours a raised responseTimeout on the ceiling path", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      adapter.responseTimeout = 90;
      const recv = adapter.receiveAudio(adapter.responseTimeout);
      const settled = track(recv);

      // Pings every 30s: under the 90s idle deadline, so the ceiling decides.
      for (let elapsed = 0; elapsed < 100_000; elapsed += 30_000) {
        emit(socket, { type: "ping", ping_event: { event_id: elapsed, ping_ms: 5 } });
        if (elapsed === 30_000) {
          expect(
            settled.error(),
            `rejected at the ${KEEPALIVE_HARD_CEILING_S}s floor instead of the raised ceiling`,
          ).toBeUndefined();
        }
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(settled.error()?.message ?? "").toContain("The absolute ceiling of 90s elapsed");
    });
  });

  it("keeps a sub-second tail probe on the 45s ceiling floor", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      // The drain's tail probe passes responseTailSilence, not responseTimeout,
      // so the ceiling floor is what stops a pinging agent wedging the probe.
      const recv = adapter.receiveAudio(0.6);
      const settled = track(recv);

      for (let elapsed = 0; elapsed < 46_000; elapsed += 500) {
        emit(socket, { type: "ping", ping_event: { event_id: elapsed, ping_ms: 5 } });
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(settled.error()?.message ?? "").toContain(
        `The absolute ceiling of ${KEEPALIVE_HARD_CEILING_S}s elapsed`,
      );
    });
  });
});

/** The agent speaks one chunk and the drain takes it, as the first receive of a turn does. */
async function agentSpeaks(adapter: ElevenLabsAgentAdapter, socket: FakeWebSocket): Promise<void> {
  const first = adapter.receiveAudio(adapter.responseTimeout);
  emit(socket, { type: "audio", audio_event: { audio_base_64: PCM_B64, event_id: 1 } });
  await vi.advanceTimersByTimeAsync(20);
  await first;
}

/** Emit `event` every `everyMs` for `forMs`, advancing the clock between frames. */
async function streamFor(
  socket: FakeWebSocket,
  event: Record<string, unknown>,
  everyMs: number,
  forMs: number,
): Promise<void> {
  for (let elapsed = 0; elapsed < forMs; elapsed += everyMs) {
    emit(socket, event);
    await vi.advanceTimersByTimeAsync(everyMs);
  }
}

/** The agent starts the server tool `lookup_property`. */
function emitToolRequest(socket: FakeWebSocket): void {
  emit(socket, {
    type: "agent_tool_request",
    agent_tool_request: { tool_name: "lookup_property", tool_call_id: "t1" },
  });
}

/** The `lookup_property` tool answers. */
function emitToolResponse(socket: FakeWebSocket): void {
  emit(socket, {
    type: "agent_tool_response",
    agent_tool_response: { tool_name: "lookup_property", tool_call_id: "t1", is_error: false },
  });
}

/** Non-audio frames EL keeps sending while the agent is quiet after speaking. */
const QUIET_AGENT_FRAMES: Array<[string, Record<string, unknown>]> = [
  ["ping", { type: "ping", ping_event: { event_id: 7, ping_ms: 5 } }],
  ["vad_score", { type: "vad_score", vad_score_event: { vad_score: 0.02 } }],
  ["context_usage", { type: "context_usage", context_usage_event: { used: 120 } }],
  [
    "agent_chat_response_part",
    { type: "agent_chat_response_part", text_response_part: { text: "", type: "stop" } },
  ],
];

describe("tail probe after the agent has spoken", () => {
  it.each(QUIET_AGENT_FRAMES)(
    "ends on responseTailSilence while the agent keeps sending %s frames",
    async (_name, frame) => {
      await withFakeClock(async ({ adapter, socket }) => {
        await agentSpeaks(adapter, socket);

        const probe = adapter.receiveAudio(0.6);
        const settled = track(probe);
        // A frame every 200ms re-armed the 0.6s probe forever before the fix, so the
        // turn only ended on the 45s ceiling. Audio silence now ends it.
        await streamFor(socket, frame, 200, 1_000);

        const message = settled.error()?.message ?? "";
        expect(message, "tail probe still open 1s after the agent went quiet").toContain(
          "The idle deadline of 0.6s elapsed",
        );
      });
    },
  );

  it("keeps the probe open while more agent audio arrives", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);

      const probe = adapter.receiveAudio(0.6);
      emit(socket, { type: "audio", audio_event: { audio_base_64: PCM_B64, event_id: 1 } });
      await vi.advanceTimersByTimeAsync(20);

      const chunk = await probe;
      expect(chunk.data.length).toBeGreaterThan(0);
    });
  });

  it("keeps the probe open while a server tool the agent started is still running", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);

      const probe = adapter.receiveAudio(0.6);
      const settled = track(probe);
      emitToolRequest(socket);
      // The tool takes 5s; only pings arrive meanwhile.
      await streamFor(socket, QUIET_AGENT_FRAMES[0]![1], 200, 5_000);
      expect(settled.error(), "turn cut while the agent's tool was running").toBeUndefined();
    });
  });

  it("keeps the probe open through a silent tool, with no frames at all meanwhile", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);

      const probe = adapter.receiveAudio(0.6);
      const settled = track(probe);
      emitToolRequest(socket);
      // Nothing reaches the socket while the tool runs: no pings to re-arm a 0.6s wait.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled.error(), "silent tool cut by the tail probe").toBeUndefined();
    });
  });

  it("waits for the spoken answer that comes later than responseTailSilence after the tool", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);

      const probe = adapter.receiveAudio(0.6);
      const settled = track(probe);
      emitToolRequest(socket);
      await vi.advanceTimersByTimeAsync(1_000);
      emitToolResponse(socket);
      // The agent generates its answer from the tool result for 900ms, pinging
      // every 100ms. Tool completion is not speech completion.
      await streamFor(socket, QUIET_AGENT_FRAMES[0]![1], 100, 900);
      expect(settled.error(), "turn cut before the post-tool answer").toBeUndefined();

      emit(socket, { type: "audio", audio_event: { audio_base_64: PCM_B64, event_id: 2 } });
      await vi.advanceTimersByTimeAsync(20);
      const chunk = await probe;
      expect(chunk.data.length).toBeGreaterThan(0);
    });
  });

  it("returns to the tail probe once the post-tool answer has started", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);
      emitToolRequest(socket);
      emitToolResponse(socket);
      const answer = adapter.receiveAudio(0.6);
      emit(socket, { type: "audio", audio_event: { audio_base_64: PCM_B64, event_id: 2 } });
      await vi.advanceTimersByTimeAsync(20);
      await answer;

      const probe = adapter.receiveAudio(0.6);
      const settled = track(probe);
      await streamFor(socket, QUIET_AGENT_FRAMES[0]![1], 200, 1_000);
      expect(settled.error()?.message ?? "").toContain("The idle deadline of 0.6s elapsed");
    });
  });

  it("bounds the post-tool wait when the agent never speaks again", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);

      const probe = adapter.receiveAudio(0.6);
      const settled = track(probe);
      emitToolRequest(socket);
      emitToolResponse(socket);
      await streamFor(socket, QUIET_AGENT_FRAMES[0]![1], 500, KEEPALIVE_HARD_CEILING_S * 1000 + 1_000);
      expect(settled.error()?.message ?? "").toContain(
        `The absolute ceiling of ${KEEPALIVE_HARD_CEILING_S}s elapsed`,
      );
    });
  });

  it("names the frame types that kept a wait open when it ends on the ceiling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await withFakeClock(async ({ adapter, socket }) => {
        const recv = adapter.receiveAudio(0.6);
        const settled = track(recv);
        await streamFor(socket, QUIET_AGENT_FRAMES[1]![1], 500, 46_000);
        expect(settled.error()?.message ?? "").toContain("absolute ceiling");

        const call = warn.mock.calls.find(([msg]) => String(msg).includes("ended on the absolute ceiling"));
        expect(call, "no ceiling warning logged").toBeDefined();
        expect(call![1]).toMatchObject({
          end: "ceiling",
          afterAgentAudio: false,
          framesByType: { vad_score: 90 },
        });
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("stamps the wait diagnosis on the receive span when it ends on a deadline", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);

      const span = new BasicTracerProvider().getTracer("test").startSpan("voice.audio.receive");
      const probe = context.with(trace.setSpan(context.active(), span), () => adapter.receiveAudio(0.6));
      const settled = track(probe);
      await streamFor(socket, QUIET_AGENT_FRAMES[0]![1], 200, 1_000);
      expect(settled.error()?.message ?? "").toContain("The idle deadline of 0.6s elapsed");

      const attrs = (span as unknown as ReadableSpan).attributes;
      expect(attrs["voice.elevenlabs.receive_wait_end"]).toBe("idle");
      expect(attrs["voice.elevenlabs.receive_wait_ms"]).toBeGreaterThanOrEqual(600);
      expect(attrs["voice.elevenlabs.receive_wait_late_ms"]).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(String(attrs["voice.elevenlabs.receive_wait_frames"]))).toMatchObject({
        ping: expect.any(Number),
      });
    });
  });

  it("lets pings re-arm the wait again once the next user turn starts", async () => {
    await withFakeClock(async ({ adapter, socket }) => {
      await agentSpeaks(adapter, socket);
      await adapter.sendAudio(new AudioChunk({ data: new Uint8Array(960) }));

      // Before the agent answers the new turn, a slow-but-pinging agent must not be
      // cut off: pings every 200ms keep a 0.6s wait open.
      const recv = adapter.receiveAudio(0.6);
      const settled = track(recv);
      await streamFor(socket, QUIET_AGENT_FRAMES[0]![1], 200, 2_000);
      expect(settled.error(), "pre-response wait cut despite pings").toBeUndefined();
    });
  });
});
