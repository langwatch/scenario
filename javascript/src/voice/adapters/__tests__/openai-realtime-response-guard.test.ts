/**
 * Regression tests for issue #662 — `response.create` guard on
 * `OpenAIRealtimeAgentAdapter`.
 *
 * These tests are written against the PRE-FIX code and MUST FAIL until the
 * following changes land in `openai-realtime.ts`:
 *   - private _responseActive = false
 *   - private _deferredResponseCreate = false
 *   - receiveAudio preamble: commit always, defer response.create when active
 *   - sendText: guard response.create when active
 *   - response.created → _responseActive = true
 *   - response.done/cancelled → _responseActive = false; fire deferred if set
 *
 * AC-JS1, AC-JS2, AC-JS3 FAIL on pre-fix code.
 * AC-ERR1 is a control test — PASSES on pre-fix code (existing error path).
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { OpenAIRealtimeAgentAdapter } from "../openai-realtime";

// ---------------------------------------------------------------------------
// FakeWS — an in-process fake that records frames without touching the network.
// Extends EventEmitter so the adapter can register message/close/error listeners
// exactly as it does on a real ws.WebSocket (via .on() / .once()).
// ---------------------------------------------------------------------------

class FakeWS extends EventEmitter {
  sent: string[] = [];
  closed = false;

  /** Called by the adapter to send a frame. */
  send(msg: string): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  /** Ordered list of `type` fields from every sent frame. */
  sentTypes(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }

  /** Count of frames with a given type. */
  sentCount(type: string): number {
    return this.sentTypes().filter((t) => t === type).length;
  }

  /** First index of a frame with a given type, or -1. */
  indexOfSent(type: string): number {
    return this.sentTypes().indexOf(type);
  }

  /**
   * Push a server event into the adapter's receive loop.
   * Serialises to JSON and emits as a "message" event — the same path a real
   * WebSocket frame takes through _handleMessage.
   */
  receive(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeAdapter(): Promise<{
  adapter: OpenAIRealtimeAgentAdapter;
  ws: FakeWS;
}> {
  const ws = new FakeWS();
  const adapter = new OpenAIRealtimeAgentAdapter({
    apiKey: "test-key",
    wsFactory: (_url, _authHeader) => {
      // Emit "open" asynchronously so the awaited Promise in connect() resolves.
      queueMicrotask(() => ws.emit("open"));
      return ws as unknown as WebSocket;
    },
  });
  await adapter.connect();
  return { adapter, ws };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIRealtimeAgentAdapter — response.create guard (#662)", () => {
  /**
   * AC-JS1: When _responseActive is true, receiveAudio MUST NOT send
   * response.create in the preamble (only the commit is sent).
   *
   * Pre-fix failure: the preamble at line 374-378 always sends BOTH
   * input_audio_buffer.commit and response.create, ignoring _responseActive.
   */
  it(
    "AC-JS1: receiveAudio sends commit but NOT response.create when _responseActive is true",
    async () => {
      const { adapter, ws } = await makeAdapter();

      // Simulate pending audio that triggers the preamble.
      (adapter as unknown as Record<string, unknown>)._pendingAudioBytes = 960;
      // Mark an active response — the guard should suppress response.create.
      (adapter as unknown as Record<string, unknown>)._responseActive = true;

      // receiveAudio will time out (no audio delta events injected) — that's
      // expected; we only care about what was sent in the preamble.
      await expect(adapter.receiveAudio(0.05)).rejects.toThrow();

      // Commit MUST always be sent so the server doesn't lose buffered audio.
      expect(ws.sentCount("input_audio_buffer.commit")).toBe(1);

      // response.create MUST be suppressed while a response is active.
      // Pre-fix: this is 1 (unconditional send) → test FAILS.
      expect(ws.sentCount("response.create")).toBe(0);
    },
    3000,
  );

  /**
   * AC-JS2: The deferred response.create fires AFTER response.done is
   * processed, not in the preamble.
   *
   * Strategy: start receiveAudio with _responseActive=true, let the preamble
   * run, then snapshot the sent count before injecting events.  On pre-fix
   * code the preamble fires response.create unconditionally, so
   * countBeforeDone === 1.  On post-fix code it is 0 (deferred).
   */
  it(
    "AC-JS2: deferred receiveAudio response.create fires after response.done frame",
    async () => {
      const { adapter, ws } = await makeAdapter();

      (adapter as unknown as Record<string, unknown>)._pendingAudioBytes = 960;
      (adapter as unknown as Record<string, unknown>)._responseActive = true;

      // 960 bytes of silent PCM16 (even byte count required by AudioChunk).
      const b64audio = Buffer.from(new Uint8Array(960)).toString("base64");

      const receivePromise = adapter.receiveAudio(2.0);

      // Yield one macrotask so the async receiveAudio loop drains its queued
      // events. A zero-delay timer is a deterministic macrotask boundary (it
      // runs only after the microtask queue is empty, regardless of runner
      // load) — not an arbitrary timed wait. The preamble already ran
      // synchronously before receiveAudio's first await, so this only flushes
      // the loop's event processing.
      await new Promise<void>((r) => setTimeout(r, 0));

      // Snapshot: how many response.create frames have been sent so far?
      // Pre-fix: 1 (fired unconditionally in preamble).
      // Post-fix: 0 (deferred because _responseActive is true).
      const countBeforeDone = ws.sentCount("response.create");

      // Inject the event sequence that drives receiveAudio to completion:
      // response.done  → clears _responseActive, fires deferred response.create
      // response.created → sets _responseActive = true for the new response
      // response.output_audio.delta → the actual audio frame that resolves receiveAudio
      ws.receive({ type: "response.done" });
      await new Promise<void>((r) => setTimeout(r, 0));
      ws.receive({ type: "response.created" });
      ws.receive({ type: "response.output_audio.delta", delta: b64audio });

      await receivePromise;

      // Pre-fix: countBeforeDone === 1 → assertion below FAILS.
      expect(countBeforeDone).toBe(0);

      // Exactly one response.create must have been sent in total (deferred,
      // after response.done).
      expect(ws.sentCount("response.create")).toBe(1);
    },
    5000,
  );

  /**
   * AC-JS3: sendText MUST NOT send response.create when _responseActive is
   * true.
   *
   * Pre-fix failure: sendText at line 680 always sends response.create.
   */
  it(
    "AC-JS3: sendText does not send response.create when _responseActive is true",
    async () => {
      const { adapter, ws } = await makeAdapter();

      (adapter as unknown as Record<string, unknown>)._responseActive = true;

      await adapter.sendText("hello");

      // conversation.item.create is always expected.
      expect(ws.sentCount("conversation.item.create")).toBe(1);

      // response.create MUST be suppressed.
      // Pre-fix: this is 1 (unconditional send at line 680) → test FAILS.
      expect(ws.sentCount("response.create")).toBe(0);
    },
    1000,
  );

  /**
   * AC-ERR1: A server-side "active response" error event surfaces as a
   * rejected Error from receiveAudio.
   *
   * This is a CONTROL test — it exercises the existing error-handling path
   * (line ~479) and PASSES on pre-fix code.  It validates that the error
   * plumbing works correctly before any guard changes land.
   */
  it(
    "AC-ERR1: receiveAudio rejects with Error on server active-response error",
    async () => {
      const { adapter, ws } = await makeAdapter();

      const receivePromise = adapter.receiveAudio(5.0);

      // Macrotask yield so the loop reaches its first _nextEvent await before
      // the error frame is injected (see AC-JS2 note above).
      await new Promise<void>((r) => setTimeout(r, 0));

      ws.receive({
        type: "error",
        error: {
          message:
            "Conversation already has an active response in progress",
        },
      });

      await expect(receivePromise).rejects.toThrow(
        "active response in progress",
      );
    },
    6000,
  );

  /**
   * Reconnect hygiene (#662, CodeRabbit): disconnect() must clear the
   * response-lifecycle guard flags, and a subsequent connect() must start from
   * a clean slate — including clearing `_closeReason`, without which
   * `_nextEvent` would reject every receiveAudio on the reused adapter and the
   * guard-flag reset alone would be cosmetic.
   */
  it(
    "resets response-lifecycle state on disconnect and reconnects clean",
    async () => {
      const { adapter } = await makeAdapter();
      const state = adapter as unknown as Record<string, unknown>;

      // Simulate mid-response state present when the socket drops.
      state._responseActive = true;
      state._deferredResponseCreate = true;

      await adapter.disconnect();

      // Teardown clears the guard flags so they cannot leak into a new session.
      expect(state._responseActive).toBe(false);
      expect(state._deferredResponseCreate).toBe(false);

      // Reconnect the same instance: connect() must reset the guard flags AND
      // the stale close reason.
      const ws2 = new FakeWS();
      (adapter as unknown as { _wsFactory: unknown })._wsFactory = (
        _url: string,
        _authHeader: string,
      ) => {
        queueMicrotask(() => ws2.emit("open"));
        return ws2 as unknown as WebSocket;
      };
      await adapter.connect();

      expect(state._responseActive).toBe(false);
      expect(state._deferredResponseCreate).toBe(false);
      expect(state._closeReason).toBe(null);

      // Prove reconnect actually works: receiveAudio reaches its own timeout
      // instead of rejecting immediately on the prior disconnect error.
      await expect(adapter.receiveAudio(0.05)).rejects.toThrow(/timed out/);
    },
    2000,
  );
});
