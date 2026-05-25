/**
 * Vegetarian Recipe Agent - Realtime API Integration Test
 *
 * This test validates the EXACT agent that runs in the browser.
 * Uses the same agent configuration via shared module.
 *
 * Architecture:
 * 1. Browser client uses: createVegetarianRecipeAgent()
 * 2. This test uses: createVegetarianRecipeAgent()
 * 3. SAME agent, accurate testing!
 */

import scenario from "@langwatch/scenario";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createVegetarianRecipeAgent } from "./realtime/agents/vegetarian-recipe-agent.js";
import {
  RealtimeAgentAdapter,
  RealtimeUserSimulatorAgent,
  wrapJudgeForAudio,
  AudioOutputUtils,
} from "./realtime/helpers";
import type { AudioResponseEvent } from "./realtime/helpers";

describe("Vegetarian Recipe Agent (Realtime API)", () => {
  let realtimeAdapter: RealtimeAgentAdapter;
  let audioUserSim: RealtimeUserSimulatorAgent;
  const collectedAudio: AudioResponseEvent[] = [];

  beforeAll(async () => {
    // Create the SAME agent as the browser client
    const agent = createVegetarianRecipeAgent();
    audioUserSim = new RealtimeUserSimulatorAgent();

    // Wrap in adapter for Scenario testing
    realtimeAdapter = new RealtimeAgentAdapter({
      agent,
      apiKey: process.env.OPENAI_API_KEY!, // Direct API key for testing
      responseTimeout: 30000,
    });

    // Subscribe to audio events
    realtimeAdapter.onAudioResponse((event) => {
      collectedAudio.push(event);
    });

    // Connect once for all tests
    await Promise.all([realtimeAdapter.connect(), audioUserSim.connect()]);
  }, 60000); // Longer timeout for connection

  afterAll(async () => {
    // Cleanup connection
    await Promise.all([
      realtimeAdapter.disconnect(),
      audioUserSim.disconnect(),
    ]);

    // Write collected audio to WAV files
    await AudioOutputUtils.saveTestAudio({ collectedAudio });
  });

  it("should handle voice-to-voice conversation with audio user", async () => {
    const result = await scenario.run({
      name: "vegetarian recipe - voice-to-voice",
      description: `It's Saturday evening, the user is very hungry and tired, but has no money to order out. They're looking for a quick vegetarian recipe and calling in via voice.`,
      agents: [
        realtimeAdapter, // Realtime agent (handles audio!)
        audioUserSim, // Audio user simulator (generates voice)
        wrapJudgeForAudio(
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
        scenario.user(), // Audio from user simulator
        scenario.agent(), // Audio response from Realtime agent
        scenario.user(), // Audio follow-up
        scenario.agent(), // Audio response
        scenario.judge(), // Evaluates transcripts
      ],
      setId: "realtime-examples",
    });

    expect(result.success).toBe(true);
  }, 90000); // Longer timeout for voice-to-voice (audio generation takes time)
});
