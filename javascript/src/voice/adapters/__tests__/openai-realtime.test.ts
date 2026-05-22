/**
 * OpenAIRealtimeAgentAdapter unit scenarios — binds the two @unit
 * scenarios from `specs/voice-agents.feature` tagged `@ts-openai-realtime`.
 *
 * Real WSS to OpenAI's Realtime endpoint is covered by the @e2e demos in
 * `javascript/examples/vitest/tests/voice/openai-realtime-*.test.ts`. The
 * unit layer here drives the adapter against an in-process `ws` server so
 * we can assert wire-protocol behavior (session.update, audio buffer
 * append/commit, conversation.item.create + response.create on sendText,
 * response.cancel on interrupt) without hitting a network.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import { AgentRole } from "../../../domain/agents";
import {
  AdapterCapabilities,
  AudioChunk,
  OPENAI_REALTIME_MODEL,
  OpenAIRealtimeAgentAdapter,
  type OpenAIRealtimeAgentAdapterInit,
  silentChunk,
} from "../../index";

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

interface ServerEvent {
  type: string;
  raw: string;
  data: Record<string, unknown>;
}

interface MockHandle {
  port: number;
  events: ServerEvent[];
  push: (payload: unknown) => void;
  socketReady: Promise<void>;
  reset: () => void;
}

let http: Server;
let wss: WebSocketServer;
let activeSocket: WsServerSocket | null = null;
let socketReadyResolve: (() => void) | null = null;
let socketReady: Promise<void> = new Promise((r) => {
  socketReadyResolve = r;
});
let observedEvents: ServerEvent[] = [];

beforeAll(
  async () =>
    await new Promise<void>((doneStart) => {
      http = createServer();
      wss = new WebSocketServer({ server: http });
      wss.on("connection", (sock) => {
        activeSocket = sock;
        if (socketReadyResolve) socketReadyResolve();
        sock.on("message", (raw) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : Buffer.from(raw as ArrayBuffer).toString("utf8");
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          observedEvents.push({
            type: String(parsed.type ?? ""),
            raw: text,
            data: parsed,
          });
        });
      });
      http.listen(0, "127.0.0.1", doneStart);
    }),
);

afterAll(async () => {
  wss.close();
  await new Promise<void>((done) => http.close(() => done()));
});

function newHandle(): MockHandle {
  observedEvents = [];
  socketReady = new Promise<void>((r) => {
    socketReadyResolve = r;
  });
  return {
    port: (http.address() as AddressInfo).port,
    events: observedEvents,
    push: (payload) => {
      const sock = activeSocket;
      if (!sock) throw new Error("socket not yet connected");
      sock.send(JSON.stringify(payload));
    },
    get socketReady() {
      return socketReady;
    },
    reset: () => {
      observedEvents.length = 0;
    },
  };
}

/**
 * Build an adapter pre-wired to the in-process WS server via the public
 * `url` init knob. No subclassing — keeps tests against the real surface.
 */
function buildAdapter(
  port: number,
  init: Omit<OpenAIRealtimeAgentAdapterInit, "url">,
): OpenAIRealtimeAgentAdapter {
  return new OpenAIRealtimeAgentAdapter({
    ...init,
    url: `ws://127.0.0.1:${port}/realtime?model=${init.model ?? OPENAI_REALTIME_MODEL}`,
  });
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      "OpenAIRealtimeAgentAdapter connects as the agent under test",
      ({ Given, When, Then }) => {
        let handle: MockHandle;
        let adapter: OpenAIRealtimeAgentAdapter;

        Given(
          "an OpenAIRealtimeAgentAdapter with model, voice, instructions, tools",
          () => {
            handle = newHandle();
            adapter = buildAdapter(handle.port, {
              model: OPENAI_REALTIME_MODEL,
              voice: "alloy",
              instructions: "You are a helpful assistant.",
              tools: [{ type: "function", name: "noop" }],
              apiKey: "test-key",
              role: AgentRole.AGENT,
            });

            // Sanity: defaults declare the realtime capability matrix per
            // §5.6 (streaming transcripts, native VAD, first-class interrupt).
            expect(adapter.capabilities).toBeInstanceOf(AdapterCapabilities);
            expect(adapter.capabilities.streamingTranscripts).toBe(true);
            expect(adapter.capabilities.nativeVad).toBe(true);
            expect(adapter.capabilities.interruption).toBe(true);
            expect(adapter.capabilities.dtmf).toBe(false);
            expect(adapter.capabilities.inputFormats).toEqual(["pcm16/24000"]);
            expect(adapter.capabilities.outputFormats).toEqual(["pcm16/24000"]);
            expect(adapter.role).toBe(AgentRole.AGENT);
            // Credentials must never appear in the string form — proves
            // we won't leak the key into logs or error messages.
            expect(adapter.toString()).toContain("api_key='***'");
            expect(adapter.toString()).not.toContain("test-key");
          },
        );

        When("the scenario starts", async () => {
          await adapter.connect();
          await handle.socketReady;
          // Wait until the post-connect `session.update` lands so the
          // assertion in Then doesn't race the network round-trip.
          await waitFor(() =>
            handle.events.some((e) => e.type === "session.update"),
          );
        });

        Then(
          "a realtime session is established and the model IS the agent",
          async () => {
            const sessionUpdate = handle.events.find(
              (e) => e.type === "session.update",
            );
            expect(sessionUpdate).toBeDefined();
            const session = sessionUpdate!.data.session as Record<
              string,
              unknown
            >;
            // GA spec — `session.type === "realtime"`, formats live under
            // `audio.input.format` / `audio.output.format`, voice under
            // `audio.output.voice`, transcription/turn_detection nested
            // under `audio.input`.
            expect(session.type).toBe("realtime");
            expect(session.model).toBe(OPENAI_REALTIME_MODEL);
            const audio = session.audio as Record<string, Record<string, unknown>>;
            expect(audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
            expect(audio.output.format).toEqual({ type: "audio/pcm", rate: 24000 });
            expect(audio.output.voice).toBe("alloy");
            expect(session.instructions).toBe("You are a helpful assistant.");
            expect(session.tools).toEqual([{ type: "function", name: "noop" }]);
            // Server-side VAD off — we own turn boundaries via commit +
            // response.create after each sendAudio.
            expect(audio.input.turn_detection).toBeNull();

            // Drive the audio loop: send a chunk, push an audio delta
            // back, and assert the model's frame becomes an AudioChunk.
            await adapter.sendAudio(silentChunk(0.02));
            await waitFor(() =>
              handle.events.some((e) => e.type === "input_audio_buffer.append"),
            );

            const recvPromise = adapter.receiveAudio(2);
            await waitFor(() =>
              handle.events.some((e) => e.type === "input_audio_buffer.commit"),
            );
            await waitFor(() =>
              handle.events.some((e) => e.type === "response.create"),
            );

            // Push a transcript-delta then an audio-delta from the
            // "model". The adapter should accumulate the transcript and
            // return the decoded PCM16 as an AudioChunk.
            handle.push({
              type: "response.audio_transcript.delta",
              delta: "hello ",
            });
            handle.push({
              type: "response.audio_transcript.delta",
              delta: "world",
            });
            handle.push({
              type: "response.audio_transcript.done",
              transcript: "hello world",
            });

            const pcm = new Uint8Array([0x10, 0x00, 0x20, 0x00]);
            const b64 = Buffer.from(pcm).toString("base64");
            handle.push({ type: "response.audio.delta", delta: b64 });

            const chunk = await recvPromise;
            expect(chunk).toBeInstanceOf(AudioChunk);
            expect(Array.from(chunk.data)).toEqual(Array.from(pcm));
            expect(adapter.lastAgentTranscript).toBe("hello world");

            // First-class interrupt → response.cancel on the wire.
            await adapter.interrupt();
            await waitFor(() =>
              handle.events.some((e) => e.type === "response.cancel"),
            );

            await adapter.disconnect();
          },
        );
      },
    );

    Scenario(
      "OpenAIRealtimeAgentAdapter with role=AgentRole.USER acts as the user simulator",
      ({ Given, When, Then, And }) => {
        let handle: MockHandle;
        let adapter: OpenAIRealtimeAgentAdapter;
        const sentinelText = "i'm trying to reset my password";

        Given(
          'an OpenAIRealtimeAgentAdapter configured with role=AgentRole.USER, voice "nova", instructions "simulate a confused elderly customer"',
          async () => {
            handle = newHandle();
            adapter = buildAdapter(handle.port, {
              voice: "nova",
              instructions: "simulate a confused elderly customer",
              apiKey: "test-key",
              role: AgentRole.USER,
            });
            expect(adapter.role).toBe(AgentRole.USER);
            await adapter.connect();
            await handle.socketReady;
            await waitFor(() =>
              handle.events.some((e) => e.type === "session.update"),
            );
          },
        );

        When("the scenario runs", async () => {
          // sendText is the user-role entry point: it must NOT call into
          // any TTS pipeline (the realtime model synthesizes the voice).
          // No TTS module is imported by this test; the assertion is the
          // shape of the wire events emitted.
          await adapter.sendText(sentinelText);
          await waitFor(
            () =>
              handle.events.some((e) => e.type === "conversation.item.create"),
            500,
          );
          await waitFor(() =>
            handle.events.some((e) => e.type === "response.create"),
          );
        });

        Then(
          "the realtime model drives the user side of the conversation with natural prosody",
          () => {
            const itemEvt = handle.events.find(
              (e) => e.type === "conversation.item.create",
            );
            expect(itemEvt).toBeDefined();
            const item = itemEvt!.data.item as {
              type?: string;
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
            // User-role contract: the message is created as a user item
            // with input_text content — the realtime model converts that
            // into audio output (the prosody-bearing channel) on its own.
            expect(item.type).toBe("message");
            expect(item.role).toBe("user");
            expect(item.content).toEqual([
              { type: "input_text", text: sentinelText },
            ]);

            // response.create must follow, otherwise the model never
            // produces audio for the scripted line.
            const order = handle.events.map((e) => e.type);
            const itemIdx = order.indexOf("conversation.item.create");
            const respIdx = order.indexOf("response.create", itemIdx + 1);
            expect(respIdx).toBeGreaterThan(itemIdx);
          },
        );

        And("text TTS is bypassed for the user simulator", async () => {
          // Strongest assertion we can make at the unit layer without a
          // running TTS module: the adapter NEVER emitted
          // `input_audio_buffer.append` for the scripted line, which is
          // the wire signal that TTS would have produced. The model
          // synthesizes prosody from `input_text` instead.
          const hadTtsAudio = handle.events.some(
            (e) => e.type === "input_audio_buffer.append",
          );
          expect(hadTtsAudio).toBe(false);
          await adapter.disconnect();
        });
      },
    );
  },
  { includeTags: [["unit", "ts-openai-realtime"]] },
);

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
