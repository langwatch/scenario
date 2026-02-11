/**
 * Vegetarian Recipe Agent - Realtime API Integration Test
 *
 * This test validates the EXACT agent that runs in the browser.
 * Uses the same session creator for accurate testing.
 *
 * Architecture:
 * 1. Browser: createVegetarianRecipeSession() → connect with token → use directly
 * 2. Test: createVegetarianRecipeSession() → connect with API key → wrap in adapter
 * 3. SAME session creation = accurate testing!
 */

import scenario, {
  AgentRole,
  RealtimeAgentAdapter,
  type AudioResponseEvent,
} from "@langwatch/scenario";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { wrapJudgeForAudioTranscription } from "./helpers/wrap-judge-for-audio-transcription";
import { AudioUtils } from "./utils/audio/audio.utils";
import { createUserSimulatorSession } from "../../openai-realtime-demo/agents/realtime-user-simulator.agent";
import { createVegetarianRecipeSession } from "../../openai-realtime-demo/agents/vegetatrian-recipe.agent";

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
class RealtimeUserSimulatorAgent extends RealtimeAgentAdapter {
  role = AgentRole.USER;

  constructor() {
    const session = createUserSimulatorSession();

    super({
      session: session,
      role: AgentRole.USER,
      agentName: "Realtime User Simulator Agent",
      responseTimeout: 60000,
    });
  }
}

describe("Vegetarian Recipe Agent (Realtime API)", () => {
  // Used for wrapping the agent under test in the adapter
  let realtimeAdapter: RealtimeAgentAdapter;
  // Used for simulating a user in voice conversations with the Realtime agent
  let audioUserSim: RealtimeUserSimulatorAgent;
  const collectedAudio: AudioResponseEvent[] = [];

  beforeAll(async () => {
    // Create and connect the session - SAME as browser client pattern
    const session = createVegetarianRecipeSession();

    // Wrap connected session in adapter for Scenario testing
    realtimeAdapter = new RealtimeAgentAdapter({
      role: AgentRole.AGENT,
      session: session,
      agentName: "Vegetarian Recipe Assistant",
      responseTimeout: 60000,
    });

    // Create user simulator (creates its own session internally)
    audioUserSim = new RealtimeUserSimulatorAgent();

    // Subscribe to audio events
    realtimeAdapter.onAudioResponse((event) => {
      console.log("[Realtime Agent] response:", event.transcript);
      collectedAudio.push(event);
    });

    audioUserSim.onAudioResponse((event) => {
      console.log("[Realtime User Simulator] response:", event.transcript);
      collectedAudio.push(event);
    });

    // Connect user simulator (adapter handles connection)
    await Promise.all([realtimeAdapter.connect(), audioUserSim.connect()]);
  }, 60000); // Longer timeout for connection

  afterAll(async () => {
    // Cleanup connection
    await Promise.all([
      realtimeAdapter.disconnect(),
      audioUserSim.disconnect(),
    ]);

    // Write collected audio to WAV files
    try {
      console.log("Saving test audio to tmp/audio-output");
      await AudioUtils.saveTestAudio({
        collectedAudio,
        outputDir: "tmp/audio-output",
      });
    } catch (error) {
      console.error("Failed to save test audio:", error);
    }
  });

  it("should handle voice-to-voice conversation with audio user", async () => {
    const result = await scenario.run({
      name: "vegetarian recipe - voice-to-voice",
      description: `It's Saturday evening, the user is very hungry and tired, but has no money to order out. They're looking for a quick vegetarian recipe and calling in via voice.`,
      agents: [
        realtimeAdapter, // Realtime agent (handles audio!)
        audioUserSim, // Audio user simulator (generates voice)
        wrapJudgeForAudioTranscription(
          // Judge with audio transcription
          scenario.judgeAgent({
            criteria: [
              "Agent should provide a vegetarian recipe",
              "Recipe should include ingredients",
              "Recipe should include cooking steps",
              "Agent should be helpful and encouraging",
            ],
          })
        ),
      ],
      script: [
        scenario.user(
          "Hi, I'm looking for a quick vegetarian recipe for dinner"
        ), // Send text input (user simulator -> realtime agent)
        scenario.agent("What kind of vegetarian recipe are you looking for?"), // Send text input (realtime agent -> user simulator)
        scenario.user(), // Audio follow-up
        scenario.agent(), // Audio response
        scenario.judge(), // Evaluates transcripts
      ],
      setId: "realtime-examples",
    });

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.log(result);
      throw error;
    }
  }, 90000); // Longer timeout for voice-to-voice (audio generation takes time)
});
