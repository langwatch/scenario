/**
 * Brokered realtime voice sessions.
 *
 * The subject is the contract between an adapter and a voice gateway: what
 * turns brokering on, which key mints, what the socket then dials with, and
 * what closes the session's spend record. Money depends on all four, so each
 * is asserted rather than inferred from a connection succeeding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mintOpenAIRealtimeSession,
  reportOpenAIRealtimeUsage,
  resolveVoiceBroker,
} from "../broker";

const ENV_KEYS = [
  "LANGWATCH_VOICE_BROKER_URL",
  "LANGWATCH_VOICE_BROKER_KEY",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
] as const;

describe("given a voice broker configuration", () => {
  const saved: Record<string, string | undefined> = {};

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
  });

  describe("when nothing is configured", () => {
    it("reports no broker, so the adapter connects directly", () => {
      expect(resolveVoiceBroker()).toBeNull();
    });

    it("still reports no broker when only a key is present", () => {
      // A key with no address is not a broker anyone configured. Treating it
      // as one would silently redirect every session.
      process.env.LANGWATCH_VOICE_BROKER_KEY = "vk-lw-test";
      expect(resolveVoiceBroker()).toBeNull();
    });
  });

  describe("when a broker URL is set", () => {
    it("falls back to OPENAI_API_KEY, where a gateway user keeps the virtual key", () => {
      process.env.LANGWATCH_VOICE_BROKER_URL = "https://gateway.example/";
      process.env.OPENAI_API_KEY = "vk-lw-from-openai-var";

      const broker = resolveVoiceBroker();

      expect(broker).toEqual({
        baseUrl: "https://gateway.example",
        apiKey: "vk-lw-from-openai-var",
      });
    });

    it("never mints with OPENAI_REALTIME_API_KEY", () => {
      // That variable holds a direct provider key. Minting with it would
      // present a credential the gateway does not issue and cannot bill, and
      // the failure would look like a broker outage.
      process.env.LANGWATCH_VOICE_BROKER_URL = "https://gateway.example";
      process.env.OPENAI_REALTIME_API_KEY = "sk-real-provider-key";

      expect(() => resolveVoiceBroker()).toThrow(/no key/i);
    });

    it("prefers an explicit configuration over the environment", () => {
      process.env.LANGWATCH_VOICE_BROKER_URL = "https://from-env.example";
      process.env.OPENAI_API_KEY = "vk-from-env";

      expect(
        resolveVoiceBroker({ baseUrl: "https://explicit.example", apiKey: "vk-explicit" }),
      ).toEqual({ baseUrl: "https://explicit.example", apiKey: "vk-explicit" });
    });
  });
});

describe("given a mint through the gateway", () => {
  const broker = { baseUrl: "https://gateway.example", apiKey: "vk-lw-test" };

  it("sends the virtual key and reads back the vendor secret and session id", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://gateway.example/v1/realtime/client_secrets");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer vk-lw-test",
      );
      expect(JSON.parse(init.body as string)).toEqual({
        session: { type: "realtime", model: "gpt-realtime" },
      });
      return new Response(JSON.stringify({ value: "ek_abc", expires_at: 1 }), {
        status: 200,
        headers: { "x-langwatch-session-id": "req_123" },
      });
    });

    const minted = await mintOpenAIRealtimeSession(broker, {
      model: "gpt-realtime",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(minted).toEqual({ clientSecret: "ek_abc", sessionId: "req_123" });
  });

  it("reads the session id from the body when the header is absent", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            value: "ek_abc",
            langwatch: { session_id: "req_from_body" },
          }),
          { status: 200 },
        ),
    );

    const minted = await mintOpenAIRealtimeSession(broker, {
      model: "gpt-realtime",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(minted.sessionId).toBe("req_from_body");
  });

  it("surfaces the gateway's own refusal message", async () => {
    // The gateway names the cause: a budget, a session cap, a missing
    // provider. A bare status would send the reader to the wrong place.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "realtime_session_limit",
              message: "this virtual key already holds the most voice sessions",
            },
          }),
          { status: 429 },
        ),
    );

    await expect(
      mintOpenAIRealtimeSession(broker, {
        model: "gpt-realtime",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/realtime_session_limit/);
  });

  it("refuses a mint that returned no credential", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ expires_at: 1 }), { status: 200 }),
    );

    await expect(
      mintOpenAIRealtimeSession(broker, {
        model: "gpt-realtime",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no client secret/i);
  });
});

describe("given a usage report at the end of a session", () => {
  const broker = { baseUrl: "https://gateway.example", apiKey: "vk-lw-test" };

  it("posts the vendor's usage object against the session id", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://gateway.example/v1/realtime/sessions/req_123/usage",
      );
      expect(JSON.parse(init.body as string)).toEqual({
        usage: { input_tokens: 15, output_tokens: 43 },
      });
      return new Response("{}", { status: 202 });
    });

    await reportOpenAIRealtimeUsage(broker, {
      sessionId: "req_123",
      usage: { input_tokens: 15, output_tokens: 43 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends nothing when the mint never named a session", async () => {
    const fetchImpl = vi.fn();
    await reportOpenAIRealtimeUsage(broker, {
      sessionId: "",
      usage: { input_tokens: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws, because a billing report must not fail the test it measures", async () => {
    // The session still settles: the gateway closes an unreported admission
    // as cost-unknown once its grace expires.
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });

    await expect(
      reportOpenAIRealtimeUsage(broker, {
        sessionId: "req_123",
        usage: { input_tokens: 1 },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
