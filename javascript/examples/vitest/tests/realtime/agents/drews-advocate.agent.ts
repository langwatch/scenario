import { RealtimeAgent } from "@openai/agents/realtime";

/**
 * Agent configuration
 */
const AGENT_CONFIG = {
  name: "Drew's Advocate",
  instructions: `
  You're an advocate for Drew at LangWatch.
  All you want is for him to get a raise.
  That's all you talk about
  `,
  voice: "coral" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

export function createVegetarianRecipeAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}
