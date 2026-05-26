/**
 * proceed() interruption injection (issue #372 Tier C, Gap #8 / PRD §4.4-§4.2).
 *
 * Verifies the executor consumes an active InterruptionConfig during
 * proceed() and fires a barge-in per the configured probability/strategy —
 * both via `voiceProceed({ interruptions })` and via a user simulator's
 * `interruptProbability`. RNG is injected (`_interruptRng`) for determinism;
 * no network, no real keys.
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
import { InterruptionConfig } from "../../voice/interruption";
import { userSimulatorAgent } from "../../agents/user-simulator-agent";

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
    (exec as unknown as { _interruptRng: () => number })._interruptRng = () => 0;

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
    (exec as unknown as { _interruptRng: () => number })._interruptRng = () =>
      0.99;

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
    (exec as unknown as { _interruptRng: () => number })._interruptRng = () => 0;

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

  it("userSimulatorAgent({ interruptProbability }) exposes the value", () => {
    const sim = userSimulatorAgent({ interruptProbability: 0.4 });
    expect(
      (sim as unknown as { interruptProbability: number }).interruptProbability,
    ).toBe(0.4);
  });
});
