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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import scenario from "@langwatch/scenario";
import { createVegetarianRecipeAgent } from "./realtime/shared/vegetarian-recipe-agent.js";
import {
  RealtimeAgentAdapter,
  AudioUserSimulator,
  wrapJudgeForAudio,
} from "./realtime/helpers/index.js";
import type { AudioResponseEvent } from "./realtime/helpers/index.js";

describe("Vegetarian Recipe Agent (Realtime API)", () => {
  let realtimeAdapter: RealtimeAgentAdapter;
  let audioUserSim: AudioUserSimulator;
  const collectedAudio: AudioResponseEvent[] = [];

  beforeAll(async () => {
    // Create the SAME agent as the browser client
    const agent = createVegetarianRecipeAgent();
    audioUserSim = new AudioUserSimulator();

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

    // Write collected audio to file
    if (collectedAudio.length > 0) {
      const audioData = collectedAudio.map((e, i) => ({
        index: i,
        transcript: e.transcript,
        audio: e.audio,
      }));
      const outputPath = join(process.cwd(), "test-audio-output.json");
      writeFileSync(outputPath, JSON.stringify(audioData, null, 2));
      console.log(`💾 Saved ${collectedAudio.length} audio responses to ${outputPath}`);
    }
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
