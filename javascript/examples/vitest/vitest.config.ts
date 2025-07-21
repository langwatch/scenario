/**
 * Vitest configuration for LangWatch Scenario testing
 *
 * This configuration sets up Vitest to work with LangWatch Scenario for
 * testing AI agents and conversational flows. It includes:
 * - Scenario integration for agent testing
 * - Custom reporter for scenario-specific test output
 * - Extended timeout for AI model interactions
 * - Environment variable loading
 */

import { withScenario } from "@langwatch/scenario/integrations/vitest/config";
import VitestReporter from "@langwatch/scenario/integrations/vitest/reporter";
import { defineConfig } from "vitest/config";

/**
 * Export the Vitest configuration wrapped with Scenario integration
 *
 * The `withScenario` wrapper provides:
 * - Automatic scenario test discovery and execution
 * - Integration with LangWatch's agent testing framework
 * - Support for conversational test scenarios
 * - Built-in mocking and fixture handling
 */
export default withScenario(
  defineConfig({
    test: {
      // Extended timeout for AI model interactions
      // AI agents can take time to process and respond, especially with
      // complex prompts or when using slower models
      testTimeout: 180_000, // 3 minutes

      // Load environment variables from .env file
      // Required for API keys and configuration needed by AI agents
      setupFiles: ["dotenv/config"],

      // (Optional) Use Scenario's custom reporter for better test output
      // Provides detailed information about agent interactions,
      // conversation flows, and test results
      reporters: ["default", new VitestReporter()],
    },
  })
);
