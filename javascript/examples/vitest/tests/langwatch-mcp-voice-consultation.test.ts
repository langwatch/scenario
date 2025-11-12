/**
 * LangWatch MCP Voice Consultation Test
 *
 * Tests voice-based consultation about LangWatch Scenarios using real MCP server.
 *
 * The expert agent connects to the actual LangWatch MCP server process
 * (npx @langwatch/mcp-server) and fetches real documentation to answer questions.
 *
 * @see https://docs.langwatch.ai/integration/mcp
 */
import * as path from "path";
import scenario from "@langwatch/scenario";
import { describe, it, expect, afterAll } from "vitest";
import {
  LangWatchExpertAgent,
  ScenarioInquiryUserSimulator,
  saveConversationAudio,
  wrapJudgeForAudio,
  disconnectMCPClient,
} from "./helpers";

const SET_ID = "langwatch-mcp-voice-consultation";

const OUTPUT_PATH = path.join(
  process.cwd(),
  "tmp",
  "audio_conversations",
  "langwatch-consultation.wav"
);

describe("LangWatch MCP Voice Consultation", () => {
  // Clean up MCP connection after all tests
  afterAll(async () => {
    await disconnectMCPClient();
  });

  it("should explain LangWatch Scenarios capabilities via voice using MCP server", async () => {
    const userSimulator = new ScenarioInquiryUserSimulator();
    const expertAgent = new LangWatchExpertAgent();

    const conversationJudge = wrapJudgeForAudio(
      scenario.judgeAgent({
        // model: openai("gpt-4o"),
        criteria: [
          "Expert explains user simulations for testing conversational AI",
          "Expert mentions detecting issues before deployment",
          "Expert discusses benchmarking or CI/CD integration",
          "Conversation flows naturally between user and expert",
        ],
      })
    );

    const result = await scenario.run({
      name: "LangWatch Scenarios consultation via voice",
      description:
        "User wants to know about how to use LangWatch Scenarios for testing AI agents.",
      //       description: `A developer wants to learn about using LangWatch Scenarios for testing AI agents.
      // The expert consultant has access to LangWatch documentation via MCP server tools and explains:
      // - Creating user simulations for stress-testing conversational/voice AI
      // - Detecting logic, grounding, and issues before deployment
      // - Benchmarking model and prompt variants
      // - Integrating scenarios into CI/CD workflows`,
      agents: [expertAgent, userSimulator, conversationJudge],
      script: [
        scenario.proceed(10),
        async (ctx) => {
          await saveConversationAudio(ctx, OUTPUT_PATH);
        },
        scenario.judge(),
      ],
      setId: SET_ID,
    });

    try {
      console.log("✅ LangWatch MCP Voice Consultation Result:", result);
      expect(result.success).toBe(true);
    } catch (error) {
      console.error("❌ Consultation failed:", result);
      throw error;
    }
  }, 120000);

  it.todo("should fetch specific documentation via MCP fetch_langwatch_docs");
  it.todo("should explain CI/CD integration with code examples");
  it.todo("should demonstrate benchmarking different models");
  it.todo(
    "should handle technical questions about scripted vs automated tests"
  );
});
