/**
 * Regression tests for issue #662 Phase 3:
 *   AC-JS6: RealtimeEventHandler.isResponseActive() lifecycle transitions
 *   AC-JS4: handleInitialResponse does NOT send response.create when handler is active
 *   AC-JS5: handleAudioInput does NOT send response.create when handler is active
 *
 * These tests are written to FAIL before the fix is applied:
 *   - AC-JS6a/b/c: isResponseActive() does not exist yet → TypeError
 *   - AC-JS4/AC-JS5: response.create is sent unconditionally → count is 1, not 0
 */

import { describe, it, expect, vi } from "vitest";
import { RealtimeEventHandler } from "../realtime/realtime-event-handler";
import { RealtimeAgentAdapter } from "../realtime/realtime-agent.adapter";
import { AgentRole } from "../../domain";
import type { RealtimeSession } from "@openai/agents/realtime";

// ------- FakeTransport -------
class FakeTransport {
  private listeners: Map<string, ((data: unknown) => void)[]> = new Map();
  sentEvents: Array<{ type: string; [k: string]: unknown }> = [];

  on(event: string, cb: (data: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...existing, cb]);
  }

  sendEvent(event: { type: string; [k: string]: unknown }): void {
    this.sentEvents.push(event);
  }

  // Simulate a server event arriving
  fire(event: string, data?: unknown): void {
    const cbs = this.listeners.get(event) ?? [];
    for (const cb of cbs) cb(data ?? {});
  }

  sentCount(type: string): number {
    return this.sentEvents.filter((e) => e.type === type).length;
  }
}

// ------- FakeSession -------
function makeFakeSession(transport: FakeTransport): RealtimeSession {
  return {
    transport,
    connect: vi.fn(),
    close: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as RealtimeSession;
}

// ============================================================
// AC-JS6: isResponseActive() lifecycle transitions
// ============================================================
describe("RealtimeEventHandler — isResponseActive() lifecycle", () => {
  it("AC-JS6a: isResponseActive() is false initially", () => {
    const transport = new FakeTransport();
    const session = makeFakeSession(transport);
    const handler = new RealtimeEventHandler(session);
    expect(handler.isResponseActive()).toBe(false);
  });

  it("AC-JS6b: isResponseActive() returns true after response.created", () => {
    const transport = new FakeTransport();
    const session = makeFakeSession(transport);
    const handler = new RealtimeEventHandler(session);
    transport.fire("response.created");
    expect(handler.isResponseActive()).toBe(true);
  });

  it("AC-JS6c: isResponseActive() returns false after response.done", () => {
    const transport = new FakeTransport();
    const session = makeFakeSession(transport);
    const handler = new RealtimeEventHandler(session);
    transport.fire("response.created");
    transport.fire("response.done");
    expect(handler.isResponseActive()).toBe(false);
  });

  it("AC-JS6d: isResponseActive() returns false after response.cancelled", () => {
    const transport = new FakeTransport();
    const session = makeFakeSession(transport);
    const handler = new RealtimeEventHandler(session);
    transport.fire("response.created");
    transport.fire("response.cancelled");
    expect(handler.isResponseActive()).toBe(false);
  });
});

// ============================================================
// AC-JS4 / AC-JS5: response.create guard on adapter methods
// ============================================================
describe("RealtimeAgentAdapter — response.create guard", () => {
  function makeAdapter(transport: FakeTransport): RealtimeAgentAdapter {
    const session = makeFakeSession(transport);
    return new RealtimeAgentAdapter({
      session,
      role: AgentRole.AGENT,
      agentName: "TestAgent",
      responseTimeout: 100,
    });
  }

  it("AC-JS4: handleInitialResponse does not send response.create when handler is active", async () => {
    const transport = new FakeTransport();
    const adapter = makeAdapter(transport);

    // Make the handler believe a response is active by firing response.created
    transport.fire("response.created");

    // handleInitialResponse is private — reach it via a typed cast (not `any`),
    // matching the sibling openai-realtime-response-guard.test.ts pattern.
    const promise = (
      adapter as unknown as { handleInitialResponse(): Promise<unknown> }
    ).handleInitialResponse();

    // The send decision is made synchronously, before the method's first `await`
    // (waitForResponse), so response.create has already been sent or suppressed by
    // the time the promise is returned. Flush the microtask queue, then resolve
    // waitForResponse promptly by firing response.done — so it settles well before
    // responseTimeout (100ms) and the test is deterministic, not racing the clock.
    await Promise.resolve();
    transport.fire("response.done");
    await promise.catch(() => {}); // ignore any rejection

    // response.create must NOT have been sent when handler was active
    expect(transport.sentCount("response.create")).toBe(0);
  });

  it("AC-JS5: handleAudioInput does not send response.create when handler is active", async () => {
    const transport = new FakeTransport();
    const adapter = makeAdapter(transport);

    // Make the handler believe a response is active
    transport.fire("response.created");

    const b64audio = Buffer.from(new Uint8Array(160)).toString("base64");
    const promise = (
      adapter as unknown as { handleAudioInput(audio: string): Promise<unknown> }
    ).handleAudioInput(b64audio);

    // Same deterministic settle as AC-JS4: sends are synchronous before the first
    // await, so flush microtasks then resolve waitForResponse promptly.
    await Promise.resolve();
    transport.fire("response.done");
    await promise.catch(() => {});

    // Only input_audio_buffer.append and input_audio_buffer.commit should be sent
    // response.create must NOT be sent when handler is active
    expect(transport.sentCount("response.create")).toBe(0);
  });
});
