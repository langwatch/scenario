/**
 * Autonomous realtime-USER `call()` (#705 faithful fix) — REVERSED from the
 * prior guard.
 *
 * This file USED to assert that `OpenAIRealtimeAgentAdapter.call()` with
 * `role=USER` fails loud (autonomous drive "not supported yet"). The #705 fix
 * makes that path WORK: `call(role=USER)` now HEARS the agent-under-test's last
 * turn (appends its audio) and SPEAKS a GENERATIVE next customer line — exactly
 * ONE in-context `response.create` (fork B), drained into one `role:"user"`
 * audio message. So the assertions are inverted: we prove the autonomous turn is
 * produced, not rejected.
 *
 * Drives the adapter against an in-process `ws` server (no network, no keys) —
 * same harness as `openai-realtime-speak-user-turn.test.ts`. Coverage:
 *  - AC1: ONE GENERATIVE `response.create` — `output_modalities:["audio"]`, the
 *    customer-nudge instructions, and NOT the `_speakVerbatim` isolation
 *    (`conversation:"none"` + `input:[]`); returns one `role:"user"` audio msg.
 *  - AC1/R7: audio present but NO transcript event → still returns a user audio
 *    turn (empty/neutral transcript), never throws — audio-presence is the gate.
 *  - AC2: the emitted `input_audio_buffer.append` payload EQUALS the heard
 *    chunk's bytes, and fires BEFORE the `response.create`; absent heard audio,
 *    no append fires and the turn still returns audio.
 *  - Must-Fix 1 (no cross-turn bleed): two consecutive `call(role=USER)` with
 *    DIFFERENT heard chunks — each emits exactly ONE `response.create`; turn-2's
 *    append carries turn-2's bytes (not turn-1's) and turn-2's transcript is its
 *    own (the `lastAgentTranscript` reset, the commit-`7d0d02d`-class fix).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import { AgentRole, type AgentInput } from "../../../domain/agents";
import { AudioChunk } from "../../audio-chunk";
import { createAudioMessage, extractAudio } from "../../messages";
import { OPENAI_REALTIME_MODEL, OpenAIRealtimeAgentAdapter } from "../../index";

let http: Server;
let wss: WebSocketServer;
let activeSocket: WsServerSocket | null = null;
let socketReadyResolve: (() => void) | null = null;
let socketReady: Promise<void> = new Promise((r) => {
  socketReadyResolve = r;
});
let observed: Array<{ type: string; data: Record<string, unknown> }> = [];

beforeAll(
  async () =>
    await new Promise<void>((doneStart) => {
      http = createServer();
      wss = new WebSocketServer({ server: http });
      wss.on("connection", (sock) => {
        activeSocket = sock;
        socketReadyResolve?.();
        sock.on("message", (raw) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : Buffer.from(raw as ArrayBuffer).toString("utf8");
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            observed.push({ type: String(parsed.type ?? ""), data: parsed });
          } catch {
            /* drop non-JSON */
          }
        });
      });
      http.listen(0, "127.0.0.1", doneStart);
    }),
);

afterAll(async () => {
  wss.close();
  await new Promise<void>((done) => http.close(() => done()));
});

function push(payload: unknown): void {
  if (!activeSocket) throw new Error("socket not connected");
  activeSocket.send(JSON.stringify(payload));
}

/** Push an audio delta. An EMPTY string decodes to a 0-length chunk — the
 * adapter's drain loop treats that as end-of-turn, so it terminates the turn
 * promptly without waiting out the per-frame idle timeout. */
function pushDelta(bytes: Uint8Array | ""): void {
  const delta = bytes === "" ? "" : Buffer.from(bytes).toString("base64");
  push({ type: "response.output_audio.delta", delta });
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buildAdapter(port: number, role: AgentRole): OpenAIRealtimeAgentAdapter {
  return new OpenAIRealtimeAgentAdapter({
    model: OPENAI_REALTIME_MODEL,
    voice: "marin",
    instructions: "You are a customer calling your bank's support line.",
    apiKey: "test-key",
    role,
    url: `ws://127.0.0.1:${port}/realtime?model=${OPENAI_REALTIME_MODEL}`,
  });
}

/** Build an AgentInput whose last newMessage carries `heard` as the agent's
 * audio turn — the audio the realtime USER "hears" and replies to. */
function inputHearing(heard: Uint8Array | null): AgentInput {
  const newMessages = heard
    ? [createAudioMessage(new AudioChunk({ data: heard }), "assistant")]
    : [];
  return {
    threadId: "t",
    messages: [],
    newMessages,
    requestedRole: AgentRole.USER,
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
  };
}

async function connectUser(): Promise<OpenAIRealtimeAgentAdapter> {
  observed = [];
  socketReady = new Promise<void>((r) => {
    socketReadyResolve = r;
  });
  const adapter = buildAdapter((http.address() as AddressInfo).port, AgentRole.USER);
  await adapter.connect();
  await socketReady;
  await waitFor(() => observed.some((e) => e.type === "session.update"));
  return adapter;
}

function appendFrames(): Array<{ type: string; data: Record<string, unknown> }> {
  return observed.filter((e) => e.type === "input_audio_buffer.append");
}

function responseCreateFrames(): Array<{ type: string; data: Record<string, unknown> }> {
  return observed.filter((e) => e.type === "response.create");
}

function appendedBytes(frame: { data: Record<string, unknown> }): number[] {
  return Array.from(Buffer.from(String(frame.data.audio ?? ""), "base64"));
}

describe("OpenAIRealtimeAgentAdapter.call() autonomous realtime-user (#705)", () => {
  it("AC1: emits ONE GENERATIVE response.create (audio, in-context, NOT the verbatim isolation) and returns a user audio turn", async () => {
    const adapter = await connectUser();
    const heard = new Uint8Array([0xaa, 0xaa, 0xbb, 0xbb]);

    const turn = adapter.call(inputHearing(heard));
    await waitFor(() => observed.some((e) => e.type === "response.create"));

    // Exactly ONE response.create, and it is the GENERATIVE shape.
    expect(responseCreateFrames()).toHaveLength(1);
    const resp = responseCreateFrames()[0]!.data.response as {
      instructions?: string;
      conversation?: string;
      input?: unknown[];
      output_modalities?: string[];
    };
    // (a) Customer-nudge instructions — POSITIVE observable, not a verbatim quote.
    expect(typeof resp.instructions).toBe("string");
    expect(resp.instructions).toMatch(/you are the customer/i);
    expect(resp.instructions).toMatch(/next line/i);
    // Persona anchor (#705 regression guard): the session `instructions` persona
    // MUST be present in the per-response instructions. A per-response
    // `instructions` OVERRIDES the session default, so dropping it strips the
    // customer's domain/goal on every proceed() turn.
    expect(resp.instructions).toContain(
      "You are a customer calling your bank's support line.",
    );
    // (b) Spoken (audio) reply.
    expect(resp.output_modalities).toEqual(["audio"]);
    // (c) In-context (fork B): does NOT carry the _speakVerbatim isolation, so
    //     the committed heard audio + history condition the reply.
    expect(resp.conversation).toBeUndefined();
    expect(resp.input).toBeUndefined();
    // The generative path never injects a user conversation item (that would
    // make the model ANSWER as the agent).
    expect(observed.some((e) => e.type === "conversation.item.create")).toBe(false);

    // Model speaks: transcript-done then two deltas, then an empty terminator.
    push({
      type: "response.output_audio_transcript.done",
      transcript: "Hi, I want to check my balance.",
    });
    pushDelta(new Uint8Array([0x01, 0x00]));
    pushDelta(new Uint8Array([0x02, 0x00]));
    pushDelta("");

    const message = await turn;
    expect((message as { role?: string }).role).toBe("user");
    const chunk = extractAudio(message);
    expect(chunk).not.toBeNull();
    expect(Array.from(chunk!.data)).toEqual([0x01, 0x00, 0x02, 0x00]);
    expect(chunk!.transcript).toBe("Hi, I want to check my balance.");

    await adapter.disconnect();
  });

  it("AC2: the input_audio_buffer.append payload EQUALS the heard bytes and fires BEFORE response.create", async () => {
    const adapter = await connectUser();
    const heard = new Uint8Array([0x10, 0x11, 0x12, 0x13, 0x14, 0x15]);

    const turn = adapter.call(inputHearing(heard));
    await waitFor(() => observed.some((e) => e.type === "response.create"));

    const appends = appendFrames();
    expect(appends).toHaveLength(1);
    // Payload EQUALITY — not merely "an append fired".
    expect(appendedBytes(appends[0]!)).toEqual(Array.from(heard));
    // Heard audio is appended (and committed) BEFORE the generative response.
    const appendIdx = observed.findIndex((e) => e.type === "input_audio_buffer.append");
    const commitIdx = observed.findIndex((e) => e.type === "input_audio_buffer.commit");
    const respIdx = observed.findIndex((e) => e.type === "response.create");
    expect(appendIdx).toBeLessThan(commitIdx);
    expect(commitIdx).toBeLessThan(respIdx);

    pushDelta(new Uint8Array([0x07, 0x00]));
    pushDelta("");
    await turn;
    await adapter.disconnect();
  });

  it("AC2: no heard audio → no append fires, and the turn still returns a user audio message", async () => {
    const adapter = await connectUser();

    const turn = adapter.call(inputHearing(null));
    await waitFor(() => observed.some((e) => e.type === "response.create"));

    expect(appendFrames()).toHaveLength(0);
    expect(observed.some((e) => e.type === "input_audio_buffer.commit")).toBe(false);
    expect(responseCreateFrames()).toHaveLength(1);

    push({ type: "response.output_audio_transcript.done", transcript: "Hello there." });
    pushDelta(new Uint8Array([0x09, 0x00]));
    pushDelta("");

    const message = await turn;
    expect((message as { role?: string }).role).toBe("user");
    expect(extractAudio(message)!.data.length).toBeGreaterThan(0);

    await adapter.disconnect();
  });

  it("AC1/R7: audio present but NO transcript event → returns a user audio turn with empty transcript, never throws", async () => {
    const adapter = await connectUser();

    const turn = adapter.call(inputHearing(new Uint8Array([0x01, 0x02])));
    await waitFor(() => observed.some((e) => e.type === "response.create"));

    // Audio but NO transcript.done.
    pushDelta(new Uint8Array([0x21, 0x00]));
    pushDelta("");

    const message = await turn; // must NOT reject
    expect((message as { role?: string }).role).toBe("user");
    const chunk = extractAudio(message);
    expect(chunk).not.toBeNull();
    expect(chunk!.data.length).toBeGreaterThan(0);
    // Audio-presence is the gate, not transcript-presence: neutral/empty text.
    expect(chunk!.transcript ?? "").toBe("");

    await adapter.disconnect();
  });

  it("does NOT route role=AGENT through the autonomous-user path", async () => {
    // A role=AGENT adapter is a normal agent under test. Unconnected, its call()
    // must fail for a transport reason (the connected-state gate) — it must NOT
    // produce a user audio turn (the role=USER autonomous path).
    const adapter = buildAdapter(
      (http.address() as AddressInfo).port,
      AgentRole.AGENT,
    );
    await expect(
      adapter.call({
        threadId: "t",
        messages: [],
        newMessages: [],
        requestedRole: AgentRole.AGENT,
        scenarioState: {} as AgentInput["scenarioState"],
        scenarioConfig: {} as AgentInput["scenarioConfig"],
      }),
    ).rejects.toThrow();
  });
});

describe("autonomous realtime-user: no cross-turn bleed (#705 Must-Fix 1)", () => {
  it("two consecutive call(role=USER) — each ONE response.create; turn-2 append + transcript are turn-2's own", async () => {
    const adapter = await connectUser();

    // ---- Turn 1 ----
    const heard1 = new Uint8Array([0xaa, 0xaa, 0xbb, 0xbb]);
    const turn1 = adapter.call(inputHearing(heard1));
    await waitFor(() => observed.some((e) => e.type === "response.create"));
    expect(responseCreateFrames()).toHaveLength(1);
    expect(appendedBytes(appendFrames()[0]!)).toEqual(Array.from(heard1));
    push({
      type: "response.output_audio_transcript.done",
      transcript: "turn one customer line",
    });
    pushDelta(new Uint8Array([0x01, 0x00]));
    pushDelta("");
    const msg1 = await turn1;
    expect(extractAudio(msg1)!.transcript).toBe("turn one customer line");

    // Reset the observed-frame log so turn-2 assertions see ONLY turn-2 frames.
    observed = [];

    // ---- Turn 2 (DIFFERENT heard bytes, its OWN transcript) ----
    const heard2 = new Uint8Array([0xcc, 0xcc, 0xdd, 0xdd]);
    const turn2 = adapter.call(inputHearing(heard2));
    await waitFor(() => observed.some((e) => e.type === "response.create"));

    // Exactly ONE generative response.create for turn 2 (no second, bare one
    // from the drain's auto-commit — the heard-buffer reset prevents it).
    expect(responseCreateFrames()).toHaveLength(1);
    // turn-2's append carries turn-2's bytes, NOT turn-1's (heard-buffer no-bleed).
    expect(appendFrames()).toHaveLength(1);
    expect(appendedBytes(appendFrames()[0]!)).toEqual(Array.from(heard2));
    expect(appendedBytes(appendFrames()[0]!)).not.toEqual(Array.from(heard1));

    push({
      type: "response.output_audio_transcript.done",
      transcript: "turn two customer line",
    });
    pushDelta(new Uint8Array([0x03, 0x00]));
    pushDelta("");
    const msg2 = await turn2;
    // turn-2's transcript reflects turn-2's transcript.done — no bleed from turn-1.
    expect(extractAudio(msg2)!.transcript).toBe("turn two customer line");
    expect(extractAudio(msg2)!.transcript).not.toBe("turn one customer line");

    await adapter.disconnect();
  });

  it("turn-2 emitting NO transcript does not inherit turn-1's (lastAgentTranscript reset)", async () => {
    const adapter = await connectUser();

    // ---- Turn 1: a real transcript ----
    const turn1 = adapter.call(inputHearing(new Uint8Array([0x01, 0x02])));
    await waitFor(() => observed.some((e) => e.type === "response.create"));
    push({
      type: "response.output_audio_transcript.done",
      transcript: "turn one customer line",
    });
    pushDelta(new Uint8Array([0x01, 0x00]));
    pushDelta("");
    expect(extractAudio(await turn1)!.transcript).toBe("turn one customer line");

    observed = [];

    // ---- Turn 2: audio only, NO transcript.done ----
    const turn2 = adapter.call(inputHearing(new Uint8Array([0x03, 0x04])));
    await waitFor(() => observed.some((e) => e.type === "response.create"));
    pushDelta(new Uint8Array([0x05, 0x00]));
    pushDelta("");
    const chunk2 = extractAudio(await turn2);
    // The reset means turn-2 falls back to NEUTRAL, never turn-1's line.
    expect(chunk2!.transcript ?? "").toBe("");
    expect(chunk2!.transcript ?? "").not.toBe("turn one customer line");

    await adapter.disconnect();
  });
});
