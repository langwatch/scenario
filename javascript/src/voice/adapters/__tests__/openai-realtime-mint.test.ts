/**
 * How OpenAIRealtimeAgentAdapter obtains the credential it dials with.
 *
 * The adapter mints at `${OPENAI_BASE_URL}/realtime/client_secrets`, which is
 * OpenAI's own path and the one a LangWatch AI Gateway mirrors. These tests
 * pin the four outcomes that decide whether a call is billed, and what the
 * socket ends up carrying:
 *
 * - a gateway minted it, so usage is reported back and the socket carries the
 *   ephemeral secret;
 * - the vendor minted it, so there is no session to report to;
 * - the route was absent, so the adapter dials directly and says so;
 * - the mint was refused, so nothing is dialled at all.
 *
 * The last two are the money-relevant pair. A refusal that fell back to a
 * direct provider key would run a call the gateway declined to bill, and a
 * silent fallback would make an unbilled run look like a billed one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { OpenAIRealtimeAgentAdapter } from "../../index";
import { setupMockRealtimeServer } from "./fixtures/mock-realtime-server";

const server = setupMockRealtimeServer(() => {});

const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
  "OPENAI_REALTIME_URL",
] as const;
const saved: Record<string, string | undefined> = {};

/** Auth headers the adapter presented to the socket, newest last. */
let dialledWith: string[] = [];

function adapterAt(port: number): OpenAIRealtimeAgentAdapter {
  return new OpenAIRealtimeAgentAdapter({
    url: `ws://127.0.0.1:${port}/realtime`,
    wsFactory: (url, authHeader) => {
      dialledWith.push(authHeader);
      return new WebSocket(url, { headers: { Authorization: authHeader } });
    },
  });
}

/** A mint response, with the session-id header only when a gateway answers. */
function mintResponse(status: number, sessionId?: string): Response {
  if (status !== 200) return new Response("no", { status });
  return new Response(JSON.stringify({ value: "ek_minted_secret" }), {
    status: 200,
    headers: sessionId ? { "x-langwatch-session-id": sessionId } : {},
  });
}

describe("given an adapter connecting to a realtime session", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    dialledWith = [];
    server.arm();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
  });

  describe("when a gateway answers the mint", () => {
    it("dials with the ephemeral secret and knows the session is billed", async () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      process.env.OPENAI_REALTIME_API_KEY = "sk-direct-provider-key";
      const fetchSpy = vi.fn(async () => mintResponse(200, "req_abc"));
      vi.stubGlobal("fetch", fetchSpy);

      const adapter = adapterAt(server.port());
      await adapter.connect();
      await adapter.disconnect();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://gateway.example/v1/realtime/client_secrets",
      );
      // The long-lived keys stay off the socket: neither the virtual key nor
      // the direct provider key is what the websocket carries.
      expect(dialledWith).toEqual(["Bearer ek_minted_secret"]);
      expect(adapter.brokered).toBe(true);
    });
  });

  describe("when the vendor answers the mint", () => {
    it("dials with the ephemeral secret but reports no session, because OpenAI names none", async () => {
      process.env.OPENAI_API_KEY = "sk-provider";
      const fetchSpy = vi.fn(async () => mintResponse(200));
      vi.stubGlobal("fetch", fetchSpy);

      const adapter = adapterAt(server.port());
      await adapter.connect();
      await adapter.disconnect();

      // Default base URL is OpenAI's own, so no configuration is required for
      // this path and none is read.
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://api.openai.com/v1/realtime/client_secrets",
      );
      expect(dialledWith).toEqual(["Bearer ek_minted_secret"]);
      expect(adapter.brokered).toBe(false);
    });
  });

  describe("when the endpoint has no mint route", () => {
    it("dials the vendor directly with the fallback key, and warns", async () => {
      // A LangWatch gateway older than this feature answers 404. That is an
      // absence, not a refusal, so the call still runs; the warning is what
      // stops an unbilled run from reading as a billed one.
      process.env.OPENAI_BASE_URL = "https://old-gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      process.env.OPENAI_REALTIME_API_KEY = "sk-direct-provider-key";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mintResponse(404)),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = adapterAt(server.port());
      await adapter.connect();
      await adapter.disconnect();

      expect(dialledWith).toEqual(["Bearer sk-direct-provider-key"]);
      expect(adapter.brokered).toBe(false);
      expect(warn.mock.calls.map(String).join(" ")).toMatch(
        /old-gateway\.example.*not billed|not billed.*old-gateway\.example/s,
      );
    });
  });

  describe("when the mint is refused", () => {
    it("raises without opening a socket, so a declined call cannot run on a provider key", async () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      process.env.OPENAI_REALTIME_API_KEY = "sk-direct-provider-key";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mintResponse(402)),
      );

      const adapter = adapterAt(server.port());

      await expect(adapter.connect()).rejects.toThrow(/HTTP 402/);
      expect(dialledWith).toEqual([]);
    });
  });
});
