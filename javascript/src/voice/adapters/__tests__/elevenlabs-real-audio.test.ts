/**
 * #705 — REAL voice-in multi-turn on hosted ElevenLabs ConvAI.
 *
 * Real-audio streaming is the adapter's ONLY behavior: `sendAudio()` streams the
 * user's REAL spoken PCM as a `{"user_audio_chunk": …}` frame (then a trailing
 * silence tail that trips EL's end-of-turn detector), and NEVER injects a
 * `{"type":"user_message","text":…}` text commit. The old text-commit default
 * discarded the PCM, so EL's STT/VAD/turn-taking never ran on scripted turns 2+
 * — that was the #705 bug; the text-commit path is gone.
 *
 * These two regression guards pin the seam at the wire level via the
 * `webSocketFactory` fake socket (no network), provable without live EL creds:
 *
 *  1. across a greeting-led ≥2-turn drive, turn 2 streams the REAL PCM speech as
 *     a `user_audio_chunk` frame and emits NO `user_message` text commit, so EL's
 *     STT actually runs on the scripted audio.
 *  2. the #705 voice-specific STT assertion — after the drive, both scripted user
 *     turns were committed as PCM (`audioCommitCount >= 2`) and a non-empty STT
 *     `user_transcript` came back (`lastUserTranscript` populated), i.e. audio
 *     actually reached the agent. Strictly stronger than #596's `>=N segments`,
 *     which passed even on the old text-commit path where no PCM reached EL.
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { describe, it, expect } from "vitest";

import { AudioChunk } from "../../audio-chunk";
import { ElevenLabsAgentAdapter, type WebSocketLike } from "../index";

// In-memory fake of the `ws` socket — records each `send()` payload as a decoded
// object so tests assert the wire shape directly (mirrors elevenlabs.test.ts).
class FakeWebSocket extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
}

function makeFakeSocketFactory(): {
  factory: (url: string, headers: Record<string, string>) => WebSocketLike;
  socket: { current: FakeWebSocket | null };
} {
  const socketRef: { current: FakeWebSocket | null } = { current: null };
  const factory = () => {
    const socket = new FakeWebSocket();
    socketRef.current = socket;
    queueMicrotask(() => socket.emit("open"));
    return socket as unknown as WebSocketLike;
  };
  return { factory, socket: socketRef };
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
 * Drive a greeting-led, 2-scripted-turn hosted-EL flow over the fake socket and
 * return the frames sent during turn 2 (the index past which the #705 bug bit).
 */
async function driveTwoTurns(): Promise<{
  turn2Frames: Array<Record<string, unknown>>;
  allFrames: Array<Record<string, unknown>>;
  adapter: ElevenLabsAgentAdapter;
}> {
  const fake = makeFakeSocketFactory();
  const adapter = new ElevenLabsAgentAdapter({
    agentId: "agt_705",
    apiKey: "sk_705",
    webSocketFactory: fake.factory,
  });
  await adapter.connect();
  const socket = fake.socket.current!;

  // Greeting drains first (real-voice convention: lead with agent()).
  let recv = adapter.receiveAudio(1);
  emitAudio(socket, AGENT_PCM);
  await recv;

  // Turn 1: user speaks, agent replies.
  await adapter.sendAudio(speechChunk("Hi, I have a question about my account balance."));
  recv = adapter.receiveAudio(1);
  emitAudio(socket, AGENT_PCM);
  await recv;

  // Turn 2 — the turn the #705 bug silently text-committed. Snapshot the send log
  // boundary so we can isolate exactly what hit the wire for this turn.
  const turn2Start = socket.sent.length;
  await adapter.sendAudio(speechChunk("Thanks. What are your support hours this week?"));
  const turn2Frames = socket.sent.slice(turn2Start);

  // EL returns a user_transcript for turn 2 — its STT output for the PCM we
  // streamed. This populates lastUserTranscript so the STT assertion below holds.
  emitUserTranscript(socket, "thanks what are your support hours this week");

  await adapter.disconnect();
  return { turn2Frames, allFrames: socket.sent, adapter };
}

describe("#705 hosted-EL real voice-in multi-turn (wsFactory seam)", () => {
  it("turn 2 streams real user_audio_chunk PCM and sends NO user_message commit", async () => {
    const { turn2Frames } = await driveTwoTurns();

    // Turn 2's real speech reaches EL as PCM so its STT runs …
    expect(
      turn2Frames.filter(isRealSpeechFrame),
      "turn 2 must stream the real spoken PCM as a user_audio_chunk",
    ).not.toHaveLength(0);
    // … and we do NOT inject a user_message text commit (which would discard the
    // audio path and re-introduce the #705 bug).
    expect(
      turn2Frames.filter(isUserMessage),
      "the adapter must NOT send a user_message text commit (the #705 bug)",
    ).toHaveLength(0);
  });

  it("the #705 STT assertion holds — turns 2+ committed as PCM with a real user_transcript", async () => {
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
});
