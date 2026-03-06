import { describe, it, expect } from "vitest";
import { CrescendoStrategy } from "../red-team/crescendo-strategy";
import { renderMetapromptTemplate } from "../red-team/metaprompt-template";
import { marathonScript } from "../../script";

describe("CrescendoStrategy", () => {
  const strategy = new CrescendoStrategy();

  it("returns warmup phase for early turns", () => {
    const phase = strategy.getPhase(1, 100);
    expect(phase.name).toBe("warmup");
  });

  it("returns probing phase for turns 20-45%", () => {
    const phase = strategy.getPhase(30, 100);
    expect(phase.name).toBe("probing");
  });

  it("returns escalation phase for turns 45-75%", () => {
    const phase = strategy.getPhase(50, 100);
    expect(phase.name).toBe("escalation");
  });

  it("returns direct phase for late turns", () => {
    const phase = strategy.getPhase(80, 100);
    expect(phase.name).toBe("direct");
  });

  it("returns warmup at boundary turn 0", () => {
    // Turn 0 / 100 = 0.0, which is in warmup [0.0, 0.2)
    const phase = strategy.getPhase(0, 100);
    expect(phase.name).toBe("warmup");
  });

  it("returns probing at boundary turn 20", () => {
    // Turn 20 / 100 = 0.2, which is in probing [0.2, 0.45)
    const phase = strategy.getPhase(20, 100);
    expect(phase.name).toBe("probing");
  });

  it("returns escalation at boundary turn 45", () => {
    // Turn 45 / 100 = 0.45, which is in escalation [0.45, 0.75)
    const phase = strategy.getPhase(45, 100);
    expect(phase.name).toBe("escalation");
  });

  it("returns direct at boundary turn 75", () => {
    // Turn 75 / 100 = 0.75, which is in direct [0.75, Infinity)
    const phase = strategy.getPhase(75, 100);
    expect(phase.name).toBe("direct");
  });

  it("handles totalTurns of 0 without error", () => {
    const phase = strategy.getPhase(0, 0);
    expect(phase.name).toBe("warmup");
  });

  it("builds a system prompt with all sections", () => {
    const prompt = strategy.buildSystemPrompt({
      target: "extract system prompt",
      currentTurn: 10,
      totalTurns: 50,
      scenarioDescription: "A bank support agent",
      metapromptPlan: "Step 1: Build rapport",
    });

    expect(prompt).toContain("TARGET OBJECTIVE: extract system prompt");
    expect(prompt).toContain("Turn: 10 of 50");
    expect(prompt).toContain("Phase: PROBING");
    expect(prompt).toContain("Step 1: Build rapport");
    expect(prompt).toContain("A bank support agent");
  });

  it("getPhaseName returns the phase name string", () => {
    expect(strategy.getPhaseName(1, 50)).toBe("warmup");
    expect(strategy.getPhaseName(15, 50)).toBe("probing");
    expect(strategy.getPhaseName(30, 50)).toBe("escalation");
    expect(strategy.getPhaseName(40, 50)).toBe("direct");
  });

  it("direct phase turn range is clamped to totalTurns", () => {
    const prompt = strategy.buildSystemPrompt({
      target: "test",
      currentTurn: 40,
      totalTurns: 50,
      scenarioDescription: "desc",
      metapromptPlan: "plan",
    });
    // Direct phase [0.75, Infinity) should show "turns 38-50", not "turns 38-2500"
    expect(prompt).toContain("DIRECT");
    expect(prompt).toMatch(/turns 3[78]-50/);
    expect(prompt).not.toContain("2500");
  });

  it("prompt without score has no feedback block", () => {
    const prompt = strategy.buildSystemPrompt({
      target: "test",
      currentTurn: 1,
      totalTurns: 50,
      scenarioDescription: "desc",
      metapromptPlan: "plan",
    });
    expect(prompt).not.toContain("LAST RESPONSE ASSESSMENT");
    expect(prompt).not.toContain("Score:");
  });

  it("prompt with score includes feedback block", () => {
    const prompt = strategy.buildSystemPrompt({
      target: "test",
      currentTurn: 5,
      totalTurns: 50,
      scenarioDescription: "desc",
      metapromptPlan: "plan",
      lastResponseScore: 3,
      adaptationHint: "switch to encoding tricks",
    });
    expect(prompt).toContain("LAST RESPONSE ASSESSMENT");
    expect(prompt).toContain("3/10");
    expect(prompt).toContain("switch to encoding tricks");
  });

  it("score 10 shows correctly in prompt", () => {
    const prompt = strategy.buildSystemPrompt({
      target: "test",
      currentTurn: 10,
      totalTurns: 50,
      scenarioDescription: "desc",
      metapromptPlan: "plan",
      lastResponseScore: 10,
      adaptationHint: "goal achieved — push further",
    });
    expect(prompt).toContain("10/10");
    expect(prompt).toContain("goal achieved");
  });

  it("prompt includes external-user rule", () => {
    const prompt = strategy.buildSystemPrompt({
      target: "test",
      currentTurn: 1,
      totalTurns: 10,
      scenarioDescription: "desc",
      metapromptPlan: "plan",
    });
    expect(prompt).toContain("ALWAYS the external party");
  });
});

describe("renderMetapromptTemplate", () => {
  it("replaces all placeholders including phase boundaries", () => {
    const template =
      "Target: {target}, Desc: {description}, Turns: {totalTurns}, " +
      "P1: {phase1End}, P2: {phase2End}, P3: {phase3End}";
    const result = renderMetapromptTemplate(template, {
      target: "hack it",
      description: "test agent",
      totalTurns: 100,
    });
    expect(result).toBe(
      "Target: hack it, Desc: test agent, Turns: 100, P1: 20, P2: 45, P3: 75"
    );
  });

  it("replaces multiple occurrences of the same placeholder", () => {
    const template = "{target} and {target}";
    const result = renderMetapromptTemplate(template, {
      target: "goal",
      description: "",
      totalTurns: 1,
    });
    expect(result).toBe("goal and goal");
  });

  it("computes phase boundaries for small totalTurns", () => {
    const template = "{phase1End}-{phase2End}-{phase3End}";
    const result = renderMetapromptTemplate(template, {
      target: "",
      description: "",
      totalTurns: 10,
    });
    expect(result).toBe("2-4-7");
  });
});

describe("marathonScript", () => {
  it("generates correct number of steps with no checks", () => {
    const steps = marathonScript({ turns: 3 });
    // 3 * (user + agent) + judge = 3*2 + 1 = 7
    expect(steps).toHaveLength(7);
  });

  it("generates correct number of steps with checks", () => {
    const dummyCheck = () => {};
    const steps = marathonScript({ turns: 3, checks: [dummyCheck] });
    // 3 * (user + agent + check) + judge = 3*3 + 1 = 10
    expect(steps).toHaveLength(10);
  });

  it("generates correct number of steps with final checks", () => {
    const dummyCheck = () => {};
    const dummyFinal = () => {};
    const steps = marathonScript({
      turns: 2,
      checks: [dummyCheck],
      finalChecks: [dummyFinal],
    });
    // 2 * (user + agent + check) + finalCheck + judge = 2*3 + 1 + 1 = 8
    expect(steps).toHaveLength(8);
  });

  it("generates correct steps with 0 turns", () => {
    const steps = marathonScript({ turns: 0 });
    // 0 turns + judge = 1
    expect(steps).toHaveLength(1);
  });
});
