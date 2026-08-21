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
  accumulateRealtimeUsage,
  acquireRealtimeSocketKey,
  mintOpenAIRealtimeSession,
  reportOpenAIRealtimeUsage,
  resolveRealtimeMintEndpoint,
  zeroRealtimeUsage,
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

/** A fetch that never answers, and rejects only when its signal aborts. */
function stallUntilAborted(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(init.signal?.reason ?? new Error("aborted")),
    );
  });
}

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

  it("gives up on a stalled endpoint rather than leaving connect pending", async () => {
    // connect() waits for the mint before it opens the socket, so an
    // unbounded request leaves connection setup pending forever and the
    // caller never learns why.
    const fetchImpl = vi.fn(stallUntilAborted);

    await expect(
      mintOpenAIRealtimeSession(endpoint, {
        model: "gpt-realtime",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow();

    // The bound came from the signal the mint attached, not from the test
    // giving up first.
    expect(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.signal,
    ).toBeInstanceOf(AbortSignal);
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
    const timeoutMs = 20;
    const onError = vi.fn();
    const fetchImpl = vi.fn(stallUntilAborted);

    await reportOpenAIRealtimeUsage(endpoint, {
      sessionId: "req_123",
      usage: { input_tokens: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs,
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

/**
 * The mint-or-dial rule itself, in the one place it is implemented.
 *
 * Both realtime adapters call this, so a difference between them cannot exist
 * without this function saying two things at once.
 */
describe("given a socket that needs a credential", () => {
  const endpoint = { baseUrl: "https://gateway.example/v1", apiKey: "vk-lw" };
  const fallback = { apiKey: "sk-direct", source: "OPENAI_REALTIME_API_KEY" };
  const noCredentialMessage = "TestAdapter: no API key.";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the ephemeral secret and the session id when a gateway mints", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: "ek_secret" }), {
          status: 200,
          headers: { "x-langwatch-session-id": "req_abc" },
        }),
    );

    await expect(
      acquireRealtimeSocketKey(endpoint, fallback, {
        model: "gpt-realtime",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        noCredentialMessage,
      }),
    ).resolves.toEqual({
      socketKey: "ek_secret",
      sessionId: "req_abc",
      minted: true,
    });
  });

  it.each([401, 402, 403, 429, 500, 503])(
    "raises on HTTP %i, so a refused session is never dialled around",
    async (status) => {
      // The endpoint answered, so it has the route and declined this call.
      // Falling back here would spend a provider key on a call the gateway
      // refused to bill, which is the one thing the broker exists to stop.
      const fetchImpl = vi.fn(async () => new Response("no", { status }));

      await expect(
        acquireRealtimeSocketKey(endpoint, fallback, {
          model: "gpt-realtime",
          fetchImpl: fetchImpl as unknown as typeof fetch,
          noCredentialMessage,
        }),
      ).rejects.toThrow(new RegExp(`refused with HTTP ${status}`));
    },
  );

  it("falls back on HTTP 404, because an absent route is not a refusal", async () => {
    // 404 means the base URL is not a LangWatch gateway: a plain OpenAI-
    // compatible proxy, or a gateway older than this feature. Third-party
    // setups keep working.
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      acquireRealtimeSocketKey(endpoint, fallback, {
        model: "gpt-realtime",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        noCredentialMessage,
      }),
    ).resolves.toEqual({
      socketKey: "sk-direct",
      sessionId: "",
      minted: false,
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("prints the direct-dial warning with LOG_LEVEL unset, so a bypass is visible in CI", async () => {
    // LOG_LEVEL unset resolves to INFO, which passes WARN. An unbilled run
    // that logged nothing would read exactly like a billed one.
    const savedLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await acquireRealtimeSocketKey(endpoint, fallback, {
        model: "gpt-realtime",
        fetchImpl: (async () =>
          new Response("nope", { status: 404 })) as unknown as typeof fetch,
        noCredentialMessage,
      });
    } finally {
      if (savedLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLevel;
    }

    expect(warn.mock.calls.map(String).join(" ")).toMatch(/not billed/);
  });

  it("dials directly with no mint attempt when there is no endpoint", async () => {
    await expect(
      acquireRealtimeSocketKey(null, fallback, {
        model: "gpt-realtime",
        noCredentialMessage,
      }),
    ).resolves.toEqual({
      socketKey: "sk-direct",
      sessionId: "",
      minted: false,
    });
  });

  it("raises the caller's own message when nothing is left to dial with", async () => {
    // The message names the adapter and its variables, so a misconfigured run
    // says which one to set rather than which function noticed.
    await expect(
      acquireRealtimeSocketKey(
        null,
        { apiKey: "", source: "OPENAI_API_KEY" },
        { model: "gpt-realtime", noCredentialMessage },
      ),
    ).rejects.toThrow(noCredentialMessage);
  });
});

/**
 * What a session reports, given what the vendor actually sends.
 *
 * OpenAI reports usage per response, not per session. Measured against the
 * live Realtime API on 2026-08-21, two turns on one socket reported
 * `input=120 output=4` then `input=135 output=4`. Cumulative would have been
 * `output=8`. So keeping only the last `response.done` bills a ten-turn call
 * for its last turn, and that is worse than reporting nothing: an unreported
 * session settles as cost-unknown at the gateway's grace, while a wrong report
 * arrives looking authoritative.
 */
describe("given the usage a realtime socket reports", () => {
  it("sums the turns the live API actually sent, rather than keeping the last", () => {
    const turn0 = { input_tokens: 120, output_tokens: 4, total_tokens: 124 };
    const turn1 = { input_tokens: 135, output_tokens: 4, total_tokens: 139 };

    const total = accumulateRealtimeUsage(
      accumulateRealtimeUsage(zeroRealtimeUsage(), turn0),
      turn1,
    );

    expect(total).toEqual({
      input_tokens: 255,
      output_tokens: 8,
      total_tokens: 263,
    });
  });

  it("sums the nested detail objects a gateway prices separately", () => {
    // Audio, text and cached splits are priced at different rates, so dropping
    // them bills the right token count at the wrong price.
    const first = {
      input_tokens: 10,
      input_token_details: {
        text_tokens: 6,
        audio_tokens: 4,
        cached_tokens: 2,
        cached_tokens_details: { audio_tokens: 1 },
      },
      output_token_details: { audio_tokens: 3 },
    };
    const second = {
      input_tokens: 5,
      input_token_details: {
        text_tokens: 1,
        audio_tokens: 4,
        cached_tokens: 0,
        cached_tokens_details: { audio_tokens: 1 },
      },
      output_token_details: { audio_tokens: 2 },
    };

    expect(accumulateRealtimeUsage(first, second)).toEqual({
      input_tokens: 15,
      input_token_details: {
        text_tokens: 7,
        audio_tokens: 8,
        cached_tokens: 2,
        cached_tokens_details: { audio_tokens: 2 },
      },
      output_token_details: { audio_tokens: 5 },
    });
  });

  it("accumulates a count the vendor adds later without being told about it", () => {
    // No key list, so a new counter adds up on its own instead of being
    // silently dropped from the record.
    const total = accumulateRealtimeUsage(
      { input_tokens: 1, reasoning_tokens: 7 },
      { input_tokens: 1, reasoning_tokens: 5 },
    );

    expect(total.reasoning_tokens).toBe(12);
  });

  it("carries a flag rather than adding it, because a flag is not a count", () => {
    const total = accumulateRealtimeUsage(
      { input_tokens: 1, truncated: false },
      { input_tokens: 1, truncated: true },
    );

    expect(total.truncated).toBe(true);
  });

  it("starts a session at stated zeros, because an empty body is refused", () => {
    // The gateway reads a report by looking for input_tokens or output_tokens
    // and answers HTTP 400 to a body carrying neither, which leaves the
    // session open holding one of the key's slots.
    expect(zeroRealtimeUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("hands out a fresh zero each call, so one session cannot bill another", () => {
    const first = zeroRealtimeUsage();
    accumulateRealtimeUsage(first, { input_tokens: 99 });

    expect(zeroRealtimeUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
