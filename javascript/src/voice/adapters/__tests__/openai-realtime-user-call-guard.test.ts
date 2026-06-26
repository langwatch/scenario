/**
 * Primary guard (#705) — `OpenAIRealtimeAgentAdapter.call()` fails loud, AT THE
 * ADAPTER, when invoked with `role=USER`.
 *
 * Why at the adapter (not only the executor): a realtime USER agent speaks
 * SCRIPTED lines via `speakUserTurn`, which the executor routes WITHOUT calling
 * `call()`. So reaching `call()` with role=USER means the executor is driving
 * this agent autonomously (proceed()/generated turns) — unsupported, because
 * the realtime session (turn_detection:null, no out-of-band response.create)
 * produces no spoken user turn. Rejecting HERE fires BEFORE `defaultVoiceCall`
 * sends audio and blocks on a `receiveAudio` that would time out — so the clean
 * guidance actually surfaces instead of a confusing downstream timeout.
 *
 * This is the test that the prior executor-only guard could not honestly give:
 * the guard fires synchronously, before any connection, no server/keys needed.
 */

import { describe, it, expect } from "vitest";

import { AgentRole, type AgentInput } from "../../../domain/agents";
import { REALTIME_USER_AUTONOMOUS_UNSUPPORTED } from "../../../domain/agents/agent-shapes";
import { OPENAI_REALTIME_MODEL, OpenAIRealtimeAgentAdapter } from "../../index";

/** Minimal AgentInput — the guard rejects before reading any of it. */
function emptyInput(role: AgentRole): AgentInput {
  return {
    threadId: "t",
    messages: [],
    newMessages: [],
    requestedRole: role,
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
  };
}

describe("OpenAIRealtimeAgentAdapter.call() realtime-user guard (#705)", () => {
  it("throws the unsupported-autonomous-user message when role=USER, BEFORE connecting", async () => {
    const adapter = new OpenAIRealtimeAgentAdapter({
      model: OPENAI_REALTIME_MODEL,
      role: AgentRole.USER,
      // No apiKey, no url, no connect() — the guard must fire before any of
      // that matters. If it didn't, this would instead surface a transport
      // error, never the clean guidance.
    });

    await expect(adapter.call(emptyInput(AgentRole.USER))).rejects.toThrow(
      REALTIME_USER_AUTONOMOUS_UNSUPPORTED,
    );
  });

  it("throws a non-guard transport error when role=AGENT and unconnected", async () => {
    // A role=AGENT realtime adapter is a normal agent under test: call() must
    // NOT hit the realtime-user guard. Unconnected, it fails with a transport
    // error instead — distinct from the guard message.
    const adapter = new OpenAIRealtimeAgentAdapter({
      model: OPENAI_REALTIME_MODEL,
      role: AgentRole.AGENT,
    });

    const err = await adapter
      .call(emptyInput(AgentRole.AGENT))
      .catch((e: unknown) => e);
    expect(err, "role=AGENT call() should fail for a non-guard reason").toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe(REALTIME_USER_AUTONOMOUS_UNSUPPORTED);
  });
});
