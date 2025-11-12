/**
 * Audio User Simulator for Realtime Agent Testing
 *
 * This class simulates a user in voice conversations with the Realtime agent.
 * It generates audio messages using OpenAI's gpt-4o-audio-preview model.
 *
 * @example
 * ```typescript
 * const audioUserSim = new AudioUserSimulator();
 *
 * await scenario.run({
 *   agents: [realtimeAdapter, audioUserSim],
 *   script: [scenario.user(), scenario.agent()]
 * });
 * ```
 */
import { AgentRole, type AgentInput } from "@langwatch/scenario";
import type { ModelMessage } from "ai";
import { OpenAiVoiceAgent } from "../../helpers/openai-voice-agent";
import { RealtimeAgentAdapter } from "./realtime-agent-adapter";
import { RealtimeAgent } from "@openai/agents/realtime";

/**
 * User simulator that generates audio messages for testing Realtime agents
 *
 * Uses gpt-4o-audio-preview to:
 * - Generate natural voice responses based on scenario context
 * - Process audio responses from the Realtime agent
 * - Maintain multi-turn voice conversations
 */
export class AudioUserSimulator extends RealtimeAgentAdapter {
  role = AgentRole.USER;

  constructor() {
    super({
      agent: new RealtimeAgent({
        name: "Vegetarian Recipe Assistant",
        instructions: "You want to eat only tacos",
        voice: "ash",
      }),
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }
}
