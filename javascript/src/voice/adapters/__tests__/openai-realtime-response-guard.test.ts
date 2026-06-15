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
import { OpenAIRealtimeAgentAdapter } from "../openai-realtime";

// ---------------------------------------------------------------------------
// FakeWS — an in-process fake that records frames without touching the network
// ---------------------------------------------------------------------------

class FakeWS {
  sent: string[] = [];
  closed = false;

  /** Called by the adapter to send a frame. */
  send(msg: string): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(): { adapter: OpenAIRealtimeAgentAdapter; ws: FakeWS } {
  const adapter = new OpenAIRealtimeAgentAdapter({ apiKey: "test-key" });
  const ws = new FakeWS();
  // Inject the fake WS directly — bypasses the real connect() call.
  (adapter as unknown as Record<string, unknown>)._ws = ws;
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
      const { adapter, ws } = makeAdapter();

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
      const { adapter, ws } = makeAdapter();

      (adapter as unknown as Record<string, unknown>)._pendingAudioBytes = 960;
      (adapter as unknown as Record<string, unknown>)._responseActive = true;

      // 960 bytes of silent PCM16 (even byte count required by AudioChunk).
      const b64audio = Buffer.from(new Uint8Array(960)).toString("base64");

      const receivePromise = adapter.receiveAudio(2.0);

      // Let the preamble run before injecting server events.
      await new Promise<void>((r) => setTimeout(r, 20));

      // Snapshot: how many response.create frames have been sent so far?
      // Pre-fix: 1 (fired unconditionally in preamble).
      // Post-fix: 0 (deferred because _responseActive is true).
      const countBeforeDone = ws.sentCount("response.create");

      // Now inject the event sequence that drives receiveAudio to completion:
      // response.done  → clears _responseActive, fires deferred response.create
      // response.created → sets _responseActive = true for the new response
      // response.output_audio.delta → the actual audio frame that resolves receiveAudio
      // response.done  → completes the second response
      const enqueue = (event: unknown): void => {
        (
          adapter as unknown as {
            _enqueueEvent: (e: unknown) => void;
          }
        )._enqueueEvent(event);
      };

      enqueue({ type: "response.done" });
      await new Promise<void>((r) => setTimeout(r, 5));
      enqueue({ type: "response.created" });
      enqueue({ type: "response.output_audio.delta", delta: b64audio });

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
      const { adapter, ws } = makeAdapter();

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
      const { adapter } = makeAdapter();

      const receivePromise = adapter.receiveAudio(5.0);

      await new Promise<void>((r) => setTimeout(r, 10));

      (
        adapter as unknown as {
          _enqueueEvent: (e: unknown) => void;
        }
      )._enqueueEvent({
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
});
