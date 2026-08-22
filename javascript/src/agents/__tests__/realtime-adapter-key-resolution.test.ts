/**
 * How RealtimeAgentAdapter.connect() obtains the credential it dials with.
 *
 * The adapter mints at `${OPENAI_BASE_URL}/realtime/client_secrets`, which is
 * OpenAI's own path and the one a LangWatch AI Gateway mirrors. The socket then
 * carries the ephemeral secret the mint returned, so no long-lived key reaches
 * it. These tests pin the outcomes that decide whether a call is billed:
 *
 * - a gateway minted it, so the socket carries the ephemeral secret;
 * - the route was absent, so the adapter dials directly and says so;
 * - the mint was refused, so nothing is dialled at all.
 *
 * The last two are the money-relevant pair. A refusal that fell back to a
 * direct provider key would run a call the gateway declined to bill.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentRole } from "../../domain";
import { RealtimeAgentAdapter } from "../realtime/realtime-agent.adapter";

type ConnectParams = { apiKey?: string };

const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

/** A mint response, with the session-id header only when a gateway answers. */
function mintResponse(status: number, sessionId?: string): Response {
  if (status !== 200) return new Response("no", { status });
  return new Response(JSON.stringify({ value: "ek_minted_secret" }), {
    status: 200,
    headers: sessionId ? { "x-langwatch-session-id": sessionId } : {},
  });
}

function makeAdapter(
  recorded: ConnectParams[],
  overrides: Partial<ConstructorParameters<typeof RealtimeAgentAdapter>[0]> = {},
  sessionModel?: string,
): RealtimeAgentAdapter {
  const session = {
    transport: { on: () => undefined, sendEvent: () => undefined },
    options: sessionModel ? { model: sessionModel } : {},
    connect: async (params: ConnectParams) => {
      recorded.push(params);
    },
    close: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ConstructorParameters<
    typeof RealtimeAgentAdapter
  >[0]["session"];

  return new RealtimeAgentAdapter({
    session,
    role: AgentRole.AGENT,
    agentName: "Key Resolution Test Agent",
    responseTimeout: 1000,
    ...overrides,
  });
}

describe("RealtimeAgentAdapter.connect credential resolution", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
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
      const fetchSpy = vi.fn(async () => mintResponse(200, "req_abc"));
      vi.stubGlobal("fetch", fetchSpy);

      const recorded: ConnectParams[] = [];
      const adapter = makeAdapter(recorded);
      await adapter.connect();

      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://gateway.example/v1/realtime/client_secrets",
      );
      // Neither long-lived key reaches the socket.
      expect(recorded[0]?.apiKey).toBe("ek_minted_secret");
      expect(adapter.brokered).toBe(true);
    });

    it("mints for the model the session was built with", async () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      const fetchSpy = vi.fn(async () => mintResponse(200, "req_abc"));
      vi.stubGlobal("fetch", fetchSpy);

      await makeAdapter([], {}, "gpt-realtime").connect();

      // The gateway prices and budgets against this model, so a default here
      // would bill a session that opened as something else.
      const body = JSON.parse(
        String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body),
      );
      expect(body.session.model).toBe("gpt-realtime");
    });

    it("mints for the model connect() was given, which is the one the socket opens with", async () => {
      // `session.connect({ model })` overrides the session's own model, so a
      // mint for the session's model would bill something the call never used.
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      const fetchSpy = vi.fn(async () => mintResponse(200, "req_abc"));
      vi.stubGlobal("fetch", fetchSpy);

      await makeAdapter([], {}, "gpt-realtime").connect({
        model: "gpt-realtime-mini",
      } as Parameters<RealtimeAgentAdapter["connect"]>[0]);

      const body = JSON.parse(
        String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body),
      );
      expect(body.session.model).toBe("gpt-realtime-mini");
    });
  });

  describe("when the vendor answers the mint", () => {
    it("dials with the ephemeral secret but reports no session, because OpenAI names none", async () => {
      process.env.OPENAI_API_KEY = "sk-provider";
      const fetchSpy = vi.fn(async () => mintResponse(200));
      vi.stubGlobal("fetch", fetchSpy);

      const recorded: ConnectParams[] = [];
      const adapter = makeAdapter(recorded);
      await adapter.connect();

      // Default base URL is OpenAI's own, so no configuration is required.
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://api.openai.com/v1/realtime/client_secrets",
      );
      expect(recorded[0]?.apiKey).toBe("ek_minted_secret");
      expect(adapter.brokered).toBe(false);
    });
  });

  describe("when the endpoint has no mint route", () => {
    it("dials the vendor directly with the fallback key, and warns", async () => {
      process.env.OPENAI_BASE_URL = "https://old-gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      process.env.OPENAI_REALTIME_API_KEY = "sk-direct-provider-key";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mintResponse(404)),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const recorded: ConnectParams[] = [];
      const adapter = makeAdapter(recorded);
      await adapter.connect();

      expect(recorded[0]?.apiKey).toBe("sk-direct-provider-key");
      expect(adapter.brokered).toBe(false);
      const warned = warn.mock.calls.map(String).join(" ");
      expect(warned).toMatch(/old-gateway\.example/);
      expect(warned).toMatch(/OPENAI_REALTIME_API_KEY/);
      expect(warned).toMatch(/not billed/);
    });

    it("falls back to OPENAI_API_KEY when no realtime key is set", async () => {
      process.env.OPENAI_BASE_URL = "https://old-gateway.example/v1";
      process.env.OPENAI_API_KEY = "sk-plain";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mintResponse(404)),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const recorded: ConnectParams[] = [];
      await makeAdapter(recorded).connect();

      expect(recorded[0]?.apiKey).toBe("sk-plain");
      expect(warn.mock.calls.map(String).join(" ")).toMatch(/OPENAI_API_KEY/);
    });
  });

  describe("when the mint is refused", () => {
    it.each([401, 403, 429, 500, 502])(
      "raises on HTTP %i without connecting, so a declined call cannot run on a provider key",
      async (status) => {
        process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
        process.env.OPENAI_API_KEY = "vk-lw-test";
        process.env.OPENAI_REALTIME_API_KEY = "sk-direct-provider-key";
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => mintResponse(status)),
        );

        const recorded: ConnectParams[] = [];
        await expect(makeAdapter(recorded).connect()).rejects.toThrow(
          new RegExp(`refused with HTTP ${status}`),
        );
        expect(recorded).toHaveLength(0);
      },
    );
  });

  describe("when the caller supplies its own credential", () => {
    it("an explicit params.apiKey skips the mint entirely", async () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "vk-lw-test";
      const fetchSpy = vi.fn(async () => mintResponse(200, "req_abc"));
      vi.stubGlobal("fetch", fetchSpy);

      const recorded: ConnectParams[] = [];
      await makeAdapter(recorded).connect({ apiKey: "sk-explicit" });

      expect(recorded[0]?.apiKey).toBe("sk-explicit");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("`mint: false` dials the vendor directly with no mint attempt", async () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_API_KEY = "sk-plain";
      const fetchSpy = vi.fn(async () => mintResponse(200, "req_abc"));
      vi.stubGlobal("fetch", fetchSpy);

      const recorded: ConnectParams[] = [];
      await makeAdapter(recorded, { mint: false }).connect();

      expect(recorded[0]?.apiKey).toBe("sk-plain");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("throws a clear error when no key is available anywhere", async () => {
    const recorded: ConnectParams[] = [];
    await expect(makeAdapter(recorded).connect()).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
    expect(recorded).toHaveLength(0);
  });
});
