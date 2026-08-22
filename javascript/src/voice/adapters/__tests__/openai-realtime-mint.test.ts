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
    // spyOn is not undone by unstubAllGlobals, so a silenced console.warn
    // would outlive this file and mute a later test that asserts on one.
    vi.restoreAllMocks();
  });

  describe("when a gateway answers the mint", () => {
    it("dials with the ephemeral secret and knows the session is billed", async () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      process.env.OPENAI_REALTIME_API_KEY = "sk-direct-provider-key";
      const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
        mintResponse(200, "req_abc"),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const adapter = adapterAt(server.port());
      await adapter.connect();
      await adapter.disconnect();

      // Two requests, and the second one is the point: a gateway session is
      // opened by the mint and only a report closes it, so a session that ran
      // no response still has to be closed at zero.
      expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
        "https://gateway.example/v1/realtime/client_secrets",
        "https://gateway.example/v1/realtime/sessions/req_abc/usage",
      ]);
      // The long-lived keys stay off the socket: neither the virtual key nor
      // the direct provider key is what the websocket carries.
      expect(dialledWith).toEqual(["Bearer ek_minted_secret"]);
      expect(adapter.brokered).toBe(true);
    });
  });

  describe("when the vendor answers the mint", () => {
    it("dials with the ephemeral secret but reports no session, because OpenAI names none", async () => {
      process.env.OPENAI_API_KEY = "sk-provider";
      const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
        mintResponse(200),
      );
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
      // The warning names the variable the key actually came from. Naming a
      // fixed one would send a reader to a variable that is not set.
      const warned = warn.mock.calls.map(String).join(" ");
      expect(warned).toMatch(/old-gateway\.example/);
      expect(warned).toMatch(/OPENAI_REALTIME_API_KEY/);
      expect(warned).toMatch(/not billed/);
    });
  });

  describe("when the socket never opens", () => {
    it("closes the session it minted, at zero, rather than leaving it open", async () => {
      // The mint booked a session and only a report can close it. Left open
      // it holds one of the key's session slots until the gateway's window
      // expires, and books a call that never happened.
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      const calls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({
            url,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          return url.endsWith("/client_secrets")
            ? mintResponse(200, "req_abc")
            : new Response("{}", { status: 202 });
        }),
      );

      const adapter = new OpenAIRealtimeAgentAdapter({
        url: "ws://127.0.0.1:1/realtime",
        wsFactory: (url, authHeader) => {
          dialledWith.push(authHeader);
          // Nothing listens on port 1, so this errors before it opens.
          return new WebSocket(url);
        },
      });

      await expect(adapter.connect()).rejects.toThrow();

      expect(calls.map((c) => c.url)).toEqual([
        "https://gateway.example/v1/realtime/client_secrets",
        "https://gateway.example/v1/realtime/sessions/req_abc/usage",
      ]);
      // Zero is the truth here, not a placeholder: an ephemeral credential
      // that opened no socket consumed nothing at the vendor. The counts are
      // stated rather than left out, because the gateway reads a report by
      // looking for input_tokens or output_tokens and answers 400 to a body
      // carrying neither, which would leave the session open.
      expect(calls[1]?.body).toEqual({
        usage: { input_tokens: 0, output_tokens: 0 },
      });
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

      await expect(adapter.connect()).rejects.toThrow(/refused with HTTP 402/);
      expect(dialledWith).toEqual([]);
    });
  });
});

/**
 * What the adapter reports when the session ends.
 *
 * The vendor reports usage per response, so the number that closes a spend
 * record has to be the sum of every turn. These tests drive the real
 * `response.done` frames through the real socket and assert on the body that
 * reaches the gateway, because the defect lives in the arithmetic between the
 * frames and the report.
 */
describe("given a brokered session that ends", () => {
  const savedEnv: Record<string, string | undefined> = {};

  /** Every usage body the adapter posted to the gateway, newest last. */
  let reported: unknown[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
    process.env.OPENAI_API_KEY = "vk-lw-test";
    reported = [];
    dialledWith = [];
    server.arm();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/client_secrets")) {
          return mintResponse(200, "req_abc");
        }
        reported.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }),
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports every turn, not the last one", async () => {
    // The numbers are the two turns measured against the live Realtime API on
    // 2026-08-21. Keeping the last response would report output_tokens 4.
    const adapter = adapterAt(server.port());
    await adapter.connect();
    await server.socketReady();

    server.push({
      type: "response.done",
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 4,
          total_tokens: 124,
          output_token_details: { audio_tokens: 3 },
        },
      },
    });
    server.push({
      type: "response.done",
      response: {
        usage: {
          input_tokens: 135,
          output_tokens: 4,
          total_tokens: 139,
          output_token_details: { audio_tokens: 3 },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.disconnect();

    expect(reported).toEqual([
      {
        usage: {
          input_tokens: 255,
          output_tokens: 8,
          total_tokens: 263,
          output_token_details: { audio_tokens: 6 },
        },
      },
    ]);
  });

  it("closes a session that produced no response at all, at zero", async () => {
    // Connect then disconnect with no response.done. Reporting nothing would
    // leave the record open, holding one of the key's session slots until the
    // gateway's grace expires, which surfaces later as a 429 on a fresh mint.
    const adapter = adapterAt(server.port());
    await adapter.connect();
    await server.socketReady();
    await adapter.disconnect();

    expect(reported).toEqual([
      { usage: { input_tokens: 0, output_tokens: 0 } },
    ]);
  });

  it("reports once, so a second disconnect cannot bill the session twice", async () => {
    const adapter = adapterAt(server.port());
    await adapter.connect();
    await server.socketReady();
    await adapter.disconnect();
    await adapter.disconnect();

    expect(reported).toHaveLength(1);
  });
});
