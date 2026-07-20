// Shared realtime USER simulator for the voice example tests: an OpenAI Realtime
// agent (role=USER) that voices the customer persona natively, with no TTS step.
// Driven verbatim for a scripted opener and autonomously for proceed() turns.
import scenario, { AgentRole, voice } from "@langwatch/scenario";

const { OPENAI_REALTIME_MODEL } = voice;

// Persona + goal for the autonomous realtime user. With a realtime user (not a
// userSimulatorAgent) this rides on the adapter `instructions`. Kept free of
// framework jargon so nothing framework-y can be voiced.
export const CUSTOMER_INSTRUCTIONS =
  "You are a customer who has called your bank's support line about your " +
  "account. You are the one being helped, you are NEVER the agent. Speak one " +
  "short, natural, first-person sentence per turn, in your own words: ask your " +
  "next question, or answer what the agent just asked. Do not offer assistance, " +
  "do not present menu options, and do not echo the agent's wording. Across the " +
  "call you want to check your balance, ask about a recent transaction, and " +
  "update a setting on your account.";

/**
 * Realtime USER simulator: the model itself speaks (role=USER), driven verbatim
 * for the scripted opener and autonomously for the proceed() turns.
 */
export function realtimeUser() {
  return scenario.openAIRealtimeAgent({
    model: OPENAI_REALTIME_MODEL,
    voice: "marin",
    instructions: CUSTOMER_INSTRUCTIONS,
    role: AgentRole.USER,
  });
}
