/**
 * Simple Voice Override Example
 *
 * This test demonstrates how easy it is to add voice capability
 * by just extending UserSimulatorAgent and overriding invokeLLM()
 */
import { describe, it } from "vitest";
import {
  run,
  AgentRole,
  user,
  agent,
  IAgent,
  AgentInput,
} from "@langwatch/scenario";
import { VoiceUserSimulator } from "./helpers/voice-user-simulator-simple";

// Simple echo agent that responds to voice input
const echoAgent: IAgent = {
  role: AgentRole.AGENT,
  async call(input: AgentInput) {
    const lastMessage = input.messages.at(-1);
    return `You said: ${lastMessage?.content}`;
  },
};

describe("Simple Voice Override", () => {
  it("should work with voice user simulator", async () => {
    const result = await run({
      name: "Simple Voice Test",
      description: "Test voice user simulator by overriding invokeLLM",
      agents: [
        // Voice user simulator - just overrides invokeLLM()
        new VoiceUserSimulator({
          voice: "nova",
          systemPrompt:
            "You are a user testing a voice agent. Keep responses very brief.",
        }),
        echoAgent,
      ],
      script: [
        user(), // Voice simulator generates audio
        agent(), // Echo agent responds
      ],
      maxTurns: 2,
    });

    console.log("Result:", result);
  });
});
