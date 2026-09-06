/**
 * Pins the one behavioural difference between the two agent lookups that #210
 * consolidated into `findNextAgentForRole`.
 *
 * The automatic loop requires the role to still be pending on the turn; a
 * scripted call does not. Before this test nothing observed that: flipping the
 * scripted path to the automatic path's semantics left all 1079 other JS tests
 * green, while silently adding a `newTurn()` and so changing turn counting.
 *
 * Reaching the case takes two scripted steps in one turn. `agent()` runs
 * `consumeUntilRole(AGENT)`, which drains USER off `pendingRolesOnTurn` while
 * leaving the user simulator on `pendingAgentsOnTurn`. The following `user()`
 * then asks for a role the turn no longer lists, but whose agent is still
 * available.
 *
 * Python's `_next_agent_for_role` always applies the guard, so the value
 * asserted here is a TypeScript-only behaviour. It is pinned rather than
 * aligned: aligning it is a turn-count change and belongs to whoever decides
 * the parity question on #210, with this test failing to mark the decision.
 */

import { describe, expect, it } from "vitest";

import {
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  AgentRole,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";

class MockAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  calls = 0;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.calls += 1;
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

async function runAgentThenUser() {
  const sim = new CountingUserSim();
  const agent = new MockAgent();
  const turnsSeen: number[] = [];

  const exec = new ScenarioExecution(
    {
      name: "script-call-role-pending",
      description: "scripted call for a role the turn no longer lists",
      agents: [agent, sim],
    },
    [
      async (state, executor) => {
        await executor.agent();
        turnsSeen.push(state.currentTurn);
        await executor.user();
        turnsSeen.push(state.currentTurn);
      },
    ],
    "test-batch-id",
  );

  await exec.execute();

  return { sim, agent, turnsSeen };
}

describe("scripted call for a role already consumed from the turn (#210)", () => {
  describe("when agent() has drained USER off the pending roles and user() follows in the same turn", () => {
    it("calls the user simulator", async () => {
      const { sim } = await runAgentThenUser();

      expect(sim.calls).toBe(1);
    });

    it("does not open a new turn to do it", async () => {
      const { turnsSeen } = await runAgentThenUser();

      // 0 after agent(), still 0 after user(). Requiring the role to be
      // pending would make the first lookup miss, take the newTurn() retry
      // branch, and land on 1 here.
      expect(turnsSeen).toEqual([0, 0]);
    });
  });
});
