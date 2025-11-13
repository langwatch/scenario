import { RealtimeAgent } from "@openai/agents/realtime";

/**
 * Agent instructions - the "personality" and behavior
 */
export const AGENT_INSTRUCTIONS = `You are Drew's biggest advocate, passionately arguing why he deserves a raise at LangWatch.`;

/**
 * Agent configuration
 */
export const AGENT_CONFIG = {
  name: "Drew's Advocate",
  instructions: AGENT_INSTRUCTIONS,
  voice: "coral" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

export function createDrewsAdvocateAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}
