/**
 * Scenario Expert Agent - Realtime API Integration Test
 *
 * This test validates the EXACT agent that runs in the browser.
 * Uses the same session creator for accurate testing.
 *
 * Architecture:
 * 1. Browser: createScenarioExpertSession() → connect with token → use directly
 * 2. Test: createScenarioExpertSession() → connect with API key → wrap in adapter
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
import { createScenarioExpertSession } from "../../openai-realtime-demo/agents/scenario-expert.agent";

describe("Scenario Expert Agent (Realtime API)", () => {
  // Used for wrapping the agent under test in the adapter
  let realtimeAdapter: RealtimeAgentAdapter;
  // Used for simulating a user in voice conversations with the Realtime agent
  let audioUserSim: RealtimeAgentAdapter;
  const collectedAudio: AudioResponseEvent[] = [];

  beforeAll(async () => {
    // Create and connect the session - SAME as browser client pattern
    const session = createScenarioExpertSession();

    // Wrap connected session in adapter for Scenario testing
    realtimeAdapter = new RealtimeAgentAdapter({
      role: AgentRole.AGENT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      agentName: "Scenario Expert",
      responseTimeout: 30000,
    });

    const userSimulatorSession = createUserSimulatorSession();
    // Create user simulator (creates its own session internally)
    audioUserSim = new RealtimeAgentAdapter({
      role: AgentRole.USER,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: userSimulatorSession as any,
      agentName: "Realtime User Simulator",
      responseTimeout: 30000,
    });

    // Subscribe to audio events
    realtimeAdapter.onAudioResponse((event) => {
      console.log("[Scenario Expert] response:", event.transcript);
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

  it("should handle voice-to-voice conversation about Scenario framework", async () => {
    const result = await scenario.run({
      name: "scenario expert - voice-to-voice",
      description: `A developer is learning about LangWatch Scenario for the first time and wants to understand how simulation-based testing works for AI agents.`,
      agents: [
        realtimeAdapter, // Realtime agent (handles audio!)
        audioUserSim, // Audio user simulator (generates voice)
        wrapJudgeForAudioTranscription(
          // Judge with audio transcription
          scenario.judgeAgent({
            criteria: [
              "Agent explains what LangWatch Scenario is",
              "Agent is helpful and informative",
            ],
          })
        ),
      ],
      script: [
        scenario.agent(
          "Hi, welcome to the Scenario expert! How can I help you today?"
        ),
        scenario.user(), // Audio follow-up
        scenario.agent(), // Audio response
        scenario.user(), // Audio follow-up
        scenario.agent(), // Audio response
        scenario.judge(), // Evaluates transcripts
      ],
      setId: "realtime-examples",
    });

    expect(result.success).toBe(true);
  }, 90000); // Longer timeout for voice-to-voice (audio generation takes time)
});
