// Ref: specs/granular-message-events.feature
// How the real AI SDK `streamText` reports a failed or aborted provider
// stream, and that piping it fails the agent call instead of passing a
// partial answer off as complete.
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureEventPosts, ofType, runScenario } from "./harness";
import { AgentAdapter, AgentRole, type AgentInput, type AgentReturnTypes } from "../../../domain";
import { ScenarioEventType, ScenarioRunStatus, type ScenarioEvent } from "../../../events/schema";
import { agent, succeed, user } from "../../../script";
import { AgentCallStream } from "../agent-call-stream";

vi.mock("../../../tracing/setup", () => ({ ensureTracingInitialized: vi.fn() }));
vi.mock("../../../config/get-project-config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue(null),
}));

const base = { batchRunId: "b", scenarioId: "s", scenarioRunId: "r", scenarioSetId: "default" };

function openStream(emitted: ScenarioEvent[]) {
  return new AgentCallStream({
    role: "assistant",
    base,
    emit: (event) => emitted.push(event),
    timestamp: () => 1,
    startMessage: () => undefined,
    onClose: () => undefined,
  });
}

function textThen(tail: LanguageModelV3StreamPart[], chunkDelayInMs?: number) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV3StreamPart>({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "half an " },
          ...tail,
        ],
        chunkDelayInMs,
      }),
    }),
  });
}

async function partTypes(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  for await (const part of stream) types.push(part.type);
  return types;
}

describe("AI SDK stream failures", () => {
  it("yields a provider error mid-stream as an error part, and pipe rejects with that error", async () => {
    const overloaded = new Error("provider overloaded");
    const model = () => textThen([{ type: "error", error: overloaded }]);

    const types = await partTypes(streamText({ model: model(), prompt: "hi" }).fullStream);
    expect(types).toContain("error");

    const emitted: ScenarioEvent[] = [];
    await expect(
      openStream(emitted).pipe(streamText({ model: model(), prompt: "hi" }).fullStream)
    ).rejects.toBe(overloaded);
  });

  it("yields a provider call that fails before streaming as an error part, and pipe rejects", async () => {
    const refused = new Error("connection refused");
    const model = () =>
      new MockLanguageModelV3({
        doStream: async () => {
          throw refused;
        },
      });

    const types = await partTypes(streamText({ model: model(), prompt: "hi" }).fullStream);
    expect(types).toContain("error");

    await expect(
      openStream([]).pipe(streamText({ model: model(), prompt: "hi" }).fullStream)
    ).rejects.toBe(refused);
  });

  it("yields an abort as an abort part, and pipe rejects with an AbortError", async () => {
    const run = () => {
      const controller = new AbortController();
      const result = streamText({
        model: textThen([{ type: "text-delta", id: "t", delta: "answer" }], 30),
        prompt: "hi",
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 45);
      return result;
    };

    const types = await partTypes(run().fullStream);
    expect(types).toContain("abort");

    await expect(openStream([]).pipe(run().fullStream)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("wraps an error part that is not an Error without putting its value in the message", async () => {
    const parts = (async function* () {
      yield { type: "error", error: { apiKey: "sk-secret", body: "payload" } };
    })();

    const failure = await openStream([]).pipe(parts).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("sk-secret");
    expect((failure as Error).cause).toEqual({ apiKey: "sk-secret", body: "payload" });
  });

  it("does not treat a tool error part as a stream failure", async () => {
    const parts = (async function* () {
      yield { type: "tool-error", toolCallId: "c", toolName: "t", error: new Error("tool broke") };
      yield { type: "text-delta", id: "t", text: "recovered" };
    })();

    await expect(openStream([]).pipe(parts)).resolves.toBeUndefined();
  });
});

describe("A failed provider stream in a run", () => {
  beforeEach(() => {
    vi.stubEnv("SCENARIO_SEND_GRANULAR_EVENTS", "");
    vi.stubEnv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "true");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fails the run through the error path and repairs the started message", async () => {
    const posts = captureEventPosts();
    class StreamingAgent extends AgentAdapter {
      role = AgentRole.AGENT;
      async call(input: AgentInput): Promise<AgentReturnTypes> {
        const result = streamText({
          model: textThen([{ type: "error", error: new Error("provider overloaded") }]),
          prompt: "hi",
        });
        if (input.stream) await input.stream.pipe(result.fullStream);
        return (await result.response).messages;
      }
    }

    await expect(
      runScenario({ agent: new StreamingAgent(), script: [user("hello"), agent(), succeed()], sendGranularEvents: true })
    ).rejects.toThrow("provider overloaded");

    const started = ofType(posts.delivered, ScenarioEventType.TEXT_MESSAGE_START);
    const snapshot = ofType(posts.delivered, ScenarioEventType.MESSAGE_SNAPSHOT)[0]!;
    expect(started).toHaveLength(2);
    expect(snapshot.messages.map((m) => m.id)).toEqual([started[0]!.messageId]);
    expect(ofType(posts.delivered, ScenarioEventType.RUN_FINISHED)).toEqual([
      expect.objectContaining({ status: ScenarioRunStatus.ERROR }),
    ]);
  });
});
