/**
 * Realtime Agent Adapter for Scenario Testing
 *
 * Orchestrates the improved architecture with separated concerns:
 * - Session management for connection lifecycle
 * - Message transformation for format conversion
 * - Centralized logging
 * - Clean dependency injection
 *
 * Connects Scenario framework to OpenAI Realtime API using the exact same
 * agent configuration as the browser client.
 */

import {
  AgentAdapter,
  AgentInput,
  AgentRole,
  type AgentReturnTypes,
} from "@langwatch/scenario";
import type { ConnectionConfig, AgentConfig } from "./types.js";
import type { SessionManager } from "./session-manager.js";
import { OpenAISessionManager } from "./session-manager.js";
import type { MessageTransformer } from "./message-transformer.js";
import { DefaultMessageTransformer } from "./message-transformer.js";
import type { Logger } from "./logger.js";
import { defaultLogger } from "./logger.js";

/**
 * Configuration for RealtimeAgentAdapter
 */
export interface RealtimeAgentAdapterConfig {
  /**
   * Agent configuration (personality + capabilities)
   */
  agentConfig: AgentConfig;

  /**
   * Session manager for handling connection lifecycle
   */
  sessionManager?: SessionManager;

  /**
   * Message transformer for format conversion
   */
  messageTransformer?: MessageTransformer;

  /**
   * Logger for centralized logging
   */
  logger?: Logger;

  /**
   * OpenAI API key for direct connection (recommended for testing)
   */
  apiKey?: string;

  /**
   * URL of the ephemeral token server (for production/browser use)
   * Only used if apiKey is not provided
   * @default "http://localhost:3000"
   */
  tokenServerUrl?: string;

  /**
   * Timeout for waiting for agent response (ms)
   * @default 60000 (increased for voice processing)
   */
  responseTimeout?: number;
}

/**
 * Improved Realtime Agent Adapter
 *
 * Uses dependency injection and separation of concerns for better maintainability.
 * Orchestrates session management, message transformation, and logging.
 *
 * @example
 * ```typescript
 * const adapter = new RealtimeAgentAdapter({
 *   agentConfig: AGENT_CONFIG,
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * // In beforeAll
 * await adapter.connect();
 *
 * // In test
 * await scenario.run({
 *   agents: [adapter, scenario.userSimulatorAgent()],
 *   script: [scenario.user("message"), scenario.agent()]
 * });
 *
 * // In afterAll
 * await adapter.disconnect();
 * ```
 */
export class RealtimeAgentAdapter extends AgentAdapter {
  role = AgentRole.AGENT;

  private sessionManager: SessionManager;
  private messageTransformer: MessageTransformer;
  private logger: Logger;

  constructor(private config: RealtimeAgentAdapterConfig) {
    super();

    // Initialize dependencies with defaults
    this.sessionManager =
      config.sessionManager ??
      new OpenAISessionManager({
        agentConfig: config.agentConfig,
        logger: config.logger,
        defaultTimeoutMs: config.responseTimeout,
      });

    this.messageTransformer =
      config.messageTransformer ??
      new DefaultMessageTransformer({
        logger: config.logger,
      });

    this.logger = config.logger ?? defaultLogger;
  }

  /**
   * Connects to the Realtime API using the session manager
   *
   * Call this once before running tests (e.g., in beforeAll)
   *
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    try {
      const connectionConfig: ConnectionConfig = {
        apiKey: this.config.apiKey,
        tokenServerUrl: this.config.tokenServerUrl,
      };

      await this.sessionManager.connect(connectionConfig);
      this.logger.info("RealtimeAgentAdapter connected successfully");
    } catch (error) {
      this.logger.error("Failed to connect RealtimeAgentAdapter", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Disconnects from the Realtime API
   *
   * Call this once after tests complete (e.g., in afterAll)
   */
  async disconnect(): Promise<void> {
    try {
      await this.sessionManager.disconnect();
      this.logger.info("RealtimeAgentAdapter disconnected successfully");
    } catch (error) {
      this.logger.error("Error during RealtimeAgentAdapter disconnection", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process input and generate response (implements AgentAdapter interface)
   *
   * Orchestrates the conversation flow:
   * 1. Transform Scenario input to realtime format
   * 2. Send message via session manager and wait for response
   * 3. Transform response back to Scenario format
   *
   * @param input - Scenario agent input with message history
   * @returns Agent response in Scenario format
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!this.sessionManager.isConnected()) {
      throw new Error(
        "RealtimeAgentAdapter not connected. Call connect() first."
      );
    }

    try {
      // Transform input to realtime format
      const realtimeMessage = this.messageTransformer.toRealtimeFormat(input);

      // Send message and wait for response
      const timeout = this.config.responseTimeout ?? 60000;
      const audioResponse = await this.sessionManager.sendMessageAndWait(
        realtimeMessage,
        timeout
      );

      // Transform response to Scenario format
      return this.messageTransformer.fromRealtimeFormat(audioResponse);
    } catch (error) {
      this.logger.error("Failed to process message in RealtimeAgentAdapter", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Checks if the adapter is currently connected
   */
  isConnected(): boolean {
    return this.sessionManager.isConnected();
  }
}
