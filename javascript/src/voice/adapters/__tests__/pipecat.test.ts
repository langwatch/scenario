/**
 * PipecatAgentAdapter scenarios — binds the Pipecat-tagged scenarios
 * from `specs/voice-agents.feature` (@ts-pipecat) without hitting a real
 * Pipecat bot.
 *
 * Coverage:
 *  - Real WSS @e2e demos against a running Pipecat bot are deferred (see
 *    PR body `/browser-qa` note); CI doesn't have a bot URL.
 *  - This unit layer drives the adapter against a fake WebSocket that
 *    captures every outbound frame and lets the test push inbound frames
 *    synchronously. The Twilio Media Streams wire-format assertions live
 *    here.
 *
 * The "successful audio round-trip" scenario is tagged @integration to
 * keep its dual-axis position: it covers the same flow that an
 * integration test against a real bot would, even though our fake socket
 * collapses the network leg.
 */

import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AudioChunk,
  PendingTransportError,
  PipecatAgentAdapter,
  type PipecatWebSocketLike,
} from "../../index";
import { pcm16ToMulaw } from "../twilio-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

/**
 * Test double for `ws.WebSocket`. Captures every outbound frame, exposes
 * push helpers for inbound frames, and is event-emitter-shaped so it
 * matches the adapter's `removeAllListeners` / `on` / `once` usage.
 */
class FakeWebSocket implements PipecatWebSocketLike {
  readonly sent: string[] = [];
  // Listeners are typed as `Function` in the storage map so the
  // event-shape variation between "open" (`() => void`) and "error"
  // (`(err: Error) => void`) can co-exist. The public `on`/`once`
  // signatures mirror the interface overloads exactly.
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: string | Uint8Array): void {
    this.sent.push(
      typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
    );
  }

  close(): void {
    this.emit("close", undefined);
  }

  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "open", listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = (...args: any[]): void => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event as "open", wrapped as () => void);
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners[event] = [];
    else this.listeners = {};
    return this;
  }

  emit(event: string, arg: unknown): void {
    for (const l of this.listeners[event] ?? []) l(arg);
  }

  private off(event: string, listener: (...args: unknown[]) => void): void {
    const arr = this.listeners[event];
    if (!arr) return;
    const idx = arr.indexOf(listener as (...args: unknown[]) => void);
    if (idx >= 0) arr.splice(idx, 1);
  }

  /** Parsed view of every outbound frame, filtered by event type. */
  framesByEvent(event: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const raw of this.sent) {
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.event === event) out.push(obj);
      } catch {
        // Non-JSON outbound — adapter only sends JSON, so this is a bug.
      }
    }
    return out;
  }
}

let sockets: FakeWebSocket[] = [];

function nextSocket(): FakeWebSocket {
  const ws = new FakeWebSocket();
  sockets.push(ws);
  // Adapter awaits `open` before continuing connect(). Fire it on the
  // next microtask so the adapter has registered its `once('open')`
  // listener before we emit.
  queueMicrotask(() => ws.emit("open", undefined));
  return ws;
}

beforeEach(() => {
  sockets = [];
});

afterEach(() => {
  sockets = [];
});

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      "PipecatAgentAdapter exchanges audio with a Pipecat bot over WebSocket",
      ({ Given, When, Then, And }) => {
        let adapter: PipecatAgentAdapter;
        let socket: FakeWebSocket;
        let received: AudioChunk;

        Given(
          'a PipecatAgentAdapter configured with url, audio_format "mulaw", sample_rate 8000',
          () => {
            adapter = new PipecatAgentAdapter({
              url: "ws://localhost:8765/ws",
              audioFormat: "mulaw",
              sampleRate: 8000,
              streamSid: "MZtest",
              callSid: "CAtest",
              realTimePacing: false,
              webSocketFactory: (_url) => {
                socket = nextSocket();
                return socket;
              },
            });
          },
        );

        When("connect() is called and the SDK sends user audio", async () => {
          await adapter.connect();
          // Drive a small user utterance through the adapter. 480 PCM16
          // samples at 24 kHz = 20 ms; resampled to 8 kHz = 160 µ-law
          // bytes = exactly one Twilio frame.
          const pcm = new Uint8Array(960); // 480 samples × 2 bytes
          const view = new DataView(pcm.buffer);
          for (let i = 0; i < 480; i++) view.setInt16(i * 2, 5000, true);
          const sendDone = adapter.sendAudio(new AudioChunk({ data: pcm }));

          // Push an inbound µ-law payload from the "bot" so receiveAudio
          // resolves. The adapter's receive-side coalescing flushes once it
          // has accumulated ~100 ms of µ-law (800 bytes); we feed exactly
          // that, derived from 1600 bytes of 8 kHz PCM (800 samples).
          const inboundMulaw = pcm16ToMulaw(buildPcm16At8k(1600));
          socket.emit(
            "message",
            JSON.stringify({
              event: "media",
              streamSid: "MZtest",
              media: { payload: Buffer.from(inboundMulaw).toString("base64") },
            }),
          );

          received = await adapter.receiveAudio(2.0);
          await sendDone;
        });

        Then(
          "a synthetic Twilio Media Streams handshake is performed",
          () => {
            // The adapter sends `connected` then `start` before any media.
            expect(socket.framesByEvent("connected").length).toBe(1);
            const startFrames = socket.framesByEvent("start");
            expect(startFrames.length).toBe(1);
            const start = startFrames[0]?.start as Record<string, unknown>;
            expect(start.streamSid).toBe("MZtest");
            expect(start.callSid).toBe("CAtest");
            const mediaFormat = start.mediaFormat as Record<string, unknown>;
            expect(mediaFormat.encoding).toBe("audio/x-mulaw");
            expect(mediaFormat.sampleRate).toBe(8000);
          },
        );

        And("outbound audio is paced as 20 ms µ-law frames", () => {
          const mediaFrames = socket.framesByEvent("media");
          expect(mediaFrames.length).toBeGreaterThanOrEqual(1);
          for (const frame of mediaFrames) {
            const media = frame.media as Record<string, unknown>;
            const payload = Buffer.from(media.payload as string, "base64");
            // Twilio's 20 ms frame at 8 kHz µ-law = 160 bytes. The final
            // frame may be shorter if the encode rounded down by a sample.
            expect(payload.length).toBeLessThanOrEqual(160);
            expect(payload.length).toBeGreaterThan(0);
          }
        });

        And(
          "inbound µ-law from the bot is decoded into a PCM16/24kHz AudioChunk",
          () => {
            expect(received).toBeInstanceOf(AudioChunk);
            expect(received.sampleRate).toBe(24000);
            // 800 µ-law bytes @ 8 kHz = 100 ms of audio = 2400 PCM16
            // samples at 24 kHz = 4800 bytes. Allow ±2 for round() drift.
            expect(received.data.length).toBeGreaterThanOrEqual(4796);
            expect(received.data.length).toBeLessThanOrEqual(4804);
          },
        );

        And(
          "the adapter advertises mulaw/8000 as its transport format",
          () => {
            expect(adapter.transportFormat).toBe("mulaw/8000");
            expect(adapter.capabilities.inputFormats).toContain("mulaw/8000");
            expect(adapter.capabilities.outputFormats).toContain("mulaw/8000");
          },
        );
      },
    );

    Scenario(
      "PipecatAgentAdapter raises PendingTransportError on transport=\"webrtc\"",
      ({ Given, When, Then }) => {
        let adapter: PipecatAgentAdapter;

        Given(
          'a PipecatAgentAdapter configured with signaling_url and transport "webrtc"',
          () => {
            adapter = new PipecatAgentAdapter({
              transport: "webrtc",
              signalingUrl: "https://example.test/webrtc",
            });
          },
        );

        When("the scenario executor calls connect()", () => {
          // The error fires inside `await adapter.connect()`; assertion
          // lives in `Then` so the negative-test shape stays clear.
        });

        Then(
          "PendingTransportError is raised naming the adapter and the deferred transport",
          async () => {
            await expect(adapter.connect()).rejects.toBeInstanceOf(PendingTransportError);
            try {
              await adapter.connect();
            } catch (err) {
              expect(err).toBeInstanceOf(PendingTransportError);
              expect((err as Error).message).toContain("webrtc");
            }
          },
        );
      },
    );

    Scenario(
      "PipecatAgentAdapter emits a Twilio clear-buffer frame on interrupt",
      ({ Given, When, Then, And }) => {
        let adapter: PipecatAgentAdapter;
        let socket: FakeWebSocket;

        Given("a connected PipecatAgentAdapter", async () => {
          adapter = new PipecatAgentAdapter({
            url: "ws://localhost:8765/ws",
            streamSid: "MZclear",
            realTimePacing: false,
            webSocketFactory: (_url) => {
              socket = nextSocket();
              return socket;
            },
          });
          await adapter.connect();
        });

        When("scenario.interrupt() is called on the adapter", async () => {
          await adapter.interrupt();
        });

        Then(
          'a Twilio Media Streams "clear" frame is sent on the WebSocket',
          () => {
            const clearFrames = socket.framesByEvent("clear");
            expect(clearFrames.length).toBe(1);
          },
        );

        And("the frame carries the active streamSid", () => {
          const clearFrames = socket.framesByEvent("clear");
          expect(clearFrames[0]?.streamSid).toBe("MZclear");
        });
      },
    );
  },
  { includeTags: [["ts-pipecat"]] },
);

/** Build a known-amplitude PCM16 buffer in bytes for the test fixture. */
function buildPcm16At8k(numBytes: number): Uint8Array {
  const out = new Uint8Array(numBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < Math.floor(numBytes / 2); i++) {
    view.setInt16(i * 2, 8000, true);
  }
  return out;
}

// ---------------------------------------------------------------- plain unit tests
// Receive-side coalescing edge cases — sub-batch buffers must still flush
// when the socket closes or sends an explicit `stop`. Plain vitest (not
// bound to a feature scenario) because these are protocol-leaf guarantees
// the AC list doesn't enumerate but the Python parity does cover.

async function connectWithFake(): Promise<{
  adapter: PipecatAgentAdapter;
  socket: FakeWebSocket;
}> {
  let captured!: FakeWebSocket;
  const adapter = new PipecatAgentAdapter({
    url: "ws://localhost:8765/ws",
    streamSid: "MZedge",
    realTimePacing: false,
    webSocketFactory: () => {
      captured = nextSocket();
      return captured;
    },
  });
  await adapter.connect();
  return { adapter, socket: captured };
}

describe("PipecatAgentAdapter receive-side coalescing", () => {
  it("flushes a partial buffer when the bot sends a `stop` event", async () => {
    const { adapter, socket } = await connectWithFake();
    // Send 160 µ-law bytes — well under the 800-byte flush threshold.
    const partial = pcm16ToMulaw(buildPcm16At8k(320));
    socket.emit(
      "message",
      JSON.stringify({
        event: "media",
        streamSid: "MZedge",
        media: { payload: Buffer.from(partial).toString("base64") },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({ event: "stop", streamSid: "MZedge" }),
    );
    const chunk = await adapter.receiveAudio(1.0);
    expect(chunk).toBeInstanceOf(AudioChunk);
    // 160 µ-law bytes → 160 PCM samples @ 8k → resampled to 24k = 480 samples = 960 bytes (±4).
    expect(chunk.data.length).toBeGreaterThanOrEqual(956);
    expect(chunk.data.length).toBeLessThanOrEqual(964);
    await adapter.disconnect();
  });

  it("flushes a partial buffer when the WebSocket closes", async () => {
    const { adapter, socket } = await connectWithFake();
    const partial = pcm16ToMulaw(buildPcm16At8k(320));
    socket.emit(
      "message",
      JSON.stringify({
        event: "media",
        streamSid: "MZedge",
        media: { payload: Buffer.from(partial).toString("base64") },
      }),
    );
    // Close the socket — partial buffer should drain before close completes.
    socket.emit("close", undefined);
    const chunk = await adapter.receiveAudio(1.0);
    expect(chunk).toBeInstanceOf(AudioChunk);
    expect(chunk.data.length).toBeGreaterThan(0);
    // Adapter is closed at this point — disconnect is a no-op.
    await adapter.disconnect();
  });
});
