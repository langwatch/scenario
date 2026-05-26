/**
 * Tier C interruption-surface unit tests (issue #372, PRD §4.4 / §4.2):
 *   - interrupt({ after: <seconds> }) — TIME-based trigger.
 *   - user("...", { voiceStyle }) / user("...", { audioEffects }) — per-step
 *     overrides that apply to ONLY that turn and revert afterward.
 *
 * Plain it() blocks (not feature-bound) — these are implementation-level
 * guarantees beyond the spec scenarios already bound in voice-steps.test.ts.
 */

import { describe, it, expect } from "vitest";

import { interrupt } from "../voice-steps";
import { user } from "../index";
import type { ScenarioExecutionLike } from "../../domain";

interface TraceEntry {
  kind: string;
  arg?: unknown;
  at: number;
}

/** Minimal executor stub recording the order + timing of user/agent calls. */
function makeExecutor(opts: { agents?: unknown[] } = {}) {
  const trace: TraceEntry[] = [];
  const start = Date.now();
  const executor = {
    agents: opts.agents ?? [],
    async agent() {
      trace.push({ kind: "agent", at: Date.now() - start });
    },
    async user(content?: unknown) {
      trace.push({ kind: "user", arg: content, at: Date.now() - start });
    },
    async message() {},
    async judge() {
      return null;
    },
    async proceed() {
      return null;
    },
    async succeed() {
      return {} as never;
    },
    async fail() {
      return {} as never;
    },
  } as unknown as ScenarioExecutionLike;
  return { executor, trace };
}

describe("interrupt({ after }) — TIME-based trigger", () => {
  it("waits ~after seconds, then fires the user turn after the agent", async () => {
    const { executor, trace } = makeExecutor();
    const step = interrupt({
      after: 0.15,
      content: "wait, that's wrong",
      waitForSpeechTimeout: 0.05, // no speaking event → resolves at this cap
    });

    const t0 = Date.now();
    await step({} as never, executor);
    const elapsed = Date.now() - t0;

    // The agent fires first (background), the user interruption after the wait.
    const agentIdx = trace.findIndex((t) => t.kind === "agent");
    const userIdx = trace.findIndex((t) => t.kind === "user");
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(agentIdx);
    expect((trace[userIdx] as TraceEntry).arg).toBe("wait, that's wrong");
    // The `after` sleep elapsed (>= ~150ms, minus scheduler slop).
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });
});

describe("user(content, { voiceStyle | audioEffects }) — per-step override", () => {
  /** A fake user simulator exposing setOneShotOverride (duck-typed). */
  class FakeOverridableSim {
    role = "User";
    installed: Array<{
      voiceStyle?: string;
      audioEffects?: unknown;
    }> = [];
    restored = 0;
    setOneShotOverride(opts: {
      voiceStyle?: string;
      audioEffects?: Array<(b: Uint8Array) => Uint8Array>;
    }): () => void {
      this.installed.push({
        voiceStyle: opts.voiceStyle,
        audioEffects: opts.audioEffects,
      });
      return () => {
        this.restored += 1;
      };
    }
  }

  it("installs a voiceStyle override around the user turn, then restores", async () => {
    const sim = new FakeOverridableSim();
    const { executor } = makeExecutor({ agents: [sim] });

    const step = user("I'm really upset!", { voiceStyle: "angry" });
    await step({} as never, executor);

    expect(sim.installed).toHaveLength(1);
    expect(sim.installed[0].voiceStyle).toBe("angry");
    expect(sim.restored).toBe(1); // override reverted after the turn
  });

  it("installs an audioEffects override around the user turn", async () => {
    const sim = new FakeOverridableSim();
    const { executor } = makeExecutor({ agents: [sim] });
    const lowVolume = (b: Uint8Array) => b;

    const step = user("Hello?", { audioEffects: [lowVolume] });
    await step({} as never, executor);

    expect(sim.installed).toHaveLength(1);
    expect(sim.installed[0].audioEffects).toEqual([lowVolume]);
    expect(sim.restored).toBe(1);
  });

  it("plain user(content) installs no override", async () => {
    const sim = new FakeOverridableSim();
    const { executor } = makeExecutor({ agents: [sim] });

    const step = user("just text");
    await step({} as never, executor);

    expect(sim.installed).toHaveLength(0);
    expect(sim.restored).toBe(0);
  });

  it("override is a no-op when no overridable user simulator is present", async () => {
    const { executor, trace } = makeExecutor({ agents: [] });
    const step = user("hi", { voiceStyle: "angry" });
    await step({} as never, executor);
    // The user turn still ran.
    expect(trace.some((t) => t.kind === "user" && t.arg === "hi")).toBe(true);
  });
});
