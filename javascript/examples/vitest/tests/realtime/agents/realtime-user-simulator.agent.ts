import { AgentRole, RealtimeAgentAdapter } from "@langwatch/scenario";
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

const USER_SIMULATOR_CONFIG = {
  name: "Realtime User Simulator",
  instructions:
    "You are pretending to be a user looking for help with LangWatch tracing implementations",
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

/**
 * Realtime User Simulator for testing Realtime agents
 *
 * This class simulates a user in voice conversations with the Realtime agent.
 *
 * Usage:
 * ```typescript
 * const session = createUserSimulatorSession();
 * await session.connect({ apiKey: process.env.OPENAI_API_KEY! });
 * const userSimulator = new RealtimeUserSimulatorAgent(session);
 * ```
 */
export class RealtimeUserSimulatorAgent extends RealtimeAgentAdapter {
  role = AgentRole.USER;

  constructor() {
    const session = createUserSimulatorSession();

    super({
      session: session,
      role: AgentRole.USER,
      agentName: USER_SIMULATOR_CONFIG.name,
      responseTimeout: 30000,
    });
  }
}

export { createUserSimulatorSession };
