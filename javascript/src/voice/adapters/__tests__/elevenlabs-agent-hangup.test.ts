/**
 * Issue #839 — an agent-initiated hangup ends the scenario gracefully.
 *
 * Hosted voice agents commonly hang up on purpose: an ElevenLabs agent invokes
 * the `end_call` system tool right after its farewell, which closes the
 * WebSocket. When the scripted scenario still has `agent()` / `user()` steps
 * left, the next `agent()` used to throw `PendingTransportError` and fail a run
 * in which the agent behaved exactly as designed.
 *
 * The adapter now recognises the `agent_tool_response` frame EL emits for a
 * successful hangup tool and records it on `agentHungUp`; `defaultVoiceCall`'s
 * connected-state gate then concludes instead of throwing.
 *
 * Wire shape captured live from the real EL ConvAI transport:
 *
 *   {"type": "agent_tool_response",
 *    "agent_tool_response": {"tool_name": "end_call",
 *      "tool_call_id": "end_call_bf80…", "tool_type": "system",
 *      "is_error": false, "is_blocked": false, "event_id": 20,
 *      "is_called": true}}
 *
 * …followed by a clean close (code 1000).
 *
 * No real network: the SDK runs against the in-memory fake socket.
 */
import { describe, it, expect } from "vitest";

import type { AgentInput } from "../../../domain/agents";
import { ElevenLabsAgentAdapter } from "../index";
import { PendingTransportError } from "../pending-transport-error";
import { FakeWebSocket, makeFakeConv } from "./fixtures/fake-elevenlabs-conversation";

/** Feed one inbound EL ConvAI frame to the SDK over the fake socket. */
function emit(socket: FakeWebSocket, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event), "utf-8"));
}

function hangupFrame(
  toolName = "end_call",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "agent_tool_response",
    agent_tool_response: {
      tool_name: toolName,
      tool_call_id: `${toolName}_abc123`,
      tool_type: "system",
      is_error: false,
      is_blocked: false,
      event_id: 20,
      is_called: true,
      ...overrides,
    },
  };
}

async function makeConnected(): Promise<{
  adapter: ElevenLabsAgentAdapter;
  socket: FakeWebSocket;
}> {
  const fake = makeFakeConv();
  const adapter = new ElevenLabsAgentAdapter({
    agentId: "agt-hangup",
    apiKey: "sk-hangup",
    webSocketFactory: fake.webSocketFactory,
    conversationClient: fake.conversationClient,
  });
  await adapter.connect();
  return { adapter, socket: fake.socket.current! };
}

const agentInput = () =>
  ({
    threadId: "t-839",
    messages: [],
    newMessages: [],
  }) as unknown as AgentInput;

describe("#839 — agent-initiated hangup", () => {
  it("marks agentHungUp when the agent successfully invokes end_call", async () => {
    const { adapter, socket } = await makeConnected();
    expect(adapter.agentHungUp).toBe(false);

    emit(socket, hangupFrame());

    expect(adapter.agentHungUp).toBe(true);
    await adapter.disconnect();
  });

  it.each(["transfer_to_agent", "transfer_to_number", "transfer_to_genesys"])(
    "treats %s as the agent ending this session",
    async (toolName) => {
      const { adapter, socket } = await makeConnected();

      emit(socket, hangupFrame(toolName));

      expect(adapter.agentHungUp).toBe(true);
      await adapter.disconnect();
    },
  );

  it.each([
    ["not called", { is_called: false }],
    ["errored", { is_error: true }],
    ["blocked", { is_blocked: true }],
  ])(
    "does NOT mark a hangup when the tool was %s",
    async (_label, overrides) => {
      const { adapter, socket } = await makeConnected();

      emit(socket, hangupFrame("end_call", overrides));

      expect(adapter.agentHungUp).toBe(false);
      await adapter.disconnect();
    },
  );

  it("ignores unrelated agent tool responses", async () => {
    const { adapter, socket } = await makeConnected();

    emit(socket, hangupFrame("language_detection"));

    expect(adapter.agentHungUp).toBe(false);
    await adapter.disconnect();
  });

  it("concludes a scripted turn issued after the hangup instead of throwing", async () => {
    const { adapter, socket } = await makeConnected();

    emit(socket, hangupFrame());
    await adapter.disconnect(); // EL closes the socket right after the tool frame

    expect(adapter.agentHungUp).toBe(true);
    expect(adapter.isConnected()).toBe(false);

    // The leftover scripted agent() turn — used to throw PendingTransportError.
    await expect(adapter.call(agentInput())).resolves.toEqual([]);
  });

  it("still throws for a dropped transport with no deliberate hangup", async () => {
    const { adapter } = await makeConnected();
    await adapter.disconnect();

    expect(adapter.agentHungUp).toBe(false);
    await expect(adapter.call(agentInput())).rejects.toThrow(PendingTransportError);
  });
});
