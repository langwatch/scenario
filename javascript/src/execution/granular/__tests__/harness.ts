/**
 * Runs whole scenarios through `run()` with the real event bus and reporter,
 * answering the LangWatch POSTs in place of the network, and records exactly
 * what was posted.
 */
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";

import {
  AgentRole,
  UserSimulatorAgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  type ScenarioConfig,
} from "../../../domain";
import type { ScenarioEvent } from "../../../events/schema";
import { run } from "../../../runner/run";

export interface PostedEvent {
  event: ScenarioEvent;
  bytes: number;
}

export interface FetchCapture {
  /** Every POST that reached the endpoint and was answered with success. */
  delivered: PostedEvent[];
  /** Every POST attempt, failed ones included. */
  attempts: PostedEvent[];
}

/**
 * Stubs `fetch` for the scenario-events endpoint. With `failFirstAttemptOf`,
 * the first attempt of each event whose type matches answers 503.
 */
export function captureEventPosts({
  failFirstAttemptOf,
}: { failFirstAttemptOf?: (event: ScenarioEvent) => boolean } = {}): FetchCapture {
  const capture: FetchCapture = { delivered: [], attempts: [] };
  const seen = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const event = JSON.parse(init.body) as ScenarioEvent;
      const posted = { event, bytes: Buffer.byteLength(init.body) };
      capture.attempts.push(posted);
      if (failFirstAttemptOf?.(event) && !seen.has(init.body)) {
        seen.add(init.body);
        return new Response("unavailable", { status: 503 });
      }
      capture.delivered.push(posted);
      return new Response("{}", { status: 201 });
    })
  );
  return capture;
}

/** A user simulator that says what it is told, turn by turn. */
export class ScriptedUser extends UserSimulatorAgentAdapter {
  name = "ScriptedUser";
  role = AgentRole.USER;
  async call(): Promise<AgentReturnTypes> {
    return "next question";
  }
}

export async function runScenario({
  agent,
  script,
  sendGranularEvents,
}: {
  agent: ScenarioConfig["agents"][number];
  script: NonNullable<ScenarioConfig["script"]>;
  sendGranularEvents?: boolean;
}) {
  return run(
    {
      name: "granular events",
      description: "reports messages",
      agents: [agent, new ScriptedUser()],
      script,
    },
    {
      langwatch: { endpoint: "http://langwatch.test", apiKey: "test-key" },
      batchRunId: "scenariobatch_test",
      ...(sendGranularEvents === undefined ? {} : { sendGranularEvents }),
    }
  );
}

export function ofType<T extends ScenarioEvent["type"]>(
  posted: readonly PostedEvent[],
  type: T
): Extract<ScenarioEvent, { type: T }>[] {
  return posted
    .map((p) => p.event)
    .filter((e): e is Extract<ScenarioEvent, { type: T }> => e.type === type);
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** One model step: text in chunks, or one tool call with its arguments in chunks. */
export type ModelStep =
  | { text: string[] }
  | { toolCall: { id: string; name: string; args: string[] } };

/**
 * A provider stand-in that streams one {@link ModelStep} per model call, so
 * `streamText` runs for real over it.
 */
export function streamingModel(steps: ModelStep[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[call++];
      if (!step) throw new Error("the model was called more often than scripted");
      return { stream: simulateReadableStream({ chunks: streamPartsOf(step) }) };
    },
  });
}

function streamPartsOf(step: ModelStep): LanguageModelV3StreamPart[] {
  if ("text" in step) {
    return [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      ...step.text.map((delta): LanguageModelV3StreamPart => ({ type: "text-delta", id: "t", delta })),
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];
  }
  const { id, name, args } = step.toolCall;
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName: name },
    ...args.map((delta): LanguageModelV3StreamPart => ({ type: "tool-input-delta", id, delta })),
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName: name, input: args.join("") },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ];
}

export type { AgentInput, AgentReturnTypes, ModelMessage };
