/**
 * proceed(N) turn-count regression guard (#39).
 *
 * Ground-truth findings (the user simulator is driven once per turn, so
 * `sim.calls` is the authoritative turn count):
 *   - BARE `proceed(N)` drives EXACTLY N turns (asserted below).
 *   - A scripted `user(...)` opener BEFORE `proceed(N)` counts as one of the N,
 *     so it yields N-1 autonomous turns — `proceed` advances the conversation
 *     *to* N turns from where it starts, not "N more". Documented, not a bug.
 *   - The `onTurn` callback fires N-1 times (it misses the first turn, which is
 *     pre-loaded at reset with currentTurn=0 and consumed without a `newTurn`).
 *     A minor observability nuance — the conversation still gets all N turns.
 *
 * (This guard exists because every other proceed test asserts `>=`/"some", so a
 * real turn-count change would slip through. Earlier I MISREAD the onTurn count
 * as the turn count and wrongly reported a framework off-by-one — sim.calls is
 * the honest measure and it equals N.)
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";

class MockAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "agent reply" };
  }
}
class CountingUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  calls = 0;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.calls += 1;
    return `user turn ${this.calls}`;
  }
}

describe("proceed(N) drives exactly N turns (#39)", () => {
  it.each([1, 2, 4])(
    "bare proceed(%i) drives the user simulator exactly that many times",
    async (n) => {
      const sim = new CountingUserSim();
      const exec = new ScenarioExecution(
        {
          name: `proceed-exactly-${n}`,
          description: "exact-turn-count guard",
          agents: [new MockAgent(), sim],
        },
        [
          async (_state, executor) => {
            await executor.proceed(n);
          },
        ],
        "test-batch-id",
      );

      await exec.execute();

      expect(sim.calls).toBe(n);
    },
  );
});
