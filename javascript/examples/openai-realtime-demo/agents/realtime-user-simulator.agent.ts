import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

const USER_SIMULATOR_CONFIG = {
  name: "Realtime User Simulator",
  instructions:
    "You are pretending to be a user looking for help getting started with LangWatch's Scenario",
  voice: "ash" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
};

/**
 * Creates a RealtimeSession for the user simulator
 */
function createUserSimulatorSession(): RealtimeSession {
  const agent = new RealtimeAgent({
    name: USER_SIMULATOR_CONFIG.name,
    instructions: USER_SIMULATOR_CONFIG.instructions,
    voice: USER_SIMULATOR_CONFIG.voice,
  });
  return new RealtimeSession(agent, {
    model: USER_SIMULATOR_CONFIG.model,
  });
}

export { createUserSimulatorSession };
