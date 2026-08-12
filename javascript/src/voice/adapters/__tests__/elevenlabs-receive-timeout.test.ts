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
 */
import { Buffer } from "node:buffer";

import { describe, it, expect, vi } from "vitest";

import { ElevenLabsAgentAdapter } from "../index";
import { FakeWebSocket, makeFakeConv } from "./fixtures/fake-elevenlabs-conversation";

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
      expect(message).toContain("keepalive pings but never sent audio");
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
