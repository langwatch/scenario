/**
 * Voice adapter lifecycle tests — binds `specs/voice-agents.feature`
 * lines 138-145 (`Executor calls connect() before and disconnect() after
 * every scenario`).
 *
 * The PR3 scope of issue #372 promises the executor wraps every voice
 * adapter in a `connect()` → script → `disconnect()` sandwich, and that
 * the disconnect fires regardless of pass / fail / exception. These
 * tests exercise the runtime built in `adapter.runtime.ts` + the
 * executor patch in `execution/scenario-execution.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { agent, fail, succeed, user } from "../../script";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

class TextUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Hi, this is a user turn.";
  }
}

describe("specs/voice-agents.feature lines 138-145 — Executor calls connect() before and disconnect() after every scenario", () => {
  it("connect() is awaited exactly once before the first script step", async () => {
    const adapter = new FakeVoiceAdapter();
    const execution = new ScenarioExecution(
      {
        name: "lifecycle / happy path",
        description: "verifies connect-before-step + disconnect-after",
        agents: [adapter, new TextUserSimulator()],
      },
      [user("hello"), agent(), succeed("done")],
      "test-batch-id",
    );

    await execution.execute();

    expect(adapter.connectCount).toBe(1);
    // The fake adapter snapshots (connectCount === 1 && disconnectCount === 0)
    // inside its first call() invocation — proves connect was awaited
    // before the agent step, not after.
    expect(adapter.wasConnectedAtFirstCall).toBe(true);
  });

  it("disconnect() is awaited exactly once on the happy path", async () => {
    const adapter = new FakeVoiceAdapter();
    const execution = new ScenarioExecution(
      {
        name: "lifecycle / happy path / disconnect once",
        description: "verifies disconnect runs after success",
        agents: [adapter, new TextUserSimulator()],
      },
      [user("hello"), agent(), succeed("done")],
      "test-batch-id",
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
    expect(adapter.disconnectCount).toBe(1);
  });

  it("disconnect() is awaited even when the scenario fails", async () => {
    const adapter = new FakeVoiceAdapter();
    const execution = new ScenarioExecution(
      {
        name: "lifecycle / fail() still disconnects",
        description: "verifies disconnect runs after explicit fail()",
        agents: [adapter, new TextUserSimulator()],
      },
      [user("hello"), agent(), fail("test-driven failure")],
      "test-batch-id",
    );

    const result = await execution.execute();
    expect(result.success).toBe(false);
    expect(adapter.disconnectCount).toBe(1);
  });

  it("disconnect() is awaited even when a script step throws", async () => {
    // The AC says "regardless of pass/fail/exception". Throwing AGENT
    // simulates an adapter raising mid-call — the executor must still
    // unwind through the finally and disconnect.
    class ThrowingAgent extends AgentAdapter {
      role = AgentRole.AGENT;
      async call(_input: AgentInput): Promise<AgentReturnTypes> {
        throw new Error("simulated agent failure");
      }
    }

    const adapter = new FakeVoiceAdapter();
    const execution = new ScenarioExecution(
      {
        name: "lifecycle / exception",
        description: "verifies disconnect runs after thrown error",
        agents: [adapter, new ThrowingAgent(), new TextUserSimulator()],
      },
      // The executor picks the AGENT-role agent for `agent()` — the
      // ThrowingAgent will run before the FakeVoiceAdapter; the test
      // only cares that disconnect runs on the voice adapter when the
      // execution loop blows up.
      [user("hello"), agent(), succeed("never reached")],
      "test-batch-id",
    );

    await expect(execution.execute()).rejects.toThrow(
      /simulated agent failure/,
    );
    expect(adapter.connectCount).toBe(1);
    expect(adapter.disconnectCount).toBe(1);
  });

  it("multiple voice adapters each get exactly one connect + one disconnect", async () => {
    const adapterA = new FakeVoiceAdapter();
    const adapterB = new FakeVoiceAdapter();

    const execution = new ScenarioExecution(
      {
        name: "lifecycle / multi-adapter",
        description: "verifies lifecycle fans out across all voice adapters",
        agents: [adapterA, adapterB, new TextUserSimulator()],
      },
      [user("hello"), agent(), succeed("done")],
      "test-batch-id",
    );

    await execution.execute();

    expect(adapterA.connectCount).toBe(1);
    expect(adapterA.disconnectCount).toBe(1);
    expect(adapterB.connectCount).toBe(1);
    expect(adapterB.disconnectCount).toBe(1);
  });

  it("disconnect errors are swallowed so cleanup never masks the scenario result", async () => {
    // Mirrors the Python contract at scenario_executor.py:747-759 — a
    // failed disconnect must not poison the result we return to the user.
    const adapter = new FakeVoiceAdapter({ failOnDisconnect: true });
    const execution = new ScenarioExecution(
      {
        name: "lifecycle / disconnect error swallowed",
        description: "verifies disconnect failure does not propagate",
        agents: [adapter, new TextUserSimulator()],
      },
      [user("hello"), agent(), succeed("done")],
      "test-batch-id",
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
  });
});
