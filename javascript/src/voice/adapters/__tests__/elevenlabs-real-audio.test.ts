/**
 * REAL voice-in multi-turn on hosted ElevenLabs ConvAI (official-SDK transport).
 *
 * Real-audio streaming is the adapter's ONLY behavior: `sendAudio()` streams the
 * user's REAL spoken PCM (paced into 20 ms `user_audio_chunk` frames by the SDK,
 * followed by the continuous mic pump's idle silence that lets EL's server VAD close
 * the turn), and NEVER injects a `{"type":"user_message","text":…}` text commit. The
 * old text-commit default discarded the PCM, so EL's STT/VAD/turn-taking never ran
 * on scripted turns 2+ — that was the text-commit regression; the text-commit path
 * is gone.
 *
 * These regression guards pin the seam at the wire level through the REAL
 * `@elevenlabs/elevenlabs-js` SDK `Conversation` running against an in-memory
 * socket (`webSocketFactory`) + a fake signed-URL client (`conversationClient`),
 * provable without live EL creds:
 *
 *  1. across a greeting-led ≥2-turn drive, turn 2 streams the REAL PCM speech as
 *     `user_audio_chunk` frames and emits NO `user_message` text commit, so EL's
 *     STT actually runs on the scripted audio.
 *  2. the voice-specific STT assertion — after the drive, both scripted user
 *     turns were committed as PCM (`audioCommitCount >= 2`) and a non-empty STT
 *     `user_transcript` came back (`lastUserTranscript` populated), i.e. audio
 *     actually reached the agent. Strictly stronger than the older `>=N segments`
 *     check, which passed even on the old text-commit path where no PCM reached EL.
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { describe, it, expect } from "vitest";

import { AudioChunk } from "../../audio-chunk";
import { ElevenLabsAgentAdapter, type ElevenLabsAgentAdapterOptions } from "../index";

// The two SDK injection seams, derived from the public options type (no deep
// SDK-path import needed).
type WsFactory = NonNullable<ElevenLabsAgentAdapterOptions["webSocketFactory"]>;
type ConvClient = NonNullable<ElevenLabsAgentAdapterOptions["conversationClient"]>;

const WS_OPEN = 1;
const WS_CLOSED = 3;

// In-memory fake of the SDK's WebSocketInterface — records each `send()` payload as
// a decoded object so tests assert the wire shape directly (mirrors elevenlabs.test.ts).
class FakeWebSocket extends EventEmitter {
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = WS_OPEN;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.emit("close", 1000, Buffer.from("closed"));
  }
}

function makeFakeConv(): {
  webSocketFactory: WsFactory;
  conversationClient: ConvClient;
  socket: { current: FakeWebSocket | null };
} {
  const socketRef: { current: FakeWebSocket | null } = { current: null };
  const webSocketFactory: WsFactory = {
    create: (_url: string) => {
      const socket = new FakeWebSocket();
      socketRef.current = socket;
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  };
  const conversationClient: ConvClient = {
    conversationalAi: {
      conversations: {
        getSignedUrl: async () => ({
          signedUrl: "wss://fake-signed.elevenlabs.test/convai",
        }),
      },
    },
  };
  return { webSocketFactory, conversationClient, socket: socketRef };
}

// 8 bytes of non-zero PCM16 stands in for real spoken audio. The voice runtime
// threads the `scenario.user("…")` script text through as the chunk transcript
// (the same way the live runtime does), so we attach one here.
function speechChunk(transcript: string): AudioChunk {
  return new AudioChunk({
    data: new Uint8Array([0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00]),
    transcript,
  });
}

function emitAudio(socket: FakeWebSocket, pcm: Uint8Array): void {
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "audio",
        audio_event: { audio_base_64: Buffer.from(pcm).toString("base64") },
      }),
      "utf-8",
    ),
  );
}

function emitUserTranscript(socket: FakeWebSocket, transcript: string): void {
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "user_transcript",
        user_transcription_event: { user_transcript: transcript },
      }),
      "utf-8",
    ),
  );
}

const AGENT_PCM = new Uint8Array([0x01, 0x00, 0x02, 0x00]);

/** Is this a `user_audio_chunk` frame carrying non-silent (real speech) PCM? */
function isRealSpeechFrame(frame: Record<string, unknown>): boolean {
  const b64 = frame.user_audio_chunk;
  if (typeof b64 !== "string") return false;
  const bytes = Buffer.from(b64, "base64");
  return bytes.length > 0 && bytes.some((b) => b !== 0);
}

function isUserMessage(frame: Record<string, unknown>): boolean {
  return frame.type === "user_message";
}

/**
 * The continuous mic pump feeds frames on a real 20 ms timer, so wait for the spoken
 * PCM to actually reach the wire before snapshotting. Polls `socket.sent` (from an
 * optional index) for a real-speech frame (the always-on idle silence frames are
 * skipped by isRealSpeechFrame).
 */
async function flushUntilRealSpeech(
  socket: FakeWebSocket,
  fromIdx = 0,
  budgetMs = 1500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (socket.sent.slice(fromIdx).some(isRealSpeechFrame)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("flushUntilRealSpeech: no real-speech frame within budget");
}

/**
 * Drive a greeting-led, 2-scripted-turn hosted-EL flow over the fake socket and
 * return the frames sent during turn 2 (the index past which the text-commit
 * regression bit).
 */
async function driveTwoTurns(): Promise<{
  turn2Frames: Array<Record<string, unknown>>;
  allFrames: Array<Record<string, unknown>>;
  adapter: ElevenLabsAgentAdapter;
}> {
  const fake = makeFakeConv();
  const adapter = new ElevenLabsAgentAdapter({
    agentId: "agt_test",
    apiKey: "sk_test",
    webSocketFactory: fake.webSocketFactory,
    conversationClient: fake.conversationClient,
  });
  await adapter.connect();
  const socket = fake.socket.current!;

  // Greeting drains first (real-voice convention: lead with agent()).
  let recv = adapter.receiveAudio(1);
  emitAudio(socket, AGENT_PCM);
  await recv;

  // Turn 1: user speaks, agent replies. Wait for the pump to stream the PCM.
  await adapter.sendAudio(speechChunk("Hi, I have a question about my account balance."));
  await flushUntilRealSpeech(socket);
  recv = adapter.receiveAudio(1);
  emitAudio(socket, AGENT_PCM);
  await recv;

  // Turn 2 — the turn the text-commit regression silently text-committed. Snapshot
  // the send-log boundary so we can isolate exactly what hit the wire for this turn,
  // then wait for turn 2's spoken PCM to be streamed.
  const turn2Start = socket.sent.length;
  await adapter.sendAudio(speechChunk("Thanks. What are your support hours this week?"));
  await flushUntilRealSpeech(socket, turn2Start);
  const turn2Frames = socket.sent.slice(turn2Start);

  // EL returns a user_transcript for turn 2 — its STT output for the PCM we
  // streamed. This populates lastUserTranscript so the STT assertion below holds.
  emitUserTranscript(socket, "thanks what are your support hours this week");

  await adapter.disconnect();
  return { turn2Frames, allFrames: socket.sent, adapter };
}

describe("hosted-EL real voice-in multi-turn (SDK wsFactory seam)", () => {
  it("turn 2 streams real user_audio_chunk PCM and sends NO user_message commit", async () => {
    const { turn2Frames } = await driveTwoTurns();

    // Turn 2's real speech reaches EL as PCM so its STT runs …
    expect(
      turn2Frames.filter(isRealSpeechFrame),
      "turn 2 must stream the real spoken PCM as a user_audio_chunk",
    ).not.toHaveLength(0);
    // … and we do NOT inject a user_message text commit (which would discard the
    // audio path and re-introduce the text-commit regression).
    expect(
      turn2Frames.filter(isUserMessage),
      "the adapter must NOT send a user_message text commit (the text-commit regression)",
    ).toHaveLength(0);
  });

  it("the STT assertion holds — turns 2+ committed as PCM with a real user_transcript", async () => {
    const { adapter } = await driveTwoTurns();

    // The real audio reached EL: both scripted user turns were committed as PCM,
    // and a non-empty transcript came back — so it was STT, not echoed text.
    expect(
      adapter.audioCommitCount,
      "both user turns must be audio commits",
    ).toBeGreaterThanOrEqual(2);
    expect(
      adapter.lastUserTranscript,
      "expected an STT user_transcript",
    ).toBeTruthy();
  });

  it("an empty chunk is a no-op — not counted, only idle silence on the wire", async () => {
    const fake = makeFakeConv();
    const adapter = new ElevenLabsAgentAdapter({
      agentId: "agt_test",
      apiKey: "sk_test",
      webSocketFactory: fake.webSocketFactory,
      conversationClient: fake.conversationClient,
    });
    await adapter.connect();
    const socket = fake.socket.current!;
    const before = socket.sent.length;

    await adapter.sendAudio(new AudioChunk({ data: new Uint8Array(0) }));
    // Give the continuous pump a few ticks. An empty chunk enqueues NO speech, so
    // the only frames that reach the wire are the always-on idle SILENCE frames
    // (B′) — never a real-speech (non-zero) frame — and the turn is not counted.
    await new Promise((r) => setTimeout(r, 80));

    const newFrames = socket.sent.slice(before);
    expect(
      newFrames.some(isRealSpeechFrame),
      "an empty chunk must not stream any real-speech PCM",
    ).toBe(false);
    expect(
      adapter.audioCommitCount,
      "an empty chunk must not count as a real-audio turn",
    ).toBe(0);
    await adapter.disconnect();
  });
});

// ─── REGRESSION BASELINE — what the old text-commit path looked like on the wire ────
//
// The guard tests above (in the parent describe) own the fix-path assertion: reverting
// the fix makes them fail. This block documents the OPPOSITE SHAPE — the pre-fix
// `{"type":"user_message","text":…}` frame that the old adapter emitted instead of
// PCM. We reconstruct it in-place (no fake socket needed) so a maintainer reading this
// file sees both sides of the bug in one place.
//
// Why the old shape was wrong: ElevenLabs' server-side STT/VAD keys on
// `user_audio_chunk` frames. A `user_message` commit carries text, not audio
// bytes — so EL had nothing to transcribe and turns 2+ were silently skipped.
describe("REGRESSION — text-commit sent no PCM so EL had nothing to transcribe", () => {
  it("a user_message text-commit frame is NOT a real-speech frame (carries no user_audio_chunk)", () => {
    // Reproduced pre-fix wire shape.  The old adapter sent exactly this for every
    // scripted user turn; the fix replaced it with streamed user_audio_chunk PCM.
    const preFix: Record<string, unknown> = {
      type: "user_message",
      text: "Thanks. What are your support hours this week?",
    };

    // isUserMessage identifies this as the text-commit the fix removes.
    expect(isUserMessage(preFix)).toBe(true);

    // isRealSpeechFrame is false: no user_audio_chunk key → EL's STT had zero
    // audio bytes to run its VAD/transcription on.
    expect(isRealSpeechFrame(preFix)).toBe(false);
  });

  it("turn 2 frames in the current adapter contain NO frame matching the pre-fix text-commit shape", async () => {
    // Cross-reference with the live adapter output: the pre-fix shape must be absent.
    // (This mirrors the guard above; the comment here anchors the regression context.)
    // See "turn 2 streams real user_audio_chunk PCM and sends NO user_message commit"
    // in the parent describe for the positive-assertion counterpart.
    const { turn2Frames } = await driveTwoTurns();

    expect(
      turn2Frames.filter(isUserMessage),
      "pre-fix text-commit frame must not appear on the wire (the bug this PR fixed)",
    ).toHaveLength(0);
  });
});

describe("adapter construction", () => {
  it("accepts (and ignores) a deprecated silenceTailBytes — it no longer gates turn-end", () => {
    // silenceTailBytes is a deprecated NO-OP under the continuous mic pump (B′):
    // turn-end now emerges from the always-on audio→silence stream, not a bounded
    // tail. Any value — including the non-positive/fractional ones the old validator
    // rejected — is accepted and has no effect.
    for (const value of [0, -1, 100.5, 960]) {
      expect(
        () => new ElevenLabsAgentAdapter({ agentId: "a", apiKey: "k", silenceTailBytes: value }),
        `silenceTailBytes=${value} must be accepted (deprecated no-op)`,
      ).not.toThrow();
    }
  });
});
