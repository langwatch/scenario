/**
 * #705 — REAL voice-in multi-turn on hosted ElevenLabs ConvAI.
 *
 * The transport-level bug (prompt-independent): with the default
 * `turnCommitMode: "text"` (the default since #596), `sendAudio()` commits a
 * scripted user turn by sending `{"type":"user_message","text":<transcript>}`
 * and RETURNS — the PCM speech is discarded. EL's STT/VAD/turn-taking never run
 * on scripted turns, so turns 2+ get a text-injected response, NOT an
 * ASR-driven one.
 *
 * These two tests pin the seam at the wire level via the `webSocketFactory`
 * fake socket (no network), so the bug and the fix are both provable without
 * live EL creds:
 *
 *  1. `text` mode (CHARACTERIZATION of the bug) — turns 2+ emit a `user_message`
 *     text commit and NO `user_audio_chunk` PCM. Passes today; documents what
 *     the customer hits.
 *  2. `audio` mode (the FIX, AC3) — turns 2+ stream the REAL PCM speech as
 *     `user_audio_chunk` frames and emit NO `user_message` text commit, so EL's
 *     STT actually runs on the scripted audio. This is the failing→passing
 *     demonstration AC1 requires: RED until AC3 lands the `"audio"` commit mode,
 *     GREEN after.
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
 * return the frames sent during turn 2 (the index past which the bug bites).
 */
async function driveTwoTurns(
  turnCommitMode: "text" | "audio",
): Promise<{ turn2Frames: Array<Record<string, unknown>>; allFrames: Array<Record<string, unknown>> }> {
  const fake = makeFakeSocketFactory();
  const adapter = new ElevenLabsAgentAdapter({
    agentId: "agt_705",
    apiKey: "sk_705",
    turnCommitMode,
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

  // Turn 2 — the turn the #705 bug silently text-commits. Snapshot the send log
  // boundary so we can isolate exactly what hit the wire for this turn.
  const turn2Start = socket.sent.length;
  await adapter.sendAudio(speechChunk("Thanks. What are your support hours this week?"));
  const turn2Frames = socket.sent.slice(turn2Start);

  await adapter.disconnect();
  return { turn2Frames, allFrames: socket.sent };
}

describe("#705 hosted-EL real voice-in multi-turn (wsFactory seam)", () => {
  it("CHARACTERIZATION — text mode (default) discards turn-2 PCM and commits user_message text (the bug)", async () => {
    const { turn2Frames } = await driveTwoTurns("text");

    // The bug: turn 2 commits the transcript as text …
    expect(
      turn2Frames.filter(isUserMessage),
      "expected a user_message text commit on turn 2 in text mode",
    ).toHaveLength(1);
    // … and sends NO real PCM, so EL's STT never sees the scripted audio.
    expect(
      turn2Frames.filter(isRealSpeechFrame),
      "text mode must NOT stream real user_audio_chunk PCM (that is the #705 bug)",
    ).toHaveLength(0);
  });

  it("FIX (AC3) — audio mode streams real turn-2 user_audio_chunk PCM and sends NO user_message commit", async () => {
    const { turn2Frames } = await driveTwoTurns("audio");

    // The fix: turn 2's real speech reaches EL as PCM so its STT runs …
    expect(
      turn2Frames.filter(isRealSpeechFrame),
      "audio mode must stream the real spoken PCM as a user_audio_chunk on turn 2",
    ).not.toHaveLength(0);
    // … and we do NOT inject a user_message text commit (which would discard the
    // audio path and re-introduce the #705 bug).
    expect(
      turn2Frames.filter(isUserMessage),
      "audio mode must NOT send a user_message text commit on turn 2",
    ).toHaveLength(0);
  });
});
