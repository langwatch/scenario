/**
 * Issue #1033: a run fails fast when the agent under test returns no content.
 * Helper unit tests plus executor-level tests. Fakes only, no LLM calls.
 */

import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";

import { isEmptyAgentTurn } from "../../agents/utils";
import {
  AgentRole,
  AgentAdapter,
  JudgeAgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { VoiceAgentAdapter } from "../../voice/adapter";
import { AdapterCapabilities } from "../../voice/capabilities";
import type { AudioChunk } from "../../voice/audio-chunk";
import { ScenarioExecution } from "../scenario-execution";

const msg = (m: unknown) => m as ModelMessage;

describe("isEmptyAgentTurn()", () => {
  describe("given messages with no content", () => {
    it.each([
      ["no messages", []],
      ["empty string", [{ role: "assistant", content: "" }]],
      ["whitespace", [{ role: "assistant", content: " \n\t " }]],
      ["undefined content", [{ role: "assistant", content: undefined }]],
      ["null content", [{ role: "assistant", content: null }]],
      ["empty content array", [{ role: "assistant", content: [] }]],
      [
        "blank text parts",
        [
          {
            role: "assistant",
            content: [
              { type: "text", text: "" },
              { type: "text", text: "  " },
            ],
          },
        ],
      ],
      [
        "several empty messages",
        [
          { role: "assistant", content: "" },
          { role: "assistant", content: [] },
        ],
      ],
    ])("returns true for %s", (_name, messages) => {
      expect(isEmptyAgentTurn(messages.map(msg))).toBe(true);
    });
  });

  describe("given messages with content", () => {
    it.each([
      ["text content", [{ role: "assistant", content: "hi" }]],
      ["a dash reply", [{ role: "assistant", content: "-" }]],
      [
        "a text part with text",
        [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
      ],
      [
        "an assistant tool-call part with no text",
        [
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} },
            ],
          },
        ],
      ],
      [
        "a tool message with tool-result parts",
        [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "lookup",
                output: { type: "text", value: "" },
              },
            ],
          },
        ],
      ],
      [
        "a file part (audio)",
        [
          {
            role: "assistant",
            content: [
              { type: "file", mediaType: "audio/wav", data: "AAAA" },
            ],
          },
        ],
      ],
      [
        "an image part",
        [
          {
            role: "assistant",
            content: [{ type: "image", image: "AAAA", mediaType: "image/png" }],
          },
        ],
      ],
      [
        "a reasoning part",
        [{ role: "assistant", content: [{ type: "reasoning", text: "thinking" }] }],
      ],
      [
        "one empty message next to one with text",
        [
          { role: "assistant", content: "" },
          { role: "assistant", content: "hi" },
        ],
      ],
    ])("returns false for %s", (_name, messages) => {
      expect(isEmptyAgentTurn(messages.map(msg))).toBe(false);
    });
  });
});

class Calls {
  user = 0;
  judge = 0;
}

class ReplyAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  calls = 0;
  constructor(private replies: unknown[]) {
    super();
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply as AgentReturnTypes;
  }
}

class UserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  constructor(private counts: Calls, private reply = "hi") {
    super();
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.counts.user += 1;
    return this.reply;
  }
}

class Judge extends JudgeAgentAdapter {
  role = AgentRole.JUDGE;
  criteria: string[] = [];
  constructor(private counts: Calls) {
    super();
  }
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    // Like a real judge in the proceed loop: no verdict unless one is requested.
    if (!input.judgmentRequest) return null as unknown as AgentReturnTypes;
    this.counts.judge += 1;
    return {
      success: true,
      messages: [],
      reasoning: "ok",
      metCriteria: [],
      unmetCriteria: [],
    } as unknown as AgentReturnTypes;
  }
}

/** Voice adapter with a stubbed transport whose turn yields no messages. */
class SilentVoiceAgent extends VoiceAgentAdapter {
  role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({ nativeVad: true });
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_chunk: AudioChunk): Promise<void> {}
  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    throw new Error("not used");
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "";
  }
}

function run(agent: ReplyAgent, counts: Calls, userReply = "hi") {
  const execution = new ScenarioExecution(
    {
      name: "empty agent reply",
      description: "agent under test returns an empty reply",
      agents: [agent, new UserSim(counts, userReply), new Judge(counts)],
    },
    [
      async (_state, executor) => {
        await executor.proceed(3);
      },
      async (_state, executor) => {
        await executor.judge();
      },
    ],
    "test-batch-id",
  );
  return execution.execute();
}

describe("given the agent under test returns no content", () => {
  describe.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["an empty array", []],
    ["a message with undefined content", { role: "assistant", content: undefined }],
    ["a message with empty content", { role: "assistant", content: "" }],
  ])("when it returns %s", (_name, reply) => {
    it("rejects with the no-content error for turn 1", async () => {
      await expect(run(new ReplyAgent([reply]), new Calls())).rejects.toThrow(
        /agent returned no content on turn 1/,
      );
    });
  });

  describe("when it returns an empty string", () => {
    // One reply shape is enough: the check is shape-independent past the helper.
    it("calls the user simulator once and never the judge", async () => {
      const counts = new Calls();
      await run(new ReplyAgent([""]), counts).catch(() => undefined);
      expect([counts.user, counts.judge]).toEqual([1, 0]);
    });
  });

  describe("when it returns an empty reply on turn 2", () => {
    it("reports turn 2 in the error", async () => {
      await expect(
        run(new ReplyAgent(["hello", ""]), new Calls()),
      ).rejects.toThrow(/agent returned no content on turn 2/);
    });
  });

  describe("when it returns null", () => {
    it("rejects with the no-content error for turn 1", async () => {
      await expect(run(new ReplyAgent([null]), new Calls())).rejects.toThrow(
        /agent returned no content on turn 1/,
      );
    });
  });

  describe("when it returns undefined", () => {
    it("rejects with the no-content error for turn 1", async () => {
      await expect(run(new ReplyAgent([undefined]), new Calls())).rejects.toThrow(
        /agent returned no content on turn 1/,
      );
    });
  });
});

describe("given the agent under test returns short or tool-only content", () => {
  it("continues to the judge on a dash reply", async () => {
    const counts = new Calls();
    await run(new ReplyAgent(["-"]), counts);
    expect(counts.judge).toBe(1);
  });

  it("does not raise on an assistant tool-call message with no text", async () => {
    const reply = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} }],
    };
    const counts = new Calls();
    await expect(run(new ReplyAgent([reply]), counts)).resolves.toBeDefined();
    expect(counts.judge).toBe(1);
  });

  it("does not raise on a tool message with tool-result parts", async () => {
    const reply = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "text", value: "" },
          },
        ],
      },
    ];
    const counts = new Calls();
    await expect(run(new ReplyAgent([reply]), counts)).resolves.toBeDefined();
    expect(counts.judge).toBe(1);
  });

  it("does not raise on an audio file part", async () => {
    const reply = {
      role: "assistant",
      content: [{ type: "file", mediaType: "audio/wav", data: "AAAA" }],
    };
    await expect(run(new ReplyAgent([reply]), new Calls())).resolves.toBeDefined();
  });
});

describe("given the user simulator returns an empty string", () => {
  it("completes the run and reaches the judge", async () => {
    // The check is for the agent under test only; an empty user turn keeps its existing handling.
    const counts = new Calls();
    await expect(run(new ReplyAgent(["hello"]), counts, "")).resolves.toBeDefined();
    expect(counts.judge).toBe(1);
  });
});

describe("given an empty agent turn is rejected", () => {
  it("does not add the empty turn to state messages", async () => {
    let captured: { messages: ModelMessage[] } | undefined;
    const counts = new Calls();
    const execution = new ScenarioExecution(
      {
        name: "empty not stored",
        description: "empty agent turn stays out of state",
        agents: [new ReplyAgent([""]), new UserSim(counts), new Judge(counts)],
      },
      [
        async (state) => {
          captured = state;
        },
        async (_state, executor) => {
          await executor.proceed(2);
        },
      ],
      "test-batch-id",
    );
    await execution.execute().catch(() => undefined);
    expect(captured!.messages.filter((m) => m.role === "assistant")).toEqual([]);
  });
});

describe("given checks that do not apply", () => {
  it("does not flag a ScenarioResult return", async () => {
    const reply = { success: true, messages: [], reasoning: "ok", metCriteria: [], unmetCriteria: [] };
    await expect(run(new ReplyAgent([reply]), new Calls())).resolves.toBeDefined();
  });

  it("does not flag a scripted agent step with blank content", async () => {
    const counts = new Calls();
    const execution = new ScenarioExecution(
      {
        name: "scripted agent",
        description: "scripted agent step supplies the message",
        agents: [new ReplyAgent(["x"]), new UserSim(counts), new Judge(counts)],
      },
      [
        async (_s, executor) => {
          await executor.message({ role: "user", content: "hi" });
        },
        async (_s, executor) => {
          await executor.message({ role: "assistant", content: "" });
        },
        async (_s, executor) => {
          await executor.judge();
        },
      ],
      "test-batch-id",
    );
    await expect(execution.execute()).resolves.toBeDefined();
    expect(counts.judge).toBe(1);
  });

  it("does not flag a voice adapter that returns nothing", async () => {
    const counts = new Calls();
    const execution = new ScenarioExecution(
      {
        name: "silent voice agent",
        description: "voice adapter streams audio and returns no messages",
        agents: [new SilentVoiceAgent(), new UserSim(counts), new Judge(counts)],
      },
      [
        async (_s, executor) => {
          await executor.message({ role: "user", content: "hi" });
        },
        async (_s, executor) => {
          await executor.agent();
        },
        async (_s, executor) => {
          await executor.judge();
        },
      ],
      "test-batch-id",
    );
    await expect(execution.execute()).resolves.toBeDefined();
    expect(counts.judge).toBe(1);
  });
});
