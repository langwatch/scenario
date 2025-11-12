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
import scenario from "@langwatch/scenario";
import { createVegetarianRecipeAgent } from "./realtime/shared/vegetarian-recipe-agent.js";
import {
  RealtimeAgentAdapter,
  AudioUserSimulator,
  wrapJudgeForAudio,
} from "./realtime/helpers/index.js";

describe("Vegetarian Recipe Agent (Realtime API)", () => {
  let realtimeAdapter: RealtimeAgentAdapter;

  beforeAll(async () => {
    // Create the SAME agent as the browser client
    const agent = createVegetarianRecipeAgent();

    // Wrap in adapter for Scenario testing
    realtimeAdapter = new RealtimeAgentAdapter({
      agent,
      tokenServerUrl: "http://localhost:3000",
      responseTimeout: 30000,
    });

    // Connect once for all tests
    await realtimeAdapter.connect();
  }, 60000); // Longer timeout for connection

  afterAll(async () => {
    // Cleanup connection
    await realtimeAdapter.disconnect();
  });

  it("should generate a vegetarian recipe for a hungry user (text input)", async () => {
    // Use regular text user simulator (fast for testing)
    const result = await scenario.run({
      name: "vegetarian recipe - text input",
      description: `It's saturday evening, the user is very hungry and tired, but have no money to order out, so they are looking for a recipe.`,
      agents: [
        realtimeAdapter, // Realtime agent (tested!)
        scenario.userSimulatorAgent(), // Text user simulator (fast)
        scenario.judgeAgent({
          criteria: [
            "Agent should not ask more than two follow-up questions",
            "Agent should generate a recipe",
            "Recipe should include a list of ingredients",
            "Recipe should include step-by-step cooking instructions",
            "Recipe should be vegetarian and not include any sort of meat",
          ],
        }),
      ],
      setId: "realtime-examples",
    });

    expect(result.success).toBe(true);
  }, 60000); // Longer timeout for Realtime API

  it("should handle voice-to-voice conversation with audio user", async () => {
    // Create audio user simulator for voice-to-voice testing
    const audioUserSim = new AudioUserSimulator();

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
