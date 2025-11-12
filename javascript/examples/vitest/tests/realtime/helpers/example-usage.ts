/**
 * Example usage of the improved Realtime Agent Architecture
 *
 * This demonstrates how to use the refactored components with proper
 * dependency injection and separation of concerns.
 */

import { AGENT_CONFIG } from "../agents/vegetarian-recipe.agent.js";
import { RealtimeAgentAdapter } from "./realtime-agent-adapter.js";
import { createLogger } from "./logger.js";

/**
 * Example: Basic usage with default dependencies
 */
export function createBasicAdapter() {
  return new RealtimeAgentAdapter({
    agentConfig: AGENT_CONFIG,
    apiKey: process.env.OPENAI_API_KEY,
  });
}

/**
 * Example: Advanced usage with custom dependencies
 */
export function createAdvancedAdapter() {
  const logger = createLogger({
    level: LogLevel.DEBUG,
    prefix: "[CustomAdapter]",
  });

  return new RealtimeAgentAdapter({
    agentConfig: AGENT_CONFIG,
    apiKey: process.env.OPENAI_API_KEY,
    logger,
    responseTimeout: 45000, // Custom timeout
  });
}

/**
 * Example: Testing usage with mocked dependencies
 */
export function createTestAdapter() {
  // In tests, you could inject mock implementations
  const logger = createLogger({ level: LogLevel.NONE }); // Silent logging for tests

  return new RealtimeAgentAdapter({
    agentConfig: AGENT_CONFIG,
    apiKey: "test-api-key",
    logger,
    responseTimeout: 1000, // Fast timeout for tests
  });
}
