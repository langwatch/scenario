/**
 * Voice adapter lifecycle tests — binds `specs/voice-agents.feature` scenario
 * tagged `@ts-adapter`: "Executor calls connect() before and disconnect() after
 * every scenario".
 *
 * The PR3 scope of issue #372 promises the executor wraps every voice
 * adapter in a `connect()` → script → `disconnect()` sandwich, and that
 * the disconnect fires regardless of pass / fail / exception. These
 * tests exercise the runtime built in `adapter.runtime.ts` + the
 * executor patch in `execution/scenario-execution.ts`.
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 *
 * The bound Scenario covers only the happy-path contract named in the spec
 * (connect before step, disconnect after). Sub-cases for fail/throw/multi-
 * adapter/disconnect-swallow are implementation-level guarantees; they live
 * as plain it() blocks below. Option (b) chosen — specs/voice-agents.feature
 * does not name those sub-cases (confirmed via grep: no "fail", "throw",
 * "multi-adapter", or "disconnect error" scenario near line 138).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, it } from "vitest";

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { agent, fail, succeed, user } from "../../script";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

class TextUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Hi, this is a user turn.";
  }
}

// -------------------------------------------------------------------------
// Plain unit tests: implementation-level guarantees for disconnect() invariant.
//
// These sub-cases are not named in specs/voice-agents.feature (the spec's And
// step says "regardless of pass/fail/exception" as a single AC). Each case
// is a separate it() so vitest can pinpoint exactly which sub-case breaks.
// Option (b) chosen.
// -------------------------------------------------------------------------

it("disconnect() fires even on explicit fail()", async () => {
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

it("disconnect() fires even when a script step throws", async () => {
  // `failOnCall` causes the FakeVoiceAdapter's `call()` to throw — the
  // executor must unwind through the finally and still disconnect.
  const adapter = new FakeVoiceAdapter({ failOnCall: true });
  const execution = new ScenarioExecution(
    {
      name: "lifecycle / exception",
      description: "verifies disconnect runs after thrown error",
      agents: [adapter, new TextUserSimulator()],
    },
    [user("hello"), agent(), succeed("never reached")],
    "test-batch-id",
  );
  await expect(execution.execute()).rejects.toThrow(
    /FakeVoiceAdapter\.call failure/,
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
  // Mirrors the Python contract at scenario_executor.py:747-759.
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

// -------------------------------------------------------------------------
// Bound scenario — the spec-named happy-path contract.
// -------------------------------------------------------------------------

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: Executor calls connect() before and disconnect() after every
    // scenario (lines 138-143)
    // -----------------------------------------------------------------------
    Scenario(
      "Executor calls connect() before and disconnect() after every scenario",
      ({ Given, When, Then, And }) => {
        // Adapters are set up fresh inside each step so the assertions are
        // independent. The Given/When/Then structure maps to the spec's
        // stated precondition / trigger / observable outcomes.

        Given("any VoiceAgentAdapter subclass", () => {
          // FakeVoiceAdapter is the test-double VoiceAgentAdapter subclass.
          // No persistent state needed at Given — adapters are built per assertion.
        });

        When("scenario.run() starts and completes (success or error)", () => {
          // The run happens inside Then/And so we can capture per-run
          // observables without cross-contamination.
        });

        Then(
          "connect() was awaited exactly once before the first script step",
          async () => {
            // Happy path: connect before step, verified via wasConnectedAtFirstCall.
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
          },
        );

        And(
          "disconnect() was awaited exactly once regardless of pass/fail/exception",
          async () => {
            // Happy path: disconnect fires once after success.
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
          },
        );
      },
    );
  },
  { includeTags: ["ts-adapter"] },
);
