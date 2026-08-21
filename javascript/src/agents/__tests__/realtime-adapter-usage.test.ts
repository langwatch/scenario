/**
 * What RealtimeAgentAdapter reports when a brokered session ends.
 *
 * A gateway opens a spend record at the mint, and only a usage report closes
 * it. Two things decide whether the record is right:
 *
 * - the vendor reports usage per response, not per session, so a session that
 *   keeps only the last `response.done` bills for its last turn. Measured
 *   against the live Realtime API on 2026-08-21: two turns on one socket
 *   reported `output_tokens` 4 and 4, not 4 and 8;
 * - a session that produced no response still has to be closed, or it holds
 *   one of the key's slots until the gateway's grace expires. The counts are
 *   stated rather than omitted, because the gateway answers HTTP 400 to a
 *   usage body carrying neither `input_tokens` nor `output_tokens`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentRole } from "../../domain";
import { RealtimeAgentAdapter } from "../realtime/realtime-agent.adapter";

const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

/** Every usage body the adapter posted to the gateway, newest last. */
let reported: Array<Record<string, unknown>> = [];
/** The raw-event handlers the adapter attached to the transport. */
let taps: Array<(event: unknown) => void> = [];

function makeAdapter(): RealtimeAgentAdapter {
  const session = {
    transport: {
      on: (event: string, handler: (e: unknown) => void) => {
        if (event === "*") taps.push(handler);
      },
      sendEvent: () => undefined,
    },
    options: { model: "gpt-realtime" },
    connect: async () => undefined,
    close: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ConstructorParameters<
    typeof RealtimeAgentAdapter
  >[0]["session"];

  return new RealtimeAgentAdapter({
    session,
    role: AgentRole.AGENT,
    agentName: "Usage Test Agent",
    responseTimeout: 1000,
  });
}

/** One `response.done` frame, as the vendor sends it. */
function responseDone(usage: Record<string, unknown>): unknown {
  return { type: "response.done", response: { usage } };
}

function pushToTaps(event: unknown): void {
  for (const tap of taps) tap(event);
}

describe("given a brokered RealtimeAgentAdapter session that ends", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
    process.env.OPENAI_API_KEY = "vk-lw-test";
    reported = [];
    taps = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/client_secrets")) {
          return new Response(JSON.stringify({ value: "ek_minted_secret" }), {
            status: 200,
            headers: { "x-langwatch-session-id": "req_abc" },
          });
        }
        reported.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }),
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports every turn, not the last one", async () => {
    const adapter = makeAdapter();
    await adapter.connect();

    pushToTaps(
      responseDone({ input_tokens: 120, output_tokens: 4, total_tokens: 124 }),
    );
    pushToTaps(
      responseDone({ input_tokens: 135, output_tokens: 4, total_tokens: 139 }),
    );
    await adapter.disconnect();

    expect(reported).toEqual([
      {
        usage: { input_tokens: 255, output_tokens: 8, total_tokens: 263 },
      },
    ]);
  });

  it("sums the nested detail objects a gateway prices separately", async () => {
    const adapter = makeAdapter();
    await adapter.connect();

    pushToTaps(
      responseDone({
        input_tokens: 10,
        output_token_details: { audio_tokens: 3, text_tokens: 1 },
      }),
    );
    pushToTaps(
      responseDone({
        input_tokens: 5,
        output_token_details: { audio_tokens: 2, text_tokens: 1 },
      }),
    );
    await adapter.disconnect();

    expect(reported[0]).toEqual({
      usage: {
        input_tokens: 15,
        output_tokens: 0,
        output_token_details: { audio_tokens: 5, text_tokens: 2 },
      },
    });
  });

  it("closes a session that produced no response at all, at zero", async () => {
    const adapter = makeAdapter();
    await adapter.connect();
    await adapter.disconnect();

    // Stated zeros, not an empty object: the gateway answers HTTP 400 to a
    // body carrying neither count, which would leave the record open.
    expect(reported).toEqual([
      { usage: { input_tokens: 0, output_tokens: 0 } },
    ]);
  });

  it("reports once, so a second disconnect cannot bill the session twice", async () => {
    const adapter = makeAdapter();
    await adapter.connect();
    await adapter.disconnect();
    await adapter.disconnect();

    expect(reported).toHaveLength(1);
  });

  it("attaches one usage tap across reconnects, so a turn is not counted twice", async () => {
    const adapter = makeAdapter();
    await adapter.connect();
    await adapter.disconnect();
    await adapter.connect();

    pushToTaps(responseDone({ input_tokens: 10, output_tokens: 2 }));
    await adapter.disconnect();

    expect(taps).toHaveLength(1);
    expect(reported[1]).toEqual({
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  });

  it("reports nothing when no gateway minted the session", async () => {
    // The vendor minted it, so there is no spend record anywhere to close.
    delete process.env.OPENAI_BASE_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/client_secrets")) {
          return new Response(JSON.stringify({ value: "ek_minted_secret" }), {
            status: 200,
          });
        }
        reported.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }),
    );

    const adapter = makeAdapter();
    await adapter.connect();
    await adapter.disconnect();

    expect(reported).toEqual([]);
  });
});
