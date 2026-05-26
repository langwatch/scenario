/**
 * Adapter factory bindings — PRD §9 TypeScript idiom (issue #372 Tier C).
 *
 * The PRD's TS surface (§9) documents `scenario.pipecatAgent({ ... })` etc.
 * These factories are thin `new XAgentAdapter(params)` wrappers. This test
 * proves both access paths work — the `voice` namespace AND the top-level
 * `scenario` object — and that each factory returns the right adapter class
 * (so `instanceof` / the class form stays interchangeable with the factory).
 */

import type { LanguageModel } from "ai";
import { describe, it, expect } from "vitest";

import scenario, { voice } from "../../index";
import { PipecatAgentAdapter } from "../adapters/pipecat";
import { OpenAIRealtimeAgentAdapter } from "../adapters/openai-realtime";
import { GeminiLiveAgentAdapter } from "../adapters/gemini-live";
import { TwilioAgentAdapter } from "../adapters/twilio";
import { ElevenLabsAgentAdapter, ComposableVoiceAgent } from "../adapters";
import { VoiceAgentAdapter } from "../adapter";
import type { AudioChunk } from "../audio-chunk";
import type { STTProvider } from "../stt";

const stubStt: STTProvider = {
  async transcribe(_audio: AudioChunk): Promise<string> {
    return "stub transcript";
  },
};

// Minimal ai-sdk LanguageModel stub — never invoked (factory test only).
const stubLlm = {
  specificationVersion: "v3" as const,
  provider: "fake",
  modelId: "fake-model",
  supportedUrls: {},
  doGenerate: async () => ({
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    content: [{ type: "text", text: "ok" }],
    warnings: [],
  }),
  doStream: async () => {
    throw new Error("doStream not implemented in stub");
  },
} as unknown as LanguageModel;

describe("voice adapter factories (PRD §9)", () => {
  it("scenario.pipecatAgent({...}) returns a PipecatAgentAdapter", () => {
    const a = scenario.pipecatAgent({ url: "ws://localhost:8765/ws" });
    expect(a).toBeInstanceOf(PipecatAgentAdapter);
    expect(a).toBeInstanceOf(VoiceAgentAdapter);
    // Same factory reachable via the voice namespace.
    expect(voice.pipecatAgent).toBe(scenario.pipecatAgent);
  });

  it("scenario.openAIRealtimeAgent({...}) returns an OpenAIRealtimeAgentAdapter", () => {
    const a = scenario.openAIRealtimeAgent({
      model: "gpt-realtime-mini",
      apiKey: "sk-test",
    });
    expect(a).toBeInstanceOf(OpenAIRealtimeAgentAdapter);
  });

  it("scenario.geminiLiveAgent({...}) returns a GeminiLiveAgentAdapter", () => {
    const a = scenario.geminiLiveAgent({
      model: "gemini-2.5-flash-native-audio-latest",
      apiKey: "test",
    });
    expect(a).toBeInstanceOf(GeminiLiveAgentAdapter);
  });

  it("scenario.elevenLabsAgent({...}) returns an ElevenLabsAgentAdapter", () => {
    const a = scenario.elevenLabsAgent({ agentId: "abc123", apiKey: "k" });
    expect(a).toBeInstanceOf(ElevenLabsAgentAdapter);
  });

  it("scenario.twilioAgent({...}) returns a TwilioAgentAdapter", () => {
    const a = scenario.twilioAgent({
      accountSid: "AC0",
      authToken: "tok",
      phoneNumber: "+14155551234",
    });
    expect(a).toBeInstanceOf(TwilioAgentAdapter);
  });

  it("scenario.composableAgent({...}) returns a ComposableVoiceAgent", () => {
    const a = scenario.composableAgent({
      stt: stubStt,
      llm: stubLlm,
      tts: "openai/nova",
    });
    expect(a).toBeInstanceOf(ComposableVoiceAgent);
    expect(a).toBeInstanceOf(VoiceAgentAdapter);
  });

  it("all six factories are exported from the voice namespace", () => {
    for (const name of [
      "pipecatAgent",
      "openAIRealtimeAgent",
      "geminiLiveAgent",
      "elevenLabsAgent",
      "twilioAgent",
      "composableAgent",
    ] as const) {
      expect(typeof voice[name]).toBe("function");
    }
  });
});
