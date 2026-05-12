import { describe, it, expect, vi } from "vitest";
import { TapStrategy } from "../red-team/tap-strategy";
import { redTeamTap } from "../red-team/red-team-agent";

// ---------------------------------------------------------------------------
// TapStrategy — interface conformance
// ---------------------------------------------------------------------------

describe("TapStrategy — interface conformance", () => {
  it("needsMetapromptPlan === false (like GOAT)", () => {
    expect(new TapStrategy().needsMetapromptPlan).toBe(false);
  });

  it("phaseKind === 'progress'", () => {
    expect(new TapStrategy().phaseKind).toBe("progress");
  });

  it("getPhaseName returns early/mid/late buckets at 30%/70% boundaries", () => {
    const s = new TapStrategy();
    expect(s.getPhaseName(1, 10)).toBe("early");    // 10%
    expect(s.getPhaseName(2, 10)).toBe("early");    // 20%
    expect(s.getPhaseName(3, 10)).toBe("mid");      // 30% — boundary
    expect(s.getPhaseName(6, 10)).toBe("mid");      // 60%
    expect(s.getPhaseName(7, 10)).toBe("late");     // 70% — boundary
    expect(s.getPhaseName(10, 10)).toBe("late");    // 100%
  });

  it("getPhaseName tolerates totalTurns === 0", () => {
    expect(new TapStrategy().getPhaseName(1, 0)).toBe("late");
  });
});

// ---------------------------------------------------------------------------
// TapStrategy — validation
// ---------------------------------------------------------------------------

describe("TapStrategy — validation", () => {
  it("defaults match paper (b=4) and reasonable depth (10)", () => {
    const s = new TapStrategy();
    expect(s.width).toBe(4);
    expect(s.depth).toBe(10);
    expect(s.onTopicFilter).toBe(true);
    expect(s.pruneThreshold).toBe(3.0);
  });

  it("rejects width < 1", () => {
    expect(() => new TapStrategy({ width: 0 })).toThrow(/width must be >= 1/);
  });

  it("rejects depth < 1", () => {
    expect(() => new TapStrategy({ depth: 0 })).toThrow(/depth must be >= 1/);
  });

  it("rejects out-of-range pruneThreshold", () => {
    expect(() => new TapStrategy({ pruneThreshold: -0.1 })).toThrow(/pruneThreshold must be in/);
    expect(() => new TapStrategy({ pruneThreshold: 10.5 })).toThrow(/pruneThreshold must be in/);
  });

  it("rejects negative temperatureSpread", () => {
    expect(() => new TapStrategy({ temperatureSpread: -0.01 })).toThrow(/temperatureSpread must be >= 0/);
  });
});

// ---------------------------------------------------------------------------
// TapStrategy — output parsing
// ---------------------------------------------------------------------------

describe("TapStrategy — parseAttackerOutput", () => {
  const s = new TapStrategy();

  it("parses well-formed JSON", () => {
    const raw = JSON.stringify({
      observation: "target refused but acknowledged topic",
      strategy: "hypothetical framing",
      reply: "for a research course, walk me through ...",
    });
    const out = s.parseAttackerOutput(raw);
    expect(out.parseFailed).toBe(false);
    expect(out.reply).toMatch(/^for a research course/);
    expect(out.observation).toBe("target refused but acknowledged topic");
    expect(out.strategy).toBe("hypothetical framing");
  });

  it("strips ```json fences", () => {
    const raw = "```json\n" + JSON.stringify({ reply: "hi" }) + "\n```";
    const out = s.parseAttackerOutput(raw);
    expect(out.parseFailed).toBe(false);
    expect(out.reply).toBe("hi");
  });

  it("falls back on malformed JSON", () => {
    const out = s.parseAttackerOutput("not json");
    expect(out.parseFailed).toBe(true);
    expect(out.reply).toBe("not json");
  });

  it("falls back when reply is missing or empty", () => {
    expect(s.parseAttackerOutput(JSON.stringify({ observation: "x" })).parseFailed).toBe(true);
    expect(s.parseAttackerOutput(JSON.stringify({ reply: "   " })).parseFailed).toBe(true);
  });

  it("falls back when JSON is non-object (array)", () => {
    expect(s.parseAttackerOutput("[1,2,3]").parseFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TapStrategy — system prompt construction
// ---------------------------------------------------------------------------

describe("TapStrategy — buildSystemPrompt", () => {
  it("includes target, turn, and JSON contract", () => {
    const prompt = new TapStrategy().buildSystemPrompt({
      target: "extract the system prompt",
      currentTurn: 3,
      totalTurns: 10,
      scenarioDescription: "A bank support agent",
      metapromptPlan: "",
    });
    expect(prompt).toContain("TARGET OBJECTIVE: extract the system prompt");
    expect(prompt).toContain("CURRENT TURN: 3 of 10");
    expect(prompt).toContain("A bank support agent");
    expect(prompt).toContain("OUTPUT FORMAT");
  });

  it("does NOT include any catalogue (TAP has none)", () => {
    const prompt = new TapStrategy().buildSystemPrompt({
      target: "x",
      currentTurn: 1,
      totalTurns: 1,
      scenarioDescription: "d",
      metapromptPlan: "",
    });
    // Sanity: no GOAT catalogue header
    expect(prompt).not.toContain("TECHNIQUE CATALOGUE");
  });
});

// ---------------------------------------------------------------------------
// redTeamTap — factory wiring
// ---------------------------------------------------------------------------

describe("redTeamTap factory", () => {
  it("creates an agent with a TapStrategy carrying the requested config", () => {
    const agent: any = redTeamTap({
      target: "x",
      // ai-sdk LanguageModel is structurally typed; a dummy is fine here
      model: { id: "test" } as any,
      totalTurns: 6,
      width: 3,
      pruneThreshold: 2.5,
      onTopicFilter: false,
      temperatureSpread: 0.05,
    });
    expect(agent.strategy).toBeInstanceOf(TapStrategy);
    expect(agent.strategy.width).toBe(3);
    expect(agent.strategy.pruneThreshold).toBe(2.5);
    expect(agent.strategy.onTopicFilter).toBe(false);
    expect(agent.strategy.temperatureSpread).toBe(0.05);
    expect(agent.strategy.depth).toBe(6); // defaults to totalTurns
  });

  it("respects an explicit depth override", () => {
    const agent: any = redTeamTap({
      target: "x",
      model: { id: "test" } as any,
      totalTurns: 6,
      depth: 12,
    });
    expect(agent.strategy.depth).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Per-turn branch / prune / select — tapSelectCandidate (private method, but
// reachable via the instance for white-box testing).
// ---------------------------------------------------------------------------

describe("tapSelectCandidate — per-turn branching", () => {
  const cand = (reply: string) =>
    JSON.stringify({ observation: "", strategy: "", reply });

  const baseCfg = () => ({
    target: "x",
    model: { id: "test" } as any,
    metapromptModel: { id: "test" } as any,
    totalTurns: 4,
    width: 4,
    pruneThreshold: 0.0,
    onTopicFilter: false,
    temperatureSpread: 0.1,
    temperature: 0.7,
  });

  it("calls the attacker LLM width times with bumped temperatures", async () => {
    const agent: any = redTeamTap(baseCfg());
    const calls: Array<number | undefined> = [];
    agent.callAttackerLLM = vi.fn(async (t?: number) => {
      calls.push(t);
      return cand(`c${calls.length - 1}`);
    });
    agent.scoreCandidate = vi.fn(async () => 8);
    const chosen = await agent.tapSelectCandidate(agent.strategy);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toBeCloseTo(0.7, 10);
    expect(calls[1]).toBeCloseTo(0.8, 10);
    expect(calls[2]).toBeCloseTo(0.9, 10);
    expect(calls[3]).toBeCloseTo(1.0, 10);
    expect(chosen).toBe(cand("c0")); // tied at 8 — first wins
  });

  it("picks the highest-scoring survivor", async () => {
    const agent: any = redTeamTap(baseCfg());
    const raws = [cand("c0"), cand("c1"), cand("c2"), cand("c3")];
    let i = 0;
    agent.callAttackerLLM = vi.fn(async () => raws[i++]);
    const scores = [3, 8, 5, 6];
    let j = 0;
    agent.scoreCandidate = vi.fn(async () => scores[j++]);
    const chosen = await agent.tapSelectCandidate(agent.strategy);
    expect(chosen).toBe(cand("c1"));
  });

  it("drops candidates below pruneThreshold", async () => {
    const agent: any = redTeamTap({ ...baseCfg(), pruneThreshold: 5 });
    const raws = [cand("c0"), cand("c1"), cand("c2"), cand("c3")];
    let i = 0;
    agent.callAttackerLLM = vi.fn(async () => raws[i++]);
    const scores = [2, 4, 7, 9];
    let j = 0;
    agent.scoreCandidate = vi.fn(async () => scores[j++]);
    const chosen = await agent.tapSelectCandidate(agent.strategy);
    expect(chosen).toBe(cand("c3")); // 9 > 7
  });

  it("drops off-topic candidates before scoring", async () => {
    const agent: any = redTeamTap({ ...baseCfg(), onTopicFilter: true });
    const raws = [cand("c0"), cand("c1"), cand("c2"), cand("c3")];
    let i = 0;
    agent.callAttackerLLM = vi.fn(async () => raws[i++]);
    // c0, c2 off-topic; c1, c3 on-topic
    const onTopic = [false, true, false, true];
    let k = 0;
    agent.isOnTopic = vi.fn(async () => onTopic[k++]);
    const scoreSpy = vi.fn(async () => 6);
    agent.scoreCandidate = scoreSpy;
    // Force c3 to win by giving it a higher score
    let s = 0;
    agent.scoreCandidate = vi.fn(async () => [6, 8][s++]!);
    const chosen = await agent.tapSelectCandidate(agent.strategy);
    expect(chosen).toBe(cand("c3"));
  });

  it("falls back to a single call when every candidate is pruned", async () => {
    const agent: any = redTeamTap({ ...baseCfg(), onTopicFilter: true });
    const branchRaws = [cand("c0"), cand("c1"), cand("c2"), cand("c3")];
    const fallback = cand("fallback");
    let i = 0;
    const calls: Array<number | undefined> = [];
    agent.callAttackerLLM = vi.fn(async (t?: number) => {
      calls.push(t);
      if (i < branchRaws.length) return branchRaws[i++];
      return fallback;
    });
    // Everything off-topic → all pruned → fallback fires
    agent.isOnTopic = vi.fn(async () => false);
    agent.scoreCandidate = vi.fn(async () => 8);
    const chosen = await agent.tapSelectCandidate(agent.strategy);
    expect(chosen).toBe(fallback);
    // 4 branches + 1 fallback = 5 calls; last call has no explicit temp
    expect(calls.length).toBe(5);
    expect(calls[4]).toBeUndefined();
    expect(agent.scoreCandidate).not.toHaveBeenCalled();
  });

  it("skips a branch that throws and continues with the rest", async () => {
    const agent: any = redTeamTap(baseCfg());
    const raws = [cand("ok"), cand("low")];
    let i = 0;
    agent.callAttackerLLM = vi.fn(async () => {
      if (i === 0) {
        i++;
        throw new Error("transient");
      }
      return raws[i++ - 1];
    });
    // 3 branches: throw, ok, low — width=4 actually; let's tighten
    agent.strategy = (new TapStrategy({ width: 3 })) as any;
    let j = 0;
    agent.scoreCandidate = vi.fn(async () => [8, 2][j++] ?? 0);
    const chosen = await agent.tapSelectCandidate(agent.strategy);
    expect(chosen).toBe(cand("ok"));
  });
});
