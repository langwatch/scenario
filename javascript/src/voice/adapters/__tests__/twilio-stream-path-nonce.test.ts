/**
 * Nonce-in-path Media Streams routing (production Twilio phone hangup fix).
 *
 * Root cause of the production failure: the SDK built TwiML with a fixed
 * `/twilio/stream` path and shipped the nonce only as a `<Parameter>`, while
 * the LangWatch platform's upgrade listener needs the nonce IN THE PATH to
 * route a socket to the right child process before the handshake completes.
 * With the old URL the platform captured the literal string "stream" as the
 * nonce, failed the lookup, and rejected the handshake (Twilio error 31920).
 *
 * `streamWsUrl` now emits `/twilio/<nonce>` when a nonce is minted (a-leg),
 * and `TwilioWebhookServer`'s upgrade handler accepts either shape. The
 * `<Parameter>`/`customParameters.nonce` check stays as a second,
 * independent check: the nonce must be accepted from EITHER source, and a
 * path nonce that disagrees with the frame nonce is refused.
 */

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  makeAdapter,
  spyRest,
  startALegCall,
  startFrame,
} from "./a-leg-harness";
import { streamWsUrl } from "../twilio-shared";
import type { TwilioAgentAdapter } from "../twilio";

describe("streamWsUrl", () => {
  it("returns nonce path when a nonce is supplied", () => {
    expect(streamWsUrl("https://example.test", "abc123")).toBe("wss://example.test/twilio/abc123");
  });
  it("returns the legacy stream path when there is no nonce", () => {
    expect(streamWsUrl("https://example.test")).toBe("wss://example.test/twilio/stream");
  });
  it("swaps http to ws and strips a trailing slash with a nonce", () => {
    expect(streamWsUrl("http://example.test/", "n1")).toBe("ws://example.test/twilio/n1");
  });
});

/**
 * `open(url)` resolves `{ opened: true }` if the WS handshake completes, or
 * `{ opened: false }` if the upgrade is refused (socket destroyed pre-101, or
 * the connection closes/errors before opening). Bounded by `timeoutMs` so a
 * regression that hangs the upgrade fails the test instead of the suite.
 */
function attemptUpgrade(
  url: string,
  timeoutMs = 3_000,
): Promise<{ opened: boolean; client: WebSocket | null }> {
  return new Promise((resolve) => {
    const client = new WebSocket(url);
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ opened, client: opened ? client : null });
    };
    client.once("open", () => finish(true));
    client.once("error", () => finish(false));
    client.once("close", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

describe("TwilioWebhookServer real upgrade route -- nonce in path", () => {
  const tracked: TwilioAgentAdapter[] = [];
  async function connectedAdapter(): Promise<{
    adapter: TwilioAgentAdapter;
    rest: ReturnType<typeof spyRest>;
  }> {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    tracked.push(adapter);
    return { adapter, rest };
  }

  async function cleanup(): Promise<void> {
    while (tracked.length > 0) {
      try {
        await tracked.pop()!.disconnect();
      } catch {
        // Best-effort teardown.
      }
    }
  }

  it("accepts a request to /twilio/(correct nonce)", async () => {
    try {
      const { adapter, rest } = await connectedAdapter();
      const { nonce, call } = await startALegCall(adapter, rest);
      const base = adapter.localBaseUrl.replace(/^http:/, "ws:");
      const url = base + "/twilio/" + nonce;
      const { opened, client } = await attemptUpgrade(url);
      expect(opened, "upgrade with the correct path nonce was refused").toBe(true);
      client!.send(startFrame({ nonce }));
      await call;
      expect(adapter._streamWsForServer).not.toBeNull();
      client!.close();
    } finally {
      await cleanup();
    }
  });

  it("refuses /twilio/(wrong nonce)", async () => {
    try {
      const { adapter, rest } = await connectedAdapter();
      const { call } = await startALegCall(adapter, rest);
      const base = adapter.localBaseUrl.replace(/^http:/, "ws:");
      const url = base + "/twilio/not-the-nonce";
      const { opened } = await attemptUpgrade(url);
      expect(opened, "upgrade with a wrong path nonce was accepted").toBe(false);
      expect(adapter._streamWsForServer).toBeNull();
      let stillPending = true;
      call.then(() => (stillPending = false)).catch(() => (stillPending = false));
      await new Promise((r) => setTimeout(r, 30));
      expect(stillPending, "stream-connected fired for a refused socket").toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("still accepts legacy /twilio/stream with the correct nonce in the start frame", async () => {
    try {
      const { adapter, rest } = await connectedAdapter();
      const { nonce, call } = await startALegCall(adapter, rest);
      const base = adapter.localBaseUrl.replace(/^http:/, "ws:");
      const url = base + "/twilio/stream";
      const { opened, client } = await attemptUpgrade(url);
      expect(opened, "legacy /twilio/stream upgrade was refused").toBe(true);
      client!.send(startFrame({ nonce }));
      await call;
      expect(adapter._streamWsForServer).not.toBeNull();
      client!.close();
    } finally {
      await cleanup();
    }
  });

  it("refuses when the path nonce and the start-frame nonce disagree", async () => {
    try {
      const { adapter, rest } = await connectedAdapter();
      const { nonce, call } = await startALegCall(adapter, rest);
      const base = adapter.localBaseUrl.replace(/^http:/, "ws:");
      const url = base + "/twilio/" + nonce;
      const { opened, client } = await attemptUpgrade(url);
      expect(opened, "upgrade with the correct path nonce was refused").toBe(true);
      const closed = new Promise<void>((resolve) => client!.once("close", () => resolve()));
      const wrongFrameNonce = "a-different-nonce-than-the-path";
      client!.send(startFrame({ nonce: wrongFrameNonce }));
      await closed;
      expect(adapter._streamWsForServer).toBeNull();
      let stillPending = true;
      call.then(() => (stillPending = false)).catch(() => (stillPending = false));
      await new Promise((r) => setTimeout(r, 30));
      expect(stillPending, "stream-connected fired for a disagreeing nonce pair").toBe(true);
    } finally {
      await cleanup();
    }
  });
});
