/**
 * Executor FAIL-CLOSED BACKSTOP (#705) — a REALTIME user agent driven by the
 * proceed()/autonomous-generation path must FAIL LOUD, never silently degrade
 * the user side.
 *
 * The OpenAI realtime adapter self-rejects in its own `call()` (the PRIMARY
 * guard, covered by openai-realtime-user-call-guard.test.ts). This file covers
 * the executor's backstop: a DIFFERENT realtime-user adapter that does NOT
 * self-reject (here, a fake whose `call()` returns text instead of throwing)
 * must still fail loud at `voiceifyGeneratedUserTurn` rather than fall through
 * and silently degrade the user turn to text. Scripted realtime-user turns
 * route through `speakUserTurn` (a different method) and are unaffected.
 *
 * Offline — no network, no real keys. The fake realtime user only needs to
 * satisfy `isRealtimeUserAgent` (sendText + speakUserTurn) and NOT self-reject.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";
import { user, agent, proceed } from "../../script";
import { REALTIME_USER_AUTONOMOUS_UNSUPPORTED } from "../../domain/agents/agent-shapes";
import { FakeVoiceAdapter } from "../../voice/__tests__/fixtures/fake-adapter";

/**
 * A realtime USER agent that does NOT self-reject: satisfies
 * `isRealtimeUserAgent` (has both `sendText` and `speakUserTurn`) and returns a
 * generated TEXT turn from `call()` instead of throwing — i.e. a hypothetical
 * non-OpenAI realtime adapter that omits the primary self-guard. This is the
 * shape the executor backstop exists to catch.
 */
class FakeRealtimeUser extends AgentAdapter {
  override role = AgentRole.USER;

  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "user" as const, content: "generated user turn" };
  }

  async sendText(_text: string): Promise<void> {
    /* no-op: the guard never lets the proceed() path reach here */
  }

  async speakUserTurn(
    text: string,
  ): Promise<{ data: Uint8Array; transcript?: string }> {
    // Non-empty PCM16 so the scripted path produces real audio bytes.
    return { data: new Uint8Array(200), transcript: text };
  }
}

describe("executor realtime-user + proceed() fail-closed backstop (#705)", () => {
  it("throws a clear, actionable error when proceed() drives a non-self-rejecting realtime user against a voice agent", async () => {
    const execution = new ScenarioExecution(
      {
        name: "realtime-user-proceed-guard",
        description: "proceed() must not silently degrade a realtime user turn",
        agents: [new FakeVoiceAdapter(), new FakeRealtimeUser()],
      },
      [proceed(1)],
      "batch-test",
    );

    // callAgent re-throws wrapped as `[agentName] ...`, so the message contains
    // the shared guard const (asserted directly, not a brittle substring).
    await expect(execution.execute()).rejects.toThrow(
      REALTIME_USER_AUTONOMOUS_UNSUPPORTED,
    );
  });

  it("does NOT fire the guard on the scripted user() path (the supported route)", async () => {
    // Scripted user() routes through `speakUserTurn` (verbatim) — a different
    // method that never reaches the proceed-path guard. The full scripted
    // exchange must RESOLVE (assert resolution, not merely the absence of one
    // error substring: a looser `.not.toMatch(/not supported yet/)` would also
    // pass if the run threw an UNRELATED error, hiding a regression).
    const execution = new ScenarioExecution(
      {
        name: "realtime-user-scripted-ok",
        description: "scripted realtime-user turns are unaffected by the guard",
        agents: [new FakeVoiceAdapter(), new FakeRealtimeUser()],
      },
      [user("Hi, I have a question about my account."), agent()],
      "batch-test",
    );

    await expect(execution.execute()).resolves.toBeDefined();
  });
});
