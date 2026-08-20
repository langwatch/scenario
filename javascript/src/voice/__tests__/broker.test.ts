/**
 * Minting a realtime voice session.
 *
 * The subject is the contract between an adapter and whatever answers
 * `OPENAI_BASE_URL`: which key mints, what the socket then dials with, how the
 * adapter learns a gateway brokered the call, and what closes the spend
 * record. Money depends on all four, so each is asserted rather than inferred
 * from a connection succeeding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mintOpenAIRealtimeSession,
  reportOpenAIRealtimeUsage,
  resolveRealtimeMintEndpoint,
} from "../broker";

const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
] as const;

describe("given the environment scenario already uses for chat", () => {
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

  describe("when OPENAI_BASE_URL is unset", () => {
    it("mints at OpenAI, because the path is OpenAI's own", () => {
      process.env.OPENAI_API_KEY = "sk-provider";

      expect(resolveRealtimeMintEndpoint()).toEqual({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-provider",
      });
    });
  });

  describe("when OPENAI_BASE_URL points at a gateway", () => {
    it("mints there with the same key chat uses, and needs nothing else", () => {
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1/";
      process.env.OPENAI_API_KEY = "vk-lw-test";

      expect(resolveRealtimeMintEndpoint()).toEqual({
        baseUrl: "https://gateway.example/v1",
        apiKey: "vk-lw-test",
      });
    });

    it("prefers an explicit endpoint over the environment", () => {
      process.env.OPENAI_BASE_URL = "https://from-env.example/v1";
      process.env.OPENAI_API_KEY = "vk-from-env";

      expect(
        resolveRealtimeMintEndpoint({
          baseUrl: "https://explicit.example/v1",
          apiKey: "vk-explicit",
        }),
      ).toEqual({
        baseUrl: "https://explicit.example/v1",
        apiKey: "vk-explicit",
      });
    });
  });

  describe("when only OPENAI_REALTIME_API_KEY is set", () => {
    it("does not mint with it, so the adapter dials the vendor directly", () => {
      // That variable holds a direct provider key. Minting with it would
      // present a gateway a credential it did not issue and cannot bill, and
      // the refusal would read as a gateway outage.
      process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
      process.env.OPENAI_REALTIME_API_KEY = "sk-real-provider-key";

      expect(resolveRealtimeMintEndpoint()).toBeNull();
    });
  });
});

describe("given a mint request", () => {
  const endpoint = {
    baseUrl: "https://gateway.example/v1",
    apiKey: "vk-lw-test",
  };

  it("sends the key and reads back the vendor secret and the session id", async () => {
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

    const result = await mintOpenAIRealtimeSession(endpoint, {
      model: "gpt-realtime",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      minted: true,
      clientSecret: "ek_abc",
      sessionId: "req_123",
    });
  });

  it("reports no session id when the vendor answered, because only a gateway names one", async () => {
    // This is how the adapter learns what it is talking to. OpenAI's own mint
    // carries no such header, so there is nothing to report usage to and
    // nothing that would accept a report.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: "ek_from_openai" }), {
          status: 200,
        }),
    );

    const result = await mintOpenAIRealtimeSession(endpoint, {
      model: "gpt-realtime",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      minted: true,
      clientSecret: "ek_from_openai",
      sessionId: "",
    });
  });

  it("reports an absent mint route rather than raising, so the caller can dial directly", async () => {
    // A LangWatch gateway older than this feature answers 404 here. That is an
    // absence, not a refusal, and the adapter falls back to a direct dial.
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));

    const result = await mintOpenAIRealtimeSession(endpoint, {
      model: "gpt-realtime",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ minted: false, status: 404 });
  });

  it("raises on a refusal, so a declined session never falls back to a provider key", async () => {
    // The endpoint's own message names the cause: a budget, a session cap, a
    // missing provider. Falling back here would run a call the gateway just
    // declined to bill.
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
      mintOpenAIRealtimeSession(endpoint, {
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
      mintOpenAIRealtimeSession(endpoint, {
        model: "gpt-realtime",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no client secret/i);
  });
});

describe("given a usage report at the end of a session", () => {
  const endpoint = {
    baseUrl: "https://gateway.example/v1",
    apiKey: "vk-lw-test",
  };

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

    await reportOpenAIRealtimeUsage(endpoint, {
      sessionId: "req_123",
      usage: { input_tokens: 15, output_tokens: 43 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends nothing when the vendor minted the session", async () => {
    const fetchImpl = vi.fn();
    await reportOpenAIRealtimeUsage(endpoint, {
      sessionId: "",
      usage: { input_tokens: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a refusal, because a rejected report is not a delivered one", async () => {
    // A 404 for an unknown session or a 401 for a rotated key answers, so
    // nothing throws. Reading only the thrown case would treat both as a
    // report that landed, and the session would settle as cost-unknown with
    // nobody told why.
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("no", { status: 404 }));

    await reportOpenAIRealtimeUsage(endpoint, {
      sessionId: "req_123",
      usage: { input_tokens: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError,
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/HTTP 404/);
  });

  it("gives up on a stalled gateway rather than holding the socket open", async () => {
    // disconnect() awaits this, so an unbounded request keeps the websocket
    // open and the test that owns it never finishes.
    const onError = vi.fn();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    );

    await reportOpenAIRealtimeUsage(endpoint, {
      sessionId: "req_123",
      usage: { input_tokens: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      onError,
    });

    expect(onError).toHaveBeenCalledOnce();
    // The bound came from the signal the helper attached, not from the test
    // giving up first.
    expect(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.signal,
    ).toBeInstanceOf(AbortSignal);
  });

  it("never throws, because a billing report must not fail the test it measures", async () => {
    // The session still settles: the gateway closes an unreported admission as
    // cost-unknown once its grace expires.
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });

    await expect(
      reportOpenAIRealtimeUsage(endpoint, {
        sessionId: "req_123",
        usage: { input_tokens: 1 },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
