/**
 * Lowercase adapter factories — the documented PRD §9 / EDR §0 idiom.
 *
 * The PRD's TypeScript surface (§9) uses `scenario.pipecatAgent({ ... })`,
 * `scenario.openAIRealtimeAgent({ ... })`, etc. — thin factory functions that
 * mirror the Python `scenario.PipecatAgent(...)` constructors. Each is a
 * one-line `new XAgentAdapter(params)` wrapper over the corresponding class
 * (the class forms stay public for `extends`/`instanceof`).
 *
 * These ride on the same per-run contract as everything else in `voice/` —
 * they construct an adapter; the executor drives its lifecycle. No behavior
 * lives here beyond construction.
 */

import {
  PipecatAgentAdapter,
  type PipecatAgentAdapterInit,
} from "./adapters/pipecat";
import {
  OpenAIRealtimeAgentAdapter,
  type OpenAIRealtimeAgentAdapterInit,
} from "./adapters/openai-realtime";
import {
  GeminiLiveAgentAdapter,
  type GeminiLiveAgentAdapterInit,
} from "./adapters/gemini-live";
import {
  TwilioAgentAdapter,
  type TwilioAgentAdapterOptions,
} from "./adapters/twilio";
import {
  ElevenLabsAgentAdapter,
  type ElevenLabsAgentAdapterOptions,
  ComposableVoiceAgent,
  type ComposableVoiceAgentOptions,
} from "./adapters";

/**
 * Pipecat agent (WebSocket Twilio-style or WebRTC). PRD §4.1 / §5.1.
 *
 * @example scenario.pipecatAgent({ url: "ws://localhost:8765/ws" })
 */
export function pipecatAgent(
  init: PipecatAgentAdapterInit = {},
): PipecatAgentAdapter {
  return new PipecatAgentAdapter(init);
}

/**
 * OpenAI Realtime agent (the model IS the agent). PRD §4.1 / §5.6.
 *
 * @example scenario.openAIRealtimeAgent({ model: "gpt-realtime-mini", voice: "alloy" })
 */
export function openAIRealtimeAgent(
  init: OpenAIRealtimeAgentAdapterInit = {},
): OpenAIRealtimeAgentAdapter {
  return new OpenAIRealtimeAgentAdapter(init);
}

/**
 * Gemini Live native-audio agent (the model IS the agent). PRD §4.1 / §5.6.
 *
 * @example scenario.geminiLiveAgent({ model: "gemini-2.5-flash-native-audio-latest" })
 */
export function geminiLiveAgent(
  init: GeminiLiveAgentAdapterInit = {},
): GeminiLiveAgentAdapter {
  return new GeminiLiveAgentAdapter(init);
}

/**
 * ElevenLabs Conversational AI agent (hosted transport). PRD §4.1 / §5.4.
 *
 * @example scenario.elevenLabsAgent({ agentId: "abc123", apiKey: "..." })
 */
export function elevenLabsAgent(
  options: ElevenLabsAgentAdapterOptions,
): ElevenLabsAgentAdapter {
  return new ElevenLabsAgentAdapter(options);
}

/**
 * Twilio phone agent. PRD §4.1 / §5.3.
 *
 * @example scenario.twilioAgent({ accountSid: "...", authToken: "...", phoneNumber: "+14155551234" })
 */
export function twilioAgent(
  options: TwilioAgentAdapterOptions,
): TwilioAgentAdapter {
  return new TwilioAgentAdapter(options);
}

/**
 * Bring-your-own-protocol composable voice agent (STT + LLM + TTS). PRD §5.7.
 *
 * @example scenario.composableAgent({ stt, llm: "openai/gpt-4.1-mini", tts: "openai/nova" })
 */
export function composableAgent(
  options: ComposableVoiceAgentOptions,
): ComposableVoiceAgent {
  return new ComposableVoiceAgent(options);
}
