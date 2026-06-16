/**
 * Issue #567 — ElevenLabs ConvAI scripted next-turn / post-interrupt receive.
 *
 * The hosted ConvAI transport has NO audio end-of-turn client event (verified
 * against the official EL Python + JS SDKs), so the pre-#567 adapter leaned on
 * a fixed silence tail to coax server-side VAD. That tail does not reliably
 * re-engage a response for a scripted turn 2+ (EL ConvAI 2.0 end-of-turn is a
 * hybrid VAD + deep-learning turn-detector, not a pure silence threshold), so
 * the 2nd `receiveAudio` timed out.
 *
 * The fix sends an explicit `{"type":"user_message","text":<transcript>}`
 * turn-commit — the only documented client→server event that deterministically
 * forces an agent response without mic-style VAD. On the text path the raw
 * audio is NOT also streamed to EL (audio + text in one turn raced the server's
 * ingestion and was live-flaky); the user audio is still recorded locally by
 * the voice runtime and EL echoes the text back as a user_transcript.
 *
 * These tests drive the adapter through the injectable `webSocketFactory` /
 * a fake socket and prove:
 *  1. a scripted 2nd user turn after an agent turn drives a 2nd `receiveAudio`
 *     resolution (the bug), AND each user turn emits a `user_message` commit;
 *  2. the post-interrupt shape (agent audio mid-flight → user re-engages) also
 *     commits + re-engages;
 *  3. `turnCommitMode:"silence"` preserves the legacy pure-audio path;
 *  4. `"text"` mode with no transcript falls back to the silence tail.
 *
 * Offline — no network, no real EL socket. The LIVE ≥2-exchange proof lives in
 * `examples/vitest/tests/voice/elevenlabs-hosted.test.ts`.
 */
import { Buffer } from "node:buffer";

import { describe, it, expect, beforeEach } from "vitest";
import type { RawData } from "ws";

import {
  ElevenLabsAgentAdapter,
  type WebSocketLike,
} from "../adapters/elevenlabs";
import { AudioChunk } from "../audio-chunk";

/**
 * Minimal in-memory {@link WebSocketLike}. Captures every frame the adapter
 * sends and lets the test push inbound frames + lifecycle events.
 */
class FakeElevenLabsSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private listeners: {
    message: Array<(data: RawData) => void>;
    error: Array<(err: Error) => void>;
    close: Array<() => void>;
    open: Array<() => void>;
  } = { message: [], error: [], close: [], open: [] };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.listeners.close.forEach((l) => l());
  }

  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "open", listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    (this.listeners as Record<string, Array<(...a: never[]) => void>>)[event]?.push(
      listener,
    );
    return this;
  }

  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  once(event: string, listener: (...args: never[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.off(event, wrapped as (...a: never[]) => void);
      (listener as (...a: unknown[]) => void)(...args);
    };
    return this.on(event as "open", wrapped as () => void);
  }

  private off(event: string, listener: (...args: never[]) => void): void {
    const arr = (this.listeners as Record<string, Array<(...a: never[]) => void>>)[event];
    const idx = arr?.indexOf(listener) ?? -1;
    if (idx >= 0) arr!.splice(idx, 1);
  }

  removeAllListeners(): void {
    this.listeners = { message: [], error: [], close: [], open: [] };
  }

  // ----- test drivers -----

  /** Fire the `open` event so the adapter's connect() promise resolves. */
  fireOpen(): void {
    this.listeners.open.forEach((l) => l());
  }

  /** Deliver a raw inbound JSON frame to the adapter's message handler. */
  deliver(event: Record<string, unknown>): void {
    const raw = Buffer.from(JSON.stringify(event), "utf-8") as unknown as RawData;
    this.listeners.message.forEach((l) => l(raw));
  }

  /** Deliver an `audio` event carrying `byteLen` bytes of PCM16. */
  deliverAudio(byteLen = 4): void {
    const pcm = Buffer.alloc(byteLen, 1);
    this.deliver({
      type: "audio",
      audio_event: { audio_base_64: pcm.toString("base64") },
    });
  }

  /** Parsed view of every frame the adapter sent. */
  get sentParsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** Frames that are user_message turn-commits. */
  get userMessages(): Array<{ type: string; text: string }> {
    return this.sentParsed.filter(
      (m) => m.type === "user_message",
    ) as Array<{ type: string; text: string }>;
  }

  /** Frames that are user_audio_chunk sends (speech or silence). */
  get audioChunks(): string[] {
    return this.sentParsed
      .filter((m) => typeof m.user_audio_chunk === "string")
      .map((m) => m.user_audio_chunk as string);
  }
}

/** Build an adapter wired to a fresh fake socket, already connected. */
async function connectedAdapter(
  opts: { turnCommitMode?: "text" | "silence"; silenceTailBytes?: number } = {},
): Promise<{ adapter: ElevenLabsAgentAdapter; socket: FakeElevenLabsSocket }> {
  const socket = new FakeElevenLabsSocket();
  const adapter = new ElevenLabsAgentAdapter({
    agentId: "agent-test",
    apiKey: "xi-test",
    webSocketFactory: () => socket,
    ...opts,
  });
  const connecting = adapter.connect();
  socket.fireOpen();
  await connecting;
  return { adapter, socket };
}

/** A user audio chunk that carries its transcript (as the voice runtime threads it). */
function userTurn(text: string): AudioChunk {
  return new AudioChunk({ data: new Uint8Array(8), transcript: text });
}

describe("ElevenLabsAgentAdapter turn-commit (#567)", () => {
  let adapter: ElevenLabsAgentAdapter;
  let socket: FakeElevenLabsSocket;

  beforeEach(async () => {
    ({ adapter, socket } = await connectedAdapter());
  });

  it("a scripted 2nd user turn after an agent turn drives a 2nd receiveAudio resolution", async () => {
    // ---- Exchange 1: greeting drains (real-voice convention) ----
    socket.deliverAudio();
    const greeting = await adapter.receiveAudio(1);
    expect(greeting.data.length).toBeGreaterThan(0);

    // ---- Exchange 1: user turn 1 → agent responds ----
    await adapter.sendAudio(userTurn("Hello, I have a question about my account."));
    // Agent audio for turn 1.
    socket.deliverAudio();
    const agent1 = await adapter.receiveAudio(1);
    expect(agent1.data.length).toBeGreaterThan(0);

    // ---- Exchange 2: the BUG case — scripted 2nd user turn ----
    await adapter.sendAudio(userTurn("Yes, can you check my balance?"));
    // With the explicit commit, EL re-engages: deliver the 2nd agent audio.
    socket.deliverAudio();
    const agent2 = await adapter.receiveAudio(1);
    // This resolving (not timing out) is the #567 proof.
    expect(agent2.data.length).toBeGreaterThan(0);

    // Each user turn emitted an explicit user_message turn-commit (not a
    // silence tail) — the deterministic re-engagement signal.
    expect(socket.userMessages).toEqual([
      { type: "user_message", text: "Hello, I have a question about my account." },
      { type: "user_message", text: "Yes, can you check my balance?" },
    ]);
    // The default "text" path sends ONLY the text commit — NO user_audio_chunk
    // frames at all (sending audio + text in the same turn raced EL's ingestion
    // and was live-flaky; the text turn alone re-engages deterministically).
    expect(socket.audioChunks).toEqual([]);
  });

  it("post-interrupt: a user turn after partial agent audio re-engages a fresh response", async () => {
    // Agent starts talking (turn 1 audio queued but the executor barges in).
    socket.deliverAudio();
    await adapter.receiveAudio(1);

    // User interrupts/responds with a new scripted turn.
    await adapter.sendAudio(userTurn("Actually, wait — cancel that."));
    // EL issues an agent_response_correction (post-barge-in), then fresh audio.
    socket.deliver({
      type: "agent_response_correction",
      agent_response_correction_event: {
        original_agent_response: "Sure, your balance is…",
        corrected_agent_response: "Okay, cancelled.",
      },
    });
    socket.deliverAudio();
    const corrected = await adapter.receiveAudio(1);

    expect(corrected.data.length).toBeGreaterThan(0);
    expect(adapter.lastAgentTranscript).toBe("Okay, cancelled.");
    expect(socket.userMessages).toEqual([
      { type: "user_message", text: "Actually, wait — cancel that." },
    ]);
  });

  it('user_message commit echoes through as user_transcript observability', async () => {
    await adapter.sendAudio(userTurn("What are your hours?"));
    // EL echoes the committed text back as the user transcript.
    socket.deliver({
      type: "user_transcript",
      user_transcription_event: { user_transcript: "What are your hours?" },
    });
    expect(adapter.lastUserTranscript).toBe("What are your hours?");
  });

  it("the committed user_message is a server-accepted shape (type + text only)", async () => {
    await adapter.sendAudio(userTurn("ping"));
    const commit = socket.userMessages[0]!;
    expect(Object.keys(commit).sort()).toEqual(["text", "type"]);
    expect(commit.type).toBe("user_message");
  });
});

describe("ElevenLabsAgentAdapter silence-tail fallbacks (#567)", () => {
  it('turnCommitMode:"silence" preserves the legacy pure-audio VAD path (no user_message)', async () => {
    const { adapter, socket } = await connectedAdapter({ turnCommitMode: "silence" });

    await adapter.sendAudio(userTurn("Hello again."));

    // Legacy path: speech chunk + a zero-byte silence tail, NO user_message.
    expect(socket.userMessages).toEqual([]);
    const silenceTail = Buffer.alloc(16000).toString("base64");
    expect(socket.audioChunks).toContain(silenceTail);
    expect(socket.audioChunks.length).toBe(2); // speech + silence
  });

  it('"text" mode with no transcript falls back to the silence tail', async () => {
    const { adapter, socket } = await connectedAdapter(); // default "text"

    // No transcript on the chunk (e.g. raw audio with no STT text upstream).
    await adapter.sendAudio(new AudioChunk({ data: new Uint8Array(8) }));

    expect(socket.userMessages).toEqual([]);
    const silenceTail = Buffer.alloc(16000).toString("base64");
    expect(socket.audioChunks).toContain(silenceTail);
  });

  it("silenceTailBytes option resizes the fallback tail", async () => {
    const { adapter, socket } = await connectedAdapter({
      turnCommitMode: "silence",
      silenceTailBytes: 2400,
    });

    await adapter.sendAudio(userTurn("size me"));

    const expectedTail = Buffer.alloc(2400).toString("base64");
    expect(socket.audioChunks).toContain(expectedTail);
    expect(socket.audioChunks).not.toContain(Buffer.alloc(16000).toString("base64"));
  });

  it("silence mode — 2nd user turn emits no user_message; receiveAudio times out if server VAD does not fire (the pre-#567 bug path)", async () => {
    // This is the NEGATIVE case that proves the fix is necessary: the pre-#567
    // "silence" path sends only audio + tail and relies on server-side VAD, which
    // does NOT reliably fire on a scripted non-mic stream (EL ConvAI 2.0 hybrid
    // VAD + DL turn-detector). Without a user_message commit, if the server's
    // VAD doesn't fire, no agent audio arrives and receiveAudio times out.
    const { adapter, socket } = await connectedAdapter({ turnCommitMode: "silence" });

    // Greeting.
    socket.deliverAudio();
    await adapter.receiveAudio(1);

    // Turn 1: user sends, we manually deliver agent audio (simulating VAD firing).
    await adapter.sendAudio(userTurn("Hello."));
    socket.deliverAudio();
    await adapter.receiveAudio(1);

    // Turn 2: silence mode — no user_message emitted, server VAD does not fire
    // (we do NOT call socket.deliverAudio() — simulating the real production stall).
    await adapter.sendAudio(userTurn("What are my options?"));

    // Confirm: silence path sends NO user_message commit.
    expect(socket.userMessages).toHaveLength(0);

    // Without a commit, the server never re-engages → receiveAudio times out.
    // This is exactly the #567 bug. On the "text" path (default), sendAudio
    // sends a user_message which deterministically triggers agent audio — no stall.
    await expect(adapter.receiveAudio(0.01)).rejects.toThrow("receiveAudio timed out");
  });
});

describe("ElevenLabsAgentAdapter constructor validation", () => {
  const base = { agentId: "x", apiKey: "y" };

  it("throws on unknown turnCommitMode", () => {
    expect(
      () => new ElevenLabsAgentAdapter({ ...base, turnCommitMode: "vad" as never }),
    ).toThrow(/Unknown turnCommitMode/);
  });

  it("throws on zero silenceTailBytes", () => {
    expect(
      () => new ElevenLabsAgentAdapter({ ...base, silenceTailBytes: 0 }),
    ).toThrow(/positive integer/);
  });

  it("throws on negative silenceTailBytes", () => {
    expect(
      () => new ElevenLabsAgentAdapter({ ...base, silenceTailBytes: -1 }),
    ).toThrow(/positive integer/);
  });

  it("throws on fractional silenceTailBytes", () => {
    expect(
      () => new ElevenLabsAgentAdapter({ ...base, silenceTailBytes: 1.5 }),
    ).toThrow(/positive integer/);
  });
});
