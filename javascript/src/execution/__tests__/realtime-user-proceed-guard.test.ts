/**
 * Executor guard (#705) — a REALTIME user agent driven by the
 * proceed()/autonomous-generation path must FAIL LOUD, never silently degrade
 * the user side.
 *
 * A realtime user speaks SCRIPTED lines verbatim via `speakUserTurn` (the
 * `user("...")` route). proceed() instead drives the producer through `call()`,
 * which — with the realtime session's `turn_detection:null` and no out-of-band
 * `response.create` — yields no spoken user turn. Emitting that as an
 * empty/text user turn is the silent voice→text substitution we never ship;
 * the executor throws instead, pointing at the supported path. Scripted
 * realtime-user turns route through a DIFFERENT method and are unaffected.
 *
 * Offline — no network, no real keys. The realtime user is a minimal fake that
 * only needs to satisfy `isRealtimeUserAgent` (sendText + speakUserTurn).
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";
import { user, proceed } from "../../script";
import { FakeVoiceAdapter } from "../../voice/__tests__/fixtures/fake-adapter";

/**
 * Minimal realtime USER agent: satisfies `isRealtimeUserAgent` (has both
 * `sendText` and `speakUserTurn`) and returns a generated TEXT turn from
 * `call()` — the shape proceed() would broadcast were the guard absent.
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

describe("executor realtime-user + proceed() guard (#705)", () => {
  it("throws a clear, actionable error when proceed() drives a realtime user against a voice agent", async () => {
    const execution = new ScenarioExecution(
      {
        name: "realtime-user-proceed-guard",
        description: "proceed() must not silently degrade a realtime user turn",
        agents: [new FakeVoiceAdapter(), new FakeRealtimeUser()],
      },
      [proceed(1)],
      "batch-test",
    );

    // The error is re-thrown wrapped as `[agentName] ...` by callAgent, so we
    // match on the distinctive, stable substring of the guard message.
    await expect(execution.execute()).rejects.toThrow("not supported yet");
  });

  it("does NOT fire the guard on the scripted user() path (the supported route)", async () => {
    // Scripted user() routes through `speakUserTurn` (verbatim) — a different
    // method that never reaches the proceed-path guard. Whatever the run does,
    // it must not throw the guard error.
    const execution = new ScenarioExecution(
      {
        name: "realtime-user-scripted-ok",
        description: "scripted realtime-user turns are unaffected by the guard",
        agents: [new FakeVoiceAdapter(), new FakeRealtimeUser()],
      },
      [user("Hi, I have a question about my account.")],
      "batch-test",
    );

    let err: unknown;
    try {
      await execution.execute();
    } catch (e) {
      err = e;
    }
    expect(String(err ?? "")).not.toMatch(/not supported yet/);
  });
});
