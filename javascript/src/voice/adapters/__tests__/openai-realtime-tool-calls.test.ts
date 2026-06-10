/**
 * Issue #630 — realtime tool-call surfacing for OpenAIRealtimeAgentAdapter (JS).
 *
 * The Realtime API emits function-call (tool-call) events
 * (`response.function_call_arguments.delta`/`.done` and the
 * `response.output_item.added`/`.done` function_call item form). Before this
 * fix those events fell into `receiveAudio`'s housekeeping fall-through and
 * were dropped — never reaching the run's messages. This module proves they
 * now land as the JS-native consumer shape: a `role:"tool"` `ToolModelMessage`
 * whose content carries `{ type:"tool-result", toolName, toolCallId, output }`
 * parts — exactly what `ScenarioExecutionState.hasToolCall` /
 * `lastToolCall` match (`part.type === "tool-result" && part.toolName === T`).
 *
 * Mock strategy: an in-process `ws` server stands in for the OpenAI Realtime
 * endpoint (the same harness `openai-realtime.test.ts` uses). The adapter's
 * `call()` drives a real turn over that socket; the test pushes audio deltas
 * (so the drain terminates) interleaved with the function-call events, then
 * inspects the returned message list and the live `ScenarioExecutionState`
 * consumer.
 *
 * Why test `call()` (not `receiveAudio` directly): the surfacing crosses a
 * layer — `receiveAudio` accumulates, `call()` drains + assembles the tool
 * message, and the executor stores a list return. Driving `call()` and feeding
 * the assembled message into a real `ScenarioExecutionState` exercises the
 * whole wire, not one endpoint.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ModelMessage, ToolModelMessage } from "ai";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import type { ScenarioConfig } from "../../../domain";
import { AgentRole } from "../../../domain/agents";
import type { AgentInput } from "../../../domain/agents";
import { ScenarioExecutionState } from "../../../execution/scenario-execution-state";
import { AudioChunk } from "../../audio-chunk";
import { createAudioMessage } from "../../messages";
import {
  OpenAIRealtimeAgentAdapter,
  type OpenAIRealtimeAgentAdapterInit,
} from "../openai-realtime";

// ---------------------------------------------------------------------------
// In-process WS server harness (mirrors openai-realtime.test.ts).
// ---------------------------------------------------------------------------

let http: Server;
let wss: WebSocketServer;
let activeSocket: WsServerSocket | null = null;
let socketReadyResolve: (() => void) | null = null;
let socketReady: Promise<void> = new Promise((r) => {
  socketReadyResolve = r;
});
let observedTypes: string[] = [];

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
          try {
            observedTypes.push(String(JSON.parse(text).type ?? ""));
          } catch {
            /* ignore non-JSON */
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

beforeEach(() => {
  observedTypes = [];
  activeSocket = null;
  socketReady = new Promise<void>((r) => {
    socketReadyResolve = r;
  });
});

function port(): number {
  return (http.address() as AddressInfo).port;
}

function push(payload: unknown): void {
  if (!activeSocket) throw new Error("socket not yet connected");
  activeSocket.send(JSON.stringify(payload));
}

async function waitForType(type: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!observedTypes.includes(type)) {
    if (Date.now() > deadline) throw new Error(`waitForType: ${type} timed out`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Like {@link waitForType} but only counts events recorded after `since`. */
async function waitForTypeSince(
  type: string,
  since: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!observedTypes.slice(since).includes(type)) {
    if (Date.now() > deadline) throw new Error(`waitForType: ${type} timed out`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function buildAdapter(
  init: Omit<OpenAIRealtimeAgentAdapterInit, "url">,
): OpenAIRealtimeAgentAdapter {
  const a = new OpenAIRealtimeAgentAdapter({
    ...init,
    url: `ws://127.0.0.1:${port()}/realtime?model=test`,
  });
  // Keep the tail-silence drain short so each call() turn returns fast.
  a.responseTailSilence = 0.05;
  a.responseTimeout = 2;
  return a;
}

// ---------------------------------------------------------------------------
// Audio + function-call wire-event builders.
// ---------------------------------------------------------------------------

/** Minimal even-byte PCM16 frame (the AudioChunk ctor rejects odd byte counts). */
const PCM_B64 = Buffer.from(new Uint8Array([0x10, 0x00, 0x20, 0x00])).toString(
  "base64",
);

/** One audio delta so the drain has at least one chunk to return + terminate. */
function pushAudioDelta(): void {
  push({ type: "response.output_audio.delta", delta: PCM_B64 });
}

/**
 * The streaming-args form of a function call: name via the output_item shell,
 * arguments split across two deltas, finalized on `.done`.
 */
function pushStreamingCall(callId: string, name: string, args: string): void {
  const mid = Math.floor(args.length / 2);
  push({
    type: "response.output_item.added",
    item: { type: "function_call", name, call_id: callId },
  });
  push({
    type: "response.function_call_arguments.delta",
    call_id: callId,
    delta: args.slice(0, mid),
  });
  push({
    type: "response.function_call_arguments.delta",
    call_id: callId,
    delta: args.slice(mid),
  });
  push({
    type: "response.function_call_arguments.done",
    call_id: callId,
    arguments: args,
  });
}

/** The output-item form: a single `response.output_item.done` carrying it all. */
function pushOutputItemCall(callId: string, name: string, args: string): void {
  push({
    type: "response.output_item.done",
    item: { type: "function_call", name, call_id: callId, arguments: args },
  });
}

// ---------------------------------------------------------------------------
// Drive a full call() turn: connect, run call(), push the wire events once the
// model's response.create lands, return the message list.
// ---------------------------------------------------------------------------

function fakeInput(): AgentInput {
  // A user audio message in newMessages → defaultVoiceCall calls sendAudio,
  // which makes receiveAudio commit + emit `response.create` (the JS adapter
  // only requests a response when pending audio exists). That `response.create`
  // is the wire signal the test waits on before feeding the model's reply.
  const userAudio = createAudioMessage(
    new AudioChunk({ data: new Uint8Array([0x00, 0x00, 0x00, 0x00]) }),
    "user",
  );
  return {
    threadId: "t-tool",
    messages: [userAudio as ModelMessage],
    newMessages: [userAudio as ModelMessage],
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as never,
    scenarioConfig: {} as never,
  };
}

/**
 * Run ONE `call()` turn on an already-connected adapter: start the call, wait
 * until the adapter has requested a response on the wire (`response.create`
 * past the given watermark — so repeated turns don't match a prior turn's
 * event), then feed the model's reply, and return the message list.
 */
async function feedAndCall(
  adapter: OpenAIRealtimeAgentAdapter,
  feedEvents: () => void,
): Promise<ModelMessage[]> {
  const watermark = observedTypes.length;
  const callPromise = adapter.call(fakeInput());
  // call() → defaultVoiceCall sends the user audio, then receiveAudio commits +
  // emits `response.create`. Once that lands, feed audio + function-call events.
  await waitForTypeSince("response.create", watermark);
  feedEvents();
  const result = await callPromise;
  // call() returns either a single ModelMessage (no tools) or a list.
  return Array.isArray(result) ? result : [result as ModelMessage];
}

async function runTurn(
  adapter: OpenAIRealtimeAgentAdapter,
  feedEvents: () => void,
): Promise<ModelMessage[]> {
  await adapter.connect();
  await socketReady;
  await waitForType("session.update");
  const result = await feedAndCall(adapter, feedEvents);
  await adapter.disconnect();
  return result;
}

/** Pull the first `role:"tool"` message out of a call() return list. */
function toolMessageOf(messages: ModelMessage[]): ToolModelMessage | undefined {
  return messages.find((m) => m.role === "tool") as ToolModelMessage | undefined;
}

/** Feed a returned message list into a real ScenarioExecutionState consumer. */
function stateWith(messages: ModelMessage[]): ScenarioExecutionState {
  const state = new ScenarioExecutionState({
    description: "tool-call surfacing",
  } as ScenarioConfig);
  for (const m of messages) state.addMessage(m);
  return state;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("OpenAIRealtimeAgentAdapter — realtime tool-call surfacing (#630)", () => {
  it("AC4 — surfaces a tool call as the JS consumer shape (role:'tool' + tool-result), hasToolCall/lastToolCall recognize it", async () => {
    const adapter = buildAdapter({
      apiKey: "test-key",
      role: AgentRole.AGENT,
    });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      pushStreamingCall("call_a", "get_weather", '{"city":"Paris"}');
    });

    const toolMsg = toolMessageOf(messages);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.role).toBe("tool");

    // Exact consumer-matched part shape.
    const part = toolMsg!.content.find(
      (p) => p.type === "tool-result" && p.toolName === "get_weather",
    );
    expect(part).toBeDefined();
    expect(part).toMatchObject({
      type: "tool-result",
      toolCallId: "call_a",
      toolName: "get_weather",
    });

    // PROOF — the actual message that lands in the run's messages.
     
    console.log(
      "[#630 PROOF] tool message added to run:",
      JSON.stringify(toolMsg, null, 2),
    );

    // The real consumer (ScenarioExecutionState) recognizes it.
    const state = stateWith(messages);
    expect(state.hasToolCall("get_weather")).toBe(true);
    const last = state.lastToolCall("get_weather");
    expect(last).toBeDefined();
    expect(last.role).toBe("tool");
    expect(
      last.content.some(
        (p) => p.type === "tool-result" && p.toolName === "get_weather",
      ),
    ).toBe(true);
  });

  it("AC4 (variant) — a call delivered ONLY via output_item.done is surfaced", async () => {
    const adapter = buildAdapter({ apiKey: "test-key" });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      pushOutputItemCall("call_b", "lookup_order", '{"id":42}');
    });

    const state = stateWith(messages);
    expect(state.hasToolCall("lookup_order")).toBe(true);
    const part = toolMessageOf(messages)!.content.find(
      (p) => p.type === "tool-result" && p.toolName === "lookup_order",
    ) as { toolCallId: string };
    expect(part.toolCallId).toBe("call_b");
  });

  it("AC6 — idempotency: streaming .done AND output_item.done for one call_id → exactly ONE tool-result part", async () => {
    const adapter = buildAdapter({ apiKey: "test-key" });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      // BOTH forms describe the SAME call_id — must de-dup to one part.
      pushStreamingCall("call_dup", "get_weather", '{"city":"Berlin"}');
      pushOutputItemCall("call_dup", "get_weather", '{"city":"Berlin"}');
    });

    const toolMsg = toolMessageOf(messages)!;
    const matching = toolMsg.content.filter(
      (p) => p.type === "tool-result" && p.toolName === "get_weather",
    );
    expect(matching.length).toBe(1);
    expect(stateWith(messages).hasToolCall("get_weather")).toBe(true);
  });

  it("AC7 — malformed args surfaced verbatim (no throw), audio turn still returns", async () => {
    const adapter = buildAdapter({ apiKey: "test-key" });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      // Not valid JSON — must NOT parse-and-reraise; surfaced as raw text.
      pushOutputItemCall("call_bad", "noop", "{not json");
    });

    // Audio turn still produced its message.
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
    const part = toolMessageOf(messages)!.content.find(
      (p) => p.type === "tool-result" && p.toolName === "noop",
    ) as { output: { type: string; value: unknown } };
    // Raw string passed through (text output), not parsed.
    expect(part.output).toEqual({ type: "text", value: "{not json" });
    expect(stateWith(messages).hasToolCall("noop")).toBe(true);
  });

  it("AC7 — missing args → '{}' default; missing call_id → skipped, no throw", async () => {
    const adapter = buildAdapter({ apiKey: "test-key" });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      // No-call_id event must be skipped silently (degraded path), no throw.
      push({
        type: "response.function_call_arguments.done",
        arguments: '{"x":1}',
      });
      // A valid call with NO arguments anywhere → defaults to "{}".
      push({
        type: "response.output_item.done",
        item: { type: "function_call", name: "ping", call_id: "call_noargs" },
      });
    });

    const part = toolMessageOf(messages)!.content.find(
      (p) => p.type === "tool-result" && p.toolName === "ping",
    ) as { output: { type: string; value: unknown } };
    // "{}" parses to an empty object (json output).
    expect(part.output).toEqual({ type: "json", value: {} });
    // The no-call_id event surfaced nothing.
    const allNames = toolMessageOf(messages)!.content
      .filter((p) => p.type === "tool-result")
      .map((p) => (p as { toolName: string }).toolName);
    expect(allNames).toEqual(["ping"]);
  });

  it("AC8 — audio-only turn (no tool events) returns ONLY the audio message, no tool message", async () => {
    const adapter = buildAdapter({ apiKey: "test-key" });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      // No function-call events at all.
    });

    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("assistant");
    expect(toolMessageOf(messages)).toBeUndefined();
    expect(stateWith(messages).hasToolCall("anything")).toBe(false);
  });

  it("AC10 — two distinct calls (A→T1, B→T2) in one turn → both visible", async () => {
    const adapter = buildAdapter({ apiKey: "test-key" });

    const messages = await runTurn(adapter, () => {
      pushAudioDelta();
      pushStreamingCall("call_1", "get_weather", '{"city":"Paris"}');
      pushOutputItemCall("call_2", "lookup_order", '{"id":7}');
    });

    const toolMsg = toolMessageOf(messages)!;
    const names = toolMsg.content
      .filter((p) => p.type === "tool-result")
      .map((p) => (p as { toolName: string }).toolName)
      .sort();
    expect(names).toEqual(["get_weather", "lookup_order"]);

    const state = stateWith(messages);
    expect(state.hasToolCall("get_weather")).toBe(true);
    expect(state.hasToolCall("lookup_order")).toBe(true);
  });

  it("AC6 (per-turn reset) — calls from a prior turn do not leak into the next", async () => {
    // Two call() turns on ONE connection — proves call() resets per-turn tool
    // state (mirrors the Python turn-start reset). No reconnect.
    const adapter = buildAdapter({ apiKey: "test-key" });
    await adapter.connect();
    await socketReady;
    await waitForType("session.update");

    // Turn 1: one tool call.
    const turn1 = await feedAndCall(adapter, () => {
      pushAudioDelta();
      pushOutputItemCall("call_t1", "get_weather", "{}");
    });
    expect(stateWith(turn1).hasToolCall("get_weather")).toBe(true);

    // Turn 2: a DIFFERENT call, no get_weather — turn-1's call must not bleed.
    const turn2 = await feedAndCall(adapter, () => {
      pushAudioDelta();
      pushOutputItemCall("call_t2", "lookup_order", "{}");
    });
    await adapter.disconnect();

    const t2Names = (toolMessageOf(turn2)?.content ?? [])
      .filter((p) => p.type === "tool-result")
      .map((p) => (p as { toolName: string }).toolName);
    expect(t2Names).toEqual(["lookup_order"]);
  });
});
