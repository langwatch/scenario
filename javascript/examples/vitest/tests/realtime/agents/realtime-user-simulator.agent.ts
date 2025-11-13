import { AgentRole, type AgentInput } from "@langwatch/scenario";
import { RealtimeAgentAdapter } from "../helpers/realtime-agent-adapter";
import { RealtimeAgent } from "@openai/agents/realtime";

/**
 * Realtime User Simulator for testing Realtime agents
 *
 * This class simulates a user in voice conversations with the Realtime agent.
 */
export class RealtimeUserSimulatorAgent extends RealtimeAgentAdapter {
  role = AgentRole.USER;

  constructor() {
    super({
      role: AgentRole.USER,
      agent: new RealtimeAgent({
        name: "Realtime User Simulator",
        instructions:
          "You are pretending to be a user looking for help with LangWatch tracing implementations",
        voice: "ash",
      }),
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }
}
