/**
 * AC-JS3' (agent-first) + AC-JS4' (user-first no-double-fire) — outbound-frame
 * regression locks for the realtime adapter (`RealtimeAgentAdapter`), issue #623.
 *
 * These assert on the ARTIFACT the double-fire / hang bugs actually produce —
 * the sequence of events written to the realtime transport — NOT on
 * result-message counts. A `response.create` storm or a missing initial
 * `response.create` is invisible at the message layer but obvious on the wire.
 *
 *  - AC-JS3' (agent-first, locks `handleInitialResponse`): a leading
 *    `scenario.agent()` with NO prior user message must fire exactly ONE
 *    `response.create` BEFORE any user-audio commit, and yield exactly one
 *    non-empty assistant turn carrying both a `text` and an `audio/pcm16` `file`
 *    part. The run must not hang.
 *  - AC-JS4' (user-first no-double-fire): for a script of N user-audio turns the
 *    transport must receive EXACTLY N `response.create` frames, and ZERO before
 *    the first `input_audio_buffer.commit`. (The double-fire bug shows up as
 *    > N frames.)
 *
 * Creds-free mock strategy (no OpenAI key, no network):
 *  - A fake transport (an `on`/`sendEvent` object) records every outbound event
 *    AND, on receiving `response.create`, asynchronously emits the
 *    transcript-delta + audio-delta + `response.done` events the real
 *    `RealtimeEventHandler` listens for — so `waitForResponse` resolves exactly
 *    as it would against the live API. The adapter drives the REAL
 *    `RealtimeEventHandler` / `MessageProcessor` / `ResponseFormatter`.
 *  - A fake session exposes that transport (the only session surface
 *    `RealtimeAgentAdapter` touches for these paths is `session.transport`).
 */

import type { ModelMessage } from "ai";
import { describe, it, expect } from "vitest";

import { RealtimeAgentAdapter } from "../realtime/realtime-agent.adapter";
import { AgentRole } from "../../domain";
import type { AgentInput } from "../../domain";

const AGENT_TRANSCRIPT = "thanks for joining, tell me about your background";

/** One PCM16 audio-delta frame (base64) the fake "model" streams back. */
const AUDIO_DELTA_B64 = Buffer.from(
  "\x10\x00\x20\x00",
  "binary",
).toString("base64");

interface OutboundEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * A fake realtime transport: an `on`/`sendEvent` surface that (1) records every
 * outbound event, and (2) on `response.create`, asynchronously streams back the
 * transcript-delta + audio-delta + `response.done` the real
 * `RealtimeEventHandler` consumes. Mirrors the live transport's event names
 * (`response.output_audio_transcript.delta`, `response.output_audio.delta`,
 * `response.done`) so the adapter's REAL handler resolves `waitForResponse`.
 */
class FakeTransport {
  readonly outbound: OutboundEvent[] = [];
  private listeners = new Map<string, Array<(data: unknown) => void>>();

  on(event: string, callback: (data: unknown) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(callback);
    this.listeners.set(event, arr);
  }

  private emit(event: string, data: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  sendEvent(event: OutboundEvent): void {
    this.outbound.push(event);
    if (event.type === "response.create") {
      // Resolve on a later macrotask so the adapter's `waitForResponse`
      // resolver is registered before `response.done` fires (the live API is
      // likewise strictly async after `response.create`).
      setTimeout(() => {
        this.emit("response.output_audio_transcript.delta", {
          delta: AGENT_TRANSCRIPT,
        });
        this.emit("response.output_audio.delta", { delta: AUDIO_DELTA_B64 });
        this.emit("response.done", {});
      }, 0);
    }
  }

  /** Count of a given outbound event type. */
  count(type: string): number {
    return this.outbound.filter((e) => e.type === type).length;
  }

  /** First index of an outbound event type (or -1). */
  indexOf(type: string): number {
    return this.outbound.findIndex((e) => e.type === type);
  }
}

/** A fake RealtimeSession exposing only the surface the adapter touches. */
function makeFakeSession(transport: FakeTransport) {
  return {
    transport,
    connect: async () => undefined,
    close: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ConstructorParameters<
    typeof RealtimeAgentAdapter
  >[0]["session"];
}

function makeAdapter(transport: FakeTransport): RealtimeAgentAdapter {
  return new RealtimeAgentAdapter({
    session: makeFakeSession(transport),
    role: AgentRole.AGENT,
    agentName: "Realtime Agent Under Test",
    responseTimeout: 2000,
  });
}

/** A user audio turn (the shape the adapter routes to `handleAudioInput`). */
function userAudioTurn(): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "file",
        mediaType: "audio/pcm16",
        data: Buffer.from("\x00\x00".repeat(160), "binary").toString("base64"),
      },
    ],
  } as ModelMessage;
}

function makeInput(newMessages: ModelMessage[]): AgentInput {
  return {
    threadId: "realtime-frames-thread",
    messages: newMessages,
    newMessages,
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "realtime-frames",
      description: "Voice interview.",
    } as unknown as AgentInput["scenarioConfig"],
  } as AgentInput;
}

/** Pull text + audio parts out of a returned assistant turn. */
function partsOf(msg: unknown): Array<{ type?: string; text?: string; mediaType?: string }> {
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string; mediaType?: string }>)
    : [];
}

describe("RealtimeAgentAdapter agent-first (AC-JS3' — locks handleInitialResponse)", () => {
  it("fires exactly one response.create before any user-audio commit and yields one non-empty assistant turn", async () => {
    const transport = new FakeTransport();
    const adapter = makeAdapter(transport);

    // Leading scenario.agent() with NO prior user message → newMessages empty →
    // handleInitialResponse. Must resolve (not hang) via the fake's async
    // response.done.
    const result = await adapter.call(makeInput([]));

    // Exactly ONE response.create was sent...
    expect(transport.count("response.create")).toBe(1);
    // ...and NO user-audio was ever appended/committed for an agent-first open.
    expect(transport.count("input_audio_buffer.commit")).toBe(0);
    expect(transport.count("input_audio_buffer.append")).toBe(0);

    // The resulting assistant turn is non-empty and carries BOTH a text part
    // (the transcript) and an audio/pcm16 file part.
    expect((result as { role?: string }).role).toBe("assistant");
    const parts = partsOf(result);
    const text = parts.find((p) => p.type === "text");
    const file = parts.find((p) => p.type === "file");
    expect(text?.text).toBe(AGENT_TRANSCRIPT);
    expect(file?.mediaType).toBe("audio/pcm16");

    // Run-shape: >= 1 assistant turn, non-empty.
    const assistantTurns = [result].filter(
      (m) => (m as { role?: string }).role === "assistant",
    );
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1);
    expect((text?.text ?? "").length).toBeGreaterThan(0);
  });
});

describe("RealtimeAgentAdapter user-first (AC-JS4' — no double-fire, outbound frames)", () => {
  it("sends exactly N response.create frames for N user turns, none before the first audio commit", async () => {
    const N = 3;
    const transport = new FakeTransport();
    const adapter = makeAdapter(transport);

    let sawUserRole = false;
    for (let i = 0; i < N; i++) {
      const userTurn = userAudioTurn();
      sawUserRole = sawUserRole || userTurn.role === "user";
      // Each user-audio turn drives handleAudioInput: append → commit →
      // response.create → waitForResponse (resolved by the fake).
      const reply = await adapter.call(makeInput([userTurn]));
      expect((reply as { role?: string }).role).toBe("assistant");
    }

    // EXACTLY N response.create frames — not 2N (the double-fire signature).
    expect(transport.count("response.create")).toBe(N);
    // One commit per user turn.
    expect(transport.count("input_audio_buffer.commit")).toBe(N);

    // ZERO response.create before the FIRST user-audio commit: the commit must
    // precede the very first response.create on the wire.
    const firstCommit = transport.indexOf("input_audio_buffer.commit");
    const firstResponseCreate = transport.indexOf("response.create");
    expect(firstCommit).toBeGreaterThanOrEqual(0);
    expect(firstResponseCreate).toBeGreaterThan(firstCommit);

    // Run-shape: at least one user-role turn was present in the script.
    expect(sawUserRole).toBe(true);
  });
});
