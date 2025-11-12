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
import { AgentRole } from "@langwatch/scenario";
import { OpenAiVoiceAgent } from "../../helpers/openai-voice-agent";

/**
 * User simulator that generates audio messages for testing Realtime agents
 *
 * Uses gpt-4o-audio-preview to:
 * - Generate natural voice responses based on scenario context
 * - Process audio responses from the Realtime agent
 * - Maintain multi-turn voice conversations
 */
export class AudioUserSimulator extends OpenAiVoiceAgent {
  role = AgentRole.USER;

  constructor() {
    super({
      systemPrompt: `You are simulating a user looking for vegetarian recipes.

Your role is to:
- Ask for recipe recommendations in a natural, conversational way
- Mention your situation (e.g., hungry, tired, dietary restrictions)
- Ask follow-up questions when needed
- Respond to the agent's questions naturally
- Keep responses brief and conversational (this is a VOICE conversation)

Remember:
- Speak naturally as if talking to a friend
- Don't be overly formal
- Express enthusiasm or concern as appropriate
- Keep each response under 20 seconds when spoken`,
      voice: "nova", // Different voice from agent for clarity
      audioFormat: "pcm16", // Use PCM16 for Realtime API compatibility
    });
  }
}

