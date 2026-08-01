/**
 * RealtimeAgentAdapter.connect() API-key resolution.
 *
 * The Realtime API is a direct websocket to api.openai.com that an
 * OpenAI-compatible gateway cannot proxy. When CI routes OPENAI_API_KEY
 * through a gateway (a LangWatch virtual key), the dedicated
 * OPENAI_REALTIME_API_KEY must win, mirroring OpenAIRealtimeAdapter.
 * Regression: the virtual key leaked into the websocket and OpenAI
 * rejected it with invalid_api_key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentRole } from "../../domain";
import { RealtimeAgentAdapter } from "../realtime/realtime-agent.adapter";

type ConnectParams = { apiKey?: string };

function makeAdapter(recorded: ConnectParams[]): RealtimeAgentAdapter {
  const session = {
    transport: { on: () => undefined, sendEvent: () => undefined },
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
  });
}

describe("RealtimeAgentAdapter.connect API-key resolution", () => {
  const savedRealtimeKey = process.env.OPENAI_REALTIME_API_KEY;
  const savedOpenAIKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_REALTIME_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedRealtimeKey === undefined) {
      delete process.env.OPENAI_REALTIME_API_KEY;
    } else {
      process.env.OPENAI_REALTIME_API_KEY = savedRealtimeKey;
    }
    if (savedOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    }
  });

  it("an explicit params.apiKey wins over both env vars", async () => {
    process.env.OPENAI_REALTIME_API_KEY = "sk-realtime";
    process.env.OPENAI_API_KEY = "vk-lw-virtual";
    const recorded: ConnectParams[] = [];
    await makeAdapter(recorded).connect({ apiKey: "sk-explicit" });
    expect(recorded[0]?.apiKey).toBe("sk-explicit");
  });

  it("OPENAI_REALTIME_API_KEY wins over OPENAI_API_KEY", async () => {
    process.env.OPENAI_REALTIME_API_KEY = "sk-realtime";
    process.env.OPENAI_API_KEY = "vk-lw-virtual";
    const recorded: ConnectParams[] = [];
    await makeAdapter(recorded).connect();
    expect(recorded[0]?.apiKey).toBe("sk-realtime");
  });

  it("falls back to OPENAI_API_KEY when no realtime key is set", async () => {
    process.env.OPENAI_API_KEY = "sk-plain";
    const recorded: ConnectParams[] = [];
    await makeAdapter(recorded).connect();
    expect(recorded[0]?.apiKey).toBe("sk-plain");
  });

  it("throws a clear error when no key is available anywhere", async () => {
    const recorded: ConnectParams[] = [];
    await expect(makeAdapter(recorded).connect()).rejects.toThrow(
      /OPENAI_REALTIME_API_KEY \/ OPENAI_API_KEY/,
    );
    expect(recorded).toHaveLength(0);
  });
});
