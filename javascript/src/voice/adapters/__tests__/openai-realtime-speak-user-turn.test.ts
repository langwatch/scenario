/**
 * Unit coverage for `OpenAIRealtimeAgentAdapter.speakUserTurn` (#705) — the
 * realtime-USER bridge the executor uses to feed a realtime user's spoken audio
 * into a SEPARATE agent under test (e.g. hosted ElevenLabs) through
 * `scenario.run()`.
 *
 * Drives the adapter against an in-process `ws` server (no network), asserting:
 *  - speak path emits exactly ONE `response.create` with `conversation:'none'`,
 *    `input:[]`, `output_modalities:['audio']`, and verbatim `instructions` — and
 *    NO `conversation.item.create` (emitting that item would make the model
 *    answer the line instead of speaking it verbatim);
 *  - the spoken-audio deltas the "model" pushes back are merged into ONE chunk;
 *  - the chunk carries the model's spoken transcript (from
 *    `response.output_audio_transcript.done`), with the scripted text as fallback.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import { AgentRole } from "../../../domain/agents";
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

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buildAdapter(port: number): OpenAIRealtimeAgentAdapter {
  return new OpenAIRealtimeAgentAdapter({
    model: OPENAI_REALTIME_MODEL,
    voice: "marin",
    instructions: "simulate a customer",
    apiKey: "test-key",
    role: AgentRole.USER,
    url: `ws://127.0.0.1:${port}/realtime?model=${OPENAI_REALTIME_MODEL}`,
  });
}

describe("OpenAIRealtimeAgentAdapter.speakUserTurn (#705 bridge)", () => {
  it("speaks the line, drains spoken audio, returns merged PCM + spoken transcript", async () => {
    observed = [];
    socketReady = new Promise<void>((r) => {
      socketReadyResolve = r;
    });
    const adapter = buildAdapter((http.address() as AddressInfo).port);
    await adapter.connect();
    await socketReady;
    await waitFor(() => observed.some((e) => e.type === "session.update"));

    // Kick off the turn; resolve after the merged chunk comes back.
    const turnPromise = adapter.speakUserTurn("hi, a question about my account", 1);

    // VERBATIM path: a single response.create carrying an `instructions`
    // override that quotes the line — and NO conversation.item.create (that
    // would make the model ANSWER the line instead of speaking it, #705).
    await waitFor(() => observed.some((e) => e.type === "response.create"));
    const respEvt = observed.find((e) => e.type === "response.create")!;
    const resp = respEvt.data.response as {
      instructions?: string;
      conversation?: string;
      input?: unknown[];
      output_modalities?: string[];
    };
    expect(typeof resp.instructions).toBe("string");
    expect(resp.instructions).toContain("hi, a question about my account");
    // Persona anchor (#705 regression guard): the session `instructions` persona
    // MUST be present in the per-response instructions. A per-response
    // `instructions` OVERRIDES the session default, and conversation:"none" +
    // input:[] strip session context — so dropping the persona here leaves the
    // model with no domain anchor and it renders a wrong opener.
    expect(resp.instructions).toContain("simulate a customer");
    // Isolation contract (#705): out-of-band + no prior context + audio out, so
    // accumulated history can't make the model answer the line by ~turn 3.
    expect(resp.conversation).toBe("none");
    expect(resp.input).toEqual([]);
    expect(resp.output_modalities).toEqual(["audio"]);
    expect(observed.some((e) => e.type === "conversation.item.create")).toBe(false);

    // Model speaks: transcript-done then two audio deltas (GA event names).
    push({
      type: "response.output_audio_transcript.done",
      transcript: "Hi, I have a question about my account.",
    });
    const a = new Uint8Array([0x01, 0x00, 0x02, 0x00]);
    const b = new Uint8Array([0x03, 0x00, 0x04, 0x00]);
    push({ type: "response.output_audio.delta", delta: Buffer.from(a).toString("base64") });
    push({ type: "response.output_audio.delta", delta: Buffer.from(b).toString("base64") });
    // No further deltas → the per-frame idle timeout ends the turn.

    const chunk = await turnPromise;
    // Merged PCM = a ++ b.
    expect(Array.from(chunk.data)).toEqual([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00]);
    // Spoken transcript, NOT the scripted text.
    expect(chunk.transcript).toBe("Hi, I have a question about my account.");

    await adapter.disconnect();
  });

  it("falls back to the scripted text when the model emits no transcript", async () => {
    observed = [];
    socketReady = new Promise<void>((r) => {
      socketReadyResolve = r;
    });
    const adapter = buildAdapter((http.address() as AddressInfo).port);
    await adapter.connect();
    await socketReady;
    await waitFor(() => observed.some((e) => e.type === "session.update"));

    const turnPromise = adapter.speakUserTurn("reset my password please", 1);
    await waitFor(() => observed.some((e) => e.type === "response.create"));

    const a = new Uint8Array([0x05, 0x00]);
    push({ type: "response.output_audio.delta", delta: Buffer.from(a).toString("base64") });
    // No transcript event at all.

    const chunk = await turnPromise;
    expect(Array.from(chunk.data)).toEqual([0x05, 0x00]);
    expect(chunk.transcript).toBe("reset my password please");

    await adapter.disconnect();
  });
});
