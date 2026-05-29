/**
 * proceed() interruption injection (issue #372 Tier C, Gap #8 / PRD §4.4-§4.2).
 *
 * Verifies the executor consumes an active InterruptionConfig during
 * proceed() and fires a barge-in per the configured probability/strategy —
 * both via `voiceProceed({ interruptions })` and via a user simulator's
 * `interruptProbability`. RNG is injected (`interruptRng`) for determinism;
 * no network, no real keys.
 */

import { describe, it, expect, vi } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";
import { InterruptionConfig } from "../../voice/interruption";

class MockAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "agent says something" };
  }
}

/** A user simulator that records each generated turn's content. */
class RecordingUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  readonly turns: string[] = [];
  constructor(private readonly probability = 0) {
    super();
  }
  get interruptProbability(): number {
    return this.probability;
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    const text = `user turn ${this.turns.length}`;
    this.turns.push(text);
    return text;
  }
}

describe("proceed() voice interruptions (Gap #8)", () => {
  it("fires a random_phrase interruption when shouldInterrupt() hits", async () => {
    const sim = new RecordingUserSim();
    const exec = new ScenarioExecution(
      {
        name: "proceed interruptions / always",
        description: "rng forces an interrupt every turn",
        agents: [new MockAgent(), sim],
      },
      [
        // voiceProceed records the config on the executor state.
        (_state, executor) => {
          (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
            new InterruptionConfig({ probability: 1, strategy: "random_phrase" });
        },
        (_state, executor) => executor.proceed(1),
      ],
      "test-batch-id",
    );
    // rng = 0 → always < probability=1 → always interrupt; and selects phrase[0].
    exec.interruptOverrides = { rng: () => 0 };

    await exec.execute();

    // At least one of the user-sim turns is the canned interruption phrase.
    const phrase0 = new InterruptionConfig({ strategy: "random_phrase" })
      .pickRandomPhrase(() => 0);
    const msgs = exec.messages;
    const hasPhrase = msgs.some(
      (m) => m.role === "user" && m.content === phrase0,
    );
    expect(hasPhrase).toBe(true);

    // A user_interrupt event is on the... (text-only run has no recording, so
    // skip timeline assertion here; covered by the voice integration path).
  });

  it("does NOT interrupt when shouldInterrupt() declines", async () => {
    const sim = new RecordingUserSim();
    const exec = new ScenarioExecution(
      {
        name: "proceed interruptions / never",
        description: "rng declines every interrupt",
        agents: [new MockAgent(), sim],
      },
      [
        (_state, executor) => {
          (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
            new InterruptionConfig({ probability: 0.3, strategy: "random_phrase" });
        },
        (_state, executor) => executor.proceed(1),
      ],
      "test-batch-id",
    );
    // rng = 0.99 → never < 0.3 → never interrupt.
    exec.interruptOverrides = { rng: () => 0.99 };

    await exec.execute();

    const phrases = new InterruptionConfig({ strategy: "random_phrase" }).phrases;
    const injected = exec.messages.some(
      (m) => m.role === "user" && phrases.includes(m.content as string),
    );
    expect(injected).toBe(false);
  });

  it("a user simulator's interruptProbability drives interruptions without voiceProceed", async () => {
    const sim = new RecordingUserSim(1); // always interrupt
    const exec = new ScenarioExecution(
      {
        name: "proceed interruptions / per-sim probability",
        description: "interruptProbability=1 forces barge-ins",
        agents: [new MockAgent(), sim],
      },
      [async (_state, executor) => { await executor.proceed(1); }],
      "test-batch-id",
    );
    exec.interruptOverrides = { rng: () => 0 };

    await exec.execute();

    // The per-sim probability (no voiceProceed) resolves to a default
    // random_phrase config, so a canned interruption phrase is injected as a
    // user message (random_phrase injects content directly, not via the sim).
    const phrases = new InterruptionConfig().phrases;
    const injected = exec.messages.some(
      (m) => m.role === "user" && phrases.includes(m.content as string),
    );
    expect(injected).toBe(true);
  });

  it("samples the configured delayRange before barging in (m2)", async () => {
    const sim = new RecordingUserSim();
    // A short, deterministic delay range so the injected wait stays sub-ms.
    const config = new InterruptionConfig({
      probability: 1,
      strategy: "random_phrase",
      delayRange: [0, 0],
    });
    const sampleSpy = vi.spyOn(config, "sampleDelay");
    const exec = new ScenarioExecution(
      {
        name: "proceed interruptions / delayRange consumed",
        description: "delayRange must be sampled before injection",
        agents: [new MockAgent(), sim],
      },
      [
        (_state, executor) => {
          (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
            config;
        },
        (_state, executor) => executor.proceed(1),
      ],
      "test-batch-id",
    );
    exec.interruptOverrides = { rng: () => 0 };

    await exec.execute();

    // The delayRange surface is now consumed by the proceed-loop injector —
    // sampleDelay() fires with the executor's seeded RNG (was dead before m2).
    expect(sampleSpy).toHaveBeenCalled();
    expect(sampleSpy).toHaveBeenCalledWith(expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// Substep unit tests (issue #578)
// ---------------------------------------------------------------------------

type ExecInternals = {
  pendingRolesOnTurn: AgentRole[];
  pendingAgentsOnTurn: Set<unknown>;
  pendingAgentTask: { promise: Promise<void>; done: boolean; error: unknown | null } | null;
  resolveNextAgentForInlineBarge(): { idx: number; agent: unknown } | null;
  consumePendingRolesUntilAgent(agent: unknown): void;
  dispatchAgentBackground(idx: number): { promise: Promise<void>; done: boolean; error: unknown | null };
  voiceInterruptions?: InterruptionConfig;
};

function makeExecWithAgents(agents: [MockAgent, RecordingUserSim]): ScenarioExecution & { _i: ExecInternals } {
  const exec = new ScenarioExecution(
    {
      name: "substep test",
      description: "substep unit tests",
      agents,
    },
    [async (_state, executor) => { await executor.proceed(1); }],
    "test-batch-id",
  ) as unknown as ScenarioExecution & { _i: ExecInternals };
  // expose internals via a typed alias
  exec._i = exec as unknown as ExecInternals;
  return exec;
}

describe("resolveNextAgentForInlineBarge (substep 1)", () => {
  it("returns the AGENT idx+adapter when AGENT is the first runnable role", async () => {
    const agent = new MockAgent();
    const sim = new RecordingUserSim();
    const exec = makeExecWithAgents([agent, sim]);
    // Seed pendingRolesOnTurn so AGENT is the next runnable role.
    exec._i.pendingRolesOnTurn = [AgentRole.AGENT, AgentRole.JUDGE];
    exec._i.pendingAgentsOnTurn = new Set([agent]);
    const result = exec._i.resolveNextAgentForInlineBarge();
    expect(result).not.toBeNull();
    expect(result?.agent).toBe(agent);
  });

  it("returns null when AGENT is not the next runnable role (USER first)", async () => {
    const agent = new MockAgent();
    const sim = new RecordingUserSim();
    const exec = makeExecWithAgents([agent, sim]);
    exec._i.pendingRolesOnTurn = [AgentRole.USER, AgentRole.AGENT];
    exec._i.pendingAgentsOnTurn = new Set([sim, agent]);
    const result = exec._i.resolveNextAgentForInlineBarge();
    // USER comes first and is runnable → nextRole = USER → bail
    expect(result).toBeNull();
  });

  it("returns null when pendingRolesOnTurn is empty", async () => {
    const agent = new MockAgent();
    const sim = new RecordingUserSim();
    const exec = makeExecWithAgents([agent, sim]);
    exec._i.pendingRolesOnTurn = [];
    exec._i.pendingAgentsOnTurn = new Set([agent]);
    const result = exec._i.resolveNextAgentForInlineBarge();
    expect(result).toBeNull();
  });
});

describe("consumePendingRolesUntilAgent (substep 2)", () => {
  it("removes AGENT from pendingAgentsOnTurn and pops roles up to+including AGENT", async () => {
    const agent = new MockAgent();
    const sim = new RecordingUserSim();
    const exec = makeExecWithAgents([agent, sim]);
    exec._i.pendingRolesOnTurn = [AgentRole.USER, AgentRole.AGENT, AgentRole.JUDGE];
    exec._i.pendingAgentsOnTurn = new Set([sim, agent]);

    exec._i.consumePendingRolesUntilAgent(agent);

    // AGENT removed from the adapter set.
    expect(exec._i.pendingAgentsOnTurn.has(agent)).toBe(false);
    // Roles up to and including AGENT consumed; JUDGE remains.
    expect(exec._i.pendingRolesOnTurn).toEqual([AgentRole.JUDGE]);
  });

  it("handles the case where AGENT is the only role", async () => {
    const agent = new MockAgent();
    const sim = new RecordingUserSim();
    const exec = makeExecWithAgents([agent, sim]);
    exec._i.pendingRolesOnTurn = [AgentRole.AGENT];
    exec._i.pendingAgentsOnTurn = new Set([agent]);

    exec._i.consumePendingRolesUntilAgent(agent);

    expect(exec._i.pendingAgentsOnTurn.has(agent)).toBe(false);
    expect(exec._i.pendingRolesOnTurn).toEqual([]);
  });
});

describe("dispatchAgentBackground (substep 3)", () => {
  it("sets pendingAgentTask and marks entry.done=true after the call resolves", async () => {
    const agent = new MockAgent();
    const sim = new RecordingUserSim();
    const exec = makeExecWithAgents([agent, sim]);
    // Give exec enough state for callAgent to run without crashing.
    exec._i.pendingRolesOnTurn = [AgentRole.AGENT];
    exec._i.pendingAgentsOnTurn = new Set([agent]);

    // callAgent at index 0 is the MockAgent; it needs a minimal messages array.
    // Run the execute cycle so the internal state initialises (threadId etc).
    // Instead: call dispatchAgentBackground directly — the task may reject, but
    // the structural postconditions (pendingAgentTask set, done=false initially)
    // are testable synchronously.
    const entry = exec._i.dispatchAgentBackground(0);
    expect(exec._i.pendingAgentTask).toBe(entry);
    expect(entry.done).toBe(false);
    // Wait for the promise (may reject in the test context; that's fine —
    // the test only cares that done flips to true).
    await entry.promise.catch(() => undefined);
    expect(entry.done).toBe(true);
  });
});
