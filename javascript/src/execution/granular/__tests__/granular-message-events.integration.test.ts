// Ref: specs/granular-message-events.feature
import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  captureEventPosts,
  ofType,
  runScenario,
  streamingModel,
  type AgentInput,
  type AgentReturnTypes,
} from "./harness";
import { AgentAdapter, AgentRole } from "../../../domain";
import { scenarioEventSchema, ScenarioEventType } from "../../../events/schema";
import { agent, succeed, user } from "../../../script";

vi.mock("../../../tracing/setup", () => ({ ensureTracingInitialized: vi.fn() }));
vi.mock("../../../config/get-project-config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue(null),
}));

const MESSAGE_EVENT_TYPES = new Set<string>([
  ScenarioEventType.TEXT_MESSAGE_START,
  ScenarioEventType.TEXT_MESSAGE_END,
  ScenarioEventType.TEXT_MESSAGE_CONTENT,
  ScenarioEventType.TOOL_CALL_START,
  ScenarioEventType.TOOL_CALL_ARGS,
  ScenarioEventType.TOOL_CALL_END,
]);

class FixedAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  constructor(private readonly reply: (input: AgentInput) => Promise<AgentReturnTypes> | AgentReturnTypes) {
    super();
  }
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    return this.reply(input);
  }
}

/** An agent under test built the documented way: streamText piped to input.stream. */
class StreamingAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  constructor(
    private readonly makeResult: () => {
      fullStream: AsyncIterable<{ type: string }>;
      response: PromiseLike<{ messages: ModelMessage[] }>;
    }
  ) {
    super();
  }
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    const result = this.makeResult();
    if (input.stream) await input.stream.pipe(result.fullStream);
    return (await result.response).messages;
  }
}

function conversation(turns: number) {
  return [
    ...Array.from({ length: turns }, () => [user("a question that takes some words to ask"), agent()]).flat(),
    succeed(),
  ];
}

const longAnswer = "an answer of a realistic length, ".repeat(10);

describe("Granular message events", () => {
  beforeEach(() => {
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", "");
    vi.stubEnv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "true");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("a run that does not opt in reports snapshots only", async () => {
    const posts = captureEventPosts();
    await runScenario({ agent: new FixedAgent(() => longAnswer), script: conversation(2) });

    expect(ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT)).toHaveLength(4);
    expect(posts.delivered.some((p) => MESSAGE_EVENT_TYPES.has(p.event.type))).toBe(false);
  });

  it("an opted-in run reports each message once, without snapshots, in bytes that grow linearly", async () => {
    const bytesOfMessageEvents = (posts: ReturnType<typeof captureEventPosts>) =>
      posts.delivered
        .filter((p) => p.event.type === ScenarioEventType.MESSAGE_SNAPSHOT || MESSAGE_EVENT_TYPES.has(p.event.type))
        .reduce((total, p) => total + p.bytes, 0);

    const measure = async (turns: number, sendGranularEvents: boolean) => {
      const posts = captureEventPosts();
      await runScenario({
        agent: new FixedAgent(() => longAnswer),
        script: conversation(turns),
        sendGranularEvents,
      });
      vi.unstubAllGlobals();
      return { posts, bytes: bytesOfMessageEvents(posts) };
    };

    const granular10 = await measure(10, true);
    const granular20 = await measure(20, true);
    const snapshot10 = await measure(10, false);
    const snapshot20 = await measure(20, false);

    const starts = ofType(granular20.posts.delivered, ScenarioEventType.TEXT_MESSAGE_START);
    const ends = ofType(granular20.posts.delivered, ScenarioEventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(40);
    expect(ends.map((e) => e.messageId)).toEqual(starts.map((e) => e.messageId));
    expect(ends.map((e) => e.messageIndex)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(ofType(granular20.posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT)).toHaveLength(0);

    // Twice the conversation: granular bytes double, snapshot bytes about quadruple.
    expect(granular20.bytes / granular10.bytes).toBeLessThan(2.1);
    expect(snapshot20.bytes / snapshot10.bytes).toBeGreaterThan(3.5);
    expect(granular20.bytes).toBeLessThan(snapshot20.bytes / 5);
    for (const p of granular20.posts.delivered) expect(scenarioEventSchema.safeParse(p.event).success).toBe(true);
  });

  it("a tool message with several results keeps one row per result", async () => {
    const posts = captureEventPosts();
    const replies: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_a", toolName: "lookup", input: { q: "a" } },
          { type: "tool-call", toolCallId: "call_b", toolName: "lookup", input: { q: "b" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_a", toolName: "lookup", output: { type: "text", value: "A" } },
          { type: "tool-result", toolCallId: "call_b", toolName: "lookup", output: { type: "text", value: "B" } },
        ],
      },
      { role: "assistant", content: "A and B" },
    ];
    await runScenario({
      agent: new FixedAgent(() => replies),
      script: [user("look up a and b"), agent(), succeed()],
      sendGranularEvents: true,
    });

    const ends = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_END);
    expect(ends.map((e) => [e.role, e.messageIndex])).toEqual([
      ["user", 0],
      ["assistant", 1],
      ["tool", 2],
      ["tool", 3],
      ["assistant", 4],
    ]);
    const toolMessageId = ends[2]!.messageId.replace(/-0$/, "");
    expect(ends[2]!.messageId).toBe(`${toolMessageId}-0`);
    expect(ends[3]!.messageId).toBe(`${toolMessageId}-1`);
    expect(ends[1]!.message?.toolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } },
      { id: "call_b", type: "function", function: { name: "lookup", arguments: '{"q":"b"}' } },
    ]);
    expect(ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START).map((e) => e.messageIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(ofType(posts.delivered, ScenarioEventType.TOOL_CALL_START)).toHaveLength(0);
    expect(ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT)).toHaveLength(0);
  });

  it("structured audio reaches the platform on the end event, the bytes only in the message", async () => {
    const posts = captureEventPosts();
    const audio = Buffer.alloc(3000, 7).toString("base64");
    await runScenario({
      agent: new FixedAgent(() => "heard you"),
      script: [
        user({
          role: "user",
          content: [
            { type: "text", text: "the transcript" },
            { type: "file", mediaType: "audio/wav", data: audio },
          ],
        }),
        agent(),
        succeed(),
      ],
      sendGranularEvents: true,
    });

    const userEnd = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_END)[0]!;
    expect(userEnd.content).toBe("the transcript");
    expect(userEnd.message?.content).toEqual([
      { type: "text", text: "the transcript" },
      { type: "input_audio", input_audio: { data: audio, format: "wav", mimeType: "audio/wav" } },
    ]);
    expect(JSON.stringify(userEnd).split(audio)).toHaveLength(2);
  });

  it("a streaming agent reports text as it arrives and ends it from the returned message", async () => {
    const posts = captureEventPosts();
    const deltas = Array.from({ length: 30 }, (_, i) => `word${i} `);
    await runScenario({
      agent: new StreamingAgent(() =>
        streamText({ model: streamingModel([{ text: deltas }]), prompt: "hi" })
      ),
      script: [user("hello"), agent(), succeed()],
      sendGranularEvents: true,
    });

    const events = posts.delivered.map((p) => p.event).filter((e) => MESSAGE_EVENT_TYPES.has(e.type));
    const agentStart = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START)[1]!;
    const contents = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_CONTENT);
    const agentEnd = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_END)[1]!;

    expect(agentStart).toMatchObject({ role: "assistant", messageIndex: 1 });
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.length).toBeLessThan(deltas.length);
    expect(contents.every((c) => c.messageId === agentStart.messageId)).toBe(true);
    expect(deltas.join("").startsWith(contents.map((c) => c.delta).join(""))).toBe(true);
    expect(agentEnd).toMatchObject({ messageId: agentStart.messageId, content: deltas.join(""), messageIndex: 1 });
    expect(events.indexOf(agentStart)).toBeLessThan(events.indexOf(contents[0]!));
    expect(events.indexOf(contents.at(-1)!)).toBeLessThan(events.indexOf(agentEnd));
    expect(ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT)).toHaveLength(0);
  });

  it("a streaming agent reports tool-call progress and a snapshot repairs the step the tool rows moved", async () => {
    const posts = captureEventPosts();
    const model = streamingModel([
      { toolCall: { id: "call_1", name: "weather", args: ['{"city":', '"Paris"}'] } },
      { text: ["Sunny ", "in Paris"] },
    ]);
    await runScenario({
      agent: new StreamingAgent(() =>
        streamText({
          model,
          prompt: "weather?",
          stopWhen: stepCountIs(2),
          tools: {
            weather: tool({
              inputSchema: z.object({ city: z.string() }),
              execute: async ({ city }) => `sunny in ${city}`,
            }),
          },
        })
      ),
      script: [user("weather in paris?"), agent(), succeed()],
      sendGranularEvents: true,
    });

    const starts = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START);
    const toolStart = ofType(posts.delivered, ScenarioEventType.TOOL_CALL_START)[0]!;
    expect(toolStart).toMatchObject({ toolCallId: "call_1", toolCallName: "weather", parentMessageId: starts[1]!.messageId });
    expect(ofType(posts.delivered, ScenarioEventType.TOOL_CALL_ARGS).map((e) => e.delta).join("")).toBe('{"city":"Paris"}');
    expect(ofType(posts.delivered, ScenarioEventType.TOOL_CALL_END)).toEqual([expect.objectContaining({ toolCallId: "call_1" })]);

    // Step two started at index 2, but the tool result row landed there.
    expect(starts[2]).toMatchObject({ role: "assistant", messageIndex: 2 });
    const ends = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_END);
    expect(ends.map((e) => [e.role, e.messageIndex])).toEqual([
      ["user", 0],
      ["assistant", 1],
      ["tool", 2],
      ["assistant", 3],
    ]);
    expect(ends[1]!.messageId).toBe(starts[1]!.messageId);
    expect(ends[3]!.messageId).toBe(starts[2]!.messageId);

    const snapshots = ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.messages.map((m) => m.id)).toEqual(ends.map((e) => e.messageId));
    expect(snapshots[0]!.timestamp).toBeGreaterThanOrEqual(ends[3]!.timestamp);
  });

  it("a stream that fails is repaired by a snapshot posted before the finished event", async () => {
    const posts = captureEventPosts();
    const failing = new FixedAgent(async (input) => {
      input.stream?.write({ type: "text-delta", id: "t", text: "half an ans" });
      throw new Error("provider connection reset");
    });

    await expect(
      runScenario({ agent: failing, script: [user("hello"), agent(), succeed()], sendGranularEvents: true })
    ).rejects.toThrow("provider connection reset");

    const types = posts.delivered.map((p) => p.event.type);
    const started = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START)[1]!;
    const snapshot = ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT)[0]!;
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user"]);
    expect(snapshot.messages.some((m) => m.id === started.messageId)).toBe(false);
    expect(types.indexOf(ScenarioEventType.MESSAGE_SNAPSHOT)).toBeLessThan(types.indexOf(ScenarioEventType.RUN_FINISHED));
    // The pending delta is dropped with the call, never posted after it failed.
    expect(ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_CONTENT)).toHaveLength(0);
  });

  it("posts nothing for a part written after the call settled", async () => {
    const posts = captureEventPosts();
    let calls = 0;
    const lateWriter = new FixedAgent(async (input) => {
      calls += 1;
      if (calls === 1) {
        const stream = input.stream;
        setTimeout(() => stream?.write({ type: "text-delta", id: "t", text: "too late" }), 0);
        return "first answer";
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "second answer";
    });
    await runScenario({
      agent: lateWriter,
      script: [user("one"), agent(), user("two"), agent(), succeed()],
      sendGranularEvents: true,
    });

    expect(ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_CONTENT)).toHaveLength(0);
    expect(ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START)).toHaveLength(4);
  });

  it("a rollback is repaired by a snapshot of the remaining messages", async () => {
    const posts = captureEventPosts();
    let calls = 0;
    const rollingBack = new FixedAgent((input) => {
      calls += 1;
      if (calls === 2) input.scenarioState.rollbackMessagesTo(1);
      return `answer ${calls}`;
    });
    await runScenario({
      agent: rollingBack,
      script: [user("one"), agent(), user("two"), agent(), succeed()],
      sendGranularEvents: true,
    });

    // The repair waits for the rolling-back call to finish, so one snapshot
    // covers both the removal and the answer that call returned.
    const snapshots = ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.messages.map((m) => m.content)).toEqual(["one", "answer 2"]);
    const lastEnd = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_END).at(-1)!;
    expect(lastEnd).toMatchObject({ content: "answer 2", messageIndex: 1 });
    expect(snapshots[0]!.timestamp).toBeGreaterThanOrEqual(lastEnd.timestamp);
  });

  it("retries a failed start or end in order and tries a failed delta once", async () => {
    const posts = captureEventPosts({ failFirstAttemptOf: (e) => MESSAGE_EVENT_TYPES.has(e.type) });
    await runScenario({
      agent: new StreamingAgent(() =>
        streamText({ model: streamingModel([{ text: ["partial ", "answer"] }]), prompt: "hi" })
      ),
      script: [user("hello"), agent(), succeed()],
      sendGranularEvents: true,
    });

    const delivered = posts.delivered.map((p) => p.event.type);
    expect(delivered.filter((t) => t === ScenarioEventType.TEXT_MESSAGE_CONTENT)).toHaveLength(0);
    const attemptedContents = posts.attempts.filter((p) => p.event.type === ScenarioEventType.TEXT_MESSAGE_CONTENT);
    expect(attemptedContents.length).toBeGreaterThan(0);
    expect(new Set(attemptedContents.map((p) => JSON.stringify(p.event))).size).toBe(attemptedContents.length);
    expect(delivered.filter((t) => t !== ScenarioEventType.TEXT_MESSAGE_CONTENT)).toEqual([
      ScenarioEventType.RUN_STARTED,
      ScenarioEventType.TEXT_MESSAGE_START,
      ScenarioEventType.TEXT_MESSAGE_END,
      ScenarioEventType.TEXT_MESSAGE_START,
      ScenarioEventType.TEXT_MESSAGE_END,
      ScenarioEventType.RUN_FINISHED,
    ]);
    const timestamps = posts.delivered.map((p) => p.event.timestamp);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it("a connected agent function pipes the stream it is given and returns its final messages", async () => {
    const posts = captureEventPosts();
    const connected = Object.assign(
      async (call: { messages: ModelMessage[]; stream?: AgentInput["stream"] }) => {
        const result = streamText({ model: streamingModel([{ text: ["connected ", "reply"] }]), messages: call.messages });
        if (call.stream) await call.stream.pipe(result.fullStream);
        return (await result.response).messages;
      },
      { environment: "test" }
    );
    Object.defineProperty(connected, "name", { value: "connected-agent" });

    await runScenario({ agent: connected, script: [user("hello"), agent(), succeed()], sendGranularEvents: true });

    const start = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START)[1]!;
    expect(ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_CONTENT).map((e) => e.messageId)).toContain(start.messageId);
    expect(ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_END)[1]).toMatchObject({
      messageId: start.messageId,
      content: "connected reply",
    });
  });
});
