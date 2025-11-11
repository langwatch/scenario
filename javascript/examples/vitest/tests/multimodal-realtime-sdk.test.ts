/**
 * Realtime Voice Tests using OpenAI Agents SDK
 *
 * This demonstrates testing voice agents using the official OpenAI Agents SDK.
 * The same agent configuration works for both browser UI and Scenario testing.
 *
 * Architecture:
 * - Browser: RealtimeAgent + RealtimeSession (auto-handles everything)
 * - Testing: RealtimeScenarioAdapter (buffers streaming to turns)
 */
import scenario from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import { RealtimeScenarioAdapter, wrapJudgeForAudio } from "./helpers";

const setId = "realtime-sdk-test";

describe("Realtime Agent SDK Tests", () => {
  it.skip(
    "should test voice agent using OpenAI Agents SDK",
    async () => {
      // Same configuration used in browser
      const agent = new RealtimeScenarioAdapter({
        name: "Assistant",
        instructions: `You are a helpful AI assistant.
        Respond naturally and conversationally.
        Keep responses short and engaging.`,
        voice: "alloy",
      });

      // User simulator generates audio
      const userSimulator = scenario.userSimulatorAgent({
        systemPrompt: `You are simulating a user asking about AI testing.
        Ask 2 questions then say goodbye.`,
      });

      // Judge evaluates conversation
      const judge = wrapJudgeForAudio(
        scenario.judgeAgent({
          criteria: ["Conversation flows naturally"],
        })
      );

      // Run scenario
      const result = await scenario.run({
        name: "Realtime SDK conversation test",
        description: "Test agent using OpenAI Agents SDK",
        agents: [userSimulator, agent, judge],
        script: [
          scenario.proceed(2), // 2 conversation turns
          scenario.judge(),
        ],
        setId,
      });

      try {
        console.log("TEST RESULT", result);
        expect(result.success).toBe(true);
      } catch (error) {
        console.error("Test failed:", result);
        throw error;
      }
    },
    { timeout: 60000 }
  );

  it.todo("should handle longer conversations");
  it.todo("should work with different voices");
  it.todo("should maintain context across turns");
});

/**
 * Usage Notes:
 *
 * Browser UI (voice-ui-simple.html):
 * - Uses RealtimeAgent + RealtimeSession
 * - Auto-handles microphone, VAD, playback
 * - Same agent configuration
 *
 * Scenario Testing (this file):
 * - Uses RealtimeScenarioAdapter
 * - Buffers streaming into turns
 * - Same agent configuration
 *
 * Benefits:
 * - SRP: Each component has one job
 * - DRY: Share agent configuration
 * - Clean: SDK handles complexity
 */

