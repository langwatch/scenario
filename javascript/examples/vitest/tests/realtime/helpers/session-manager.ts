/**
 * Session Manager
 *
 * Manages the lifecycle of realtime sessions, coordinating between
 * transport abstraction and response collection. Provides a clean
 * interface for connection management and message sending.
 */

import type { RealtimeAgent } from "@openai/agents/realtime";
import { RealtimeSession } from "@openai/agents/realtime";
import type {
  AgentConfig,
  ConnectionConfig,
  RealtimeMessage,
  AudioResponse,
} from "./types.js";
import type { Logger } from "./logger.js";
import { OpenAITransportAbstraction } from "./transport-abstraction";
import { DefaultResponseCollector } from "./response-collector";

export interface SessionManager {
  /**
   * Connects to the realtime service
   */
  connect(config: ConnectionConfig): Promise<void>;

  /**
   * Disconnects from the realtime service
   */
  disconnect(): Promise<void>;

  /**
   * Checks if the session is connected
   */
  isConnected(): boolean;

  /**
   * Sends a message and waits for the response
   */
  sendMessageAndWait(
    message: RealtimeMessage,
    timeoutMs?: number
  ): Promise<AudioResponse>;
}

export interface SessionManagerConfig {
  /** Agent configuration for the session */
  agentConfig: AgentConfig;

  /** Logger instance */
  logger?: Logger;

  /** Default timeout for responses */
  defaultTimeoutMs?: number;
}

/**
 * OpenAI Realtime Session Manager Implementation
 *
 * Manages the OpenAI RealtimeSession lifecycle and coordinates
 * with transport abstraction and response collection.
 */
export class OpenAISessionManager implements SessionManager {
  private session?: RealtimeSession;
  private transport?: TransportAbstraction;
  private responseCollector?: DefaultResponseCollector;
  private isConnectedFlag = false;

  constructor(private config: SessionManagerConfig) {}

  async connect(connectionConfig: ConnectionConfig): Promise<void> {
    if (this.isConnectedFlag) {
      this.config.logger?.warn("Session manager already connected");
      return;
    }

    try {
      // Create the realtime session with agent configuration
      this.session = new RealtimeSession(this.createRealtimeAgent(), {
        model: this.config.agentConfig.model,
      });

      // Create transport abstraction
      this.transport = new OpenAITransportAbstraction(this.session, {
        logger: this.config.logger,
        debugEvents: false, // Can be made configurable
      });

      // Create response collector
      this.responseCollector = new DefaultResponseCollector({
        defaultTimeoutMs: this.config.defaultTimeoutMs,
        logger: this.config.logger,
      });

      // Register response collector with transport
      this.transport.registerResponseCollector(this.responseCollector);

      // Connect transport
      await this.transport.connect();

      // Connect session
      await this.session.connect({ apiKey: connectionConfig.apiKey });

      this.isConnectedFlag = true;
      this.config.logger?.info("Session manager connected successfully");
    } catch (error) {
      this.config.logger?.error("Failed to connect session manager", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.cleanup();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnectedFlag) {
      return;
    }

    try {
      await this.cleanup();
      this.isConnectedFlag = false;
      this.config.logger?.info("Session manager disconnected successfully");
    } catch (error) {
      this.config.logger?.error("Error during session manager disconnection", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag && this.transport?.isConnected() === true;
  }

  async sendMessageAndWait(
    message: RealtimeMessage,
    timeoutMs?: number
  ): Promise<AudioResponse> {
    if (!this.isConnected() || !this.transport || !this.responseCollector) {
      throw new Error("Session manager not connected");
    }

    try {
      // Reset response collector for new response
      this.responseCollector.reset();

      // Send the message
      await this.transport.sendMessage(message);

      // Wait for response
      const response = await this.responseCollector.getCompleteResponse(
        timeoutMs
      );

      this.config.logger?.info("Message sent and response received", {
        messageType: message.type,
        transcriptLength: response.transcript.length,
        audioLength: response.audio.length,
      });

      return response;
    } catch (error) {
      this.config.logger?.error(
        "Failed to send message and wait for response",
        {
          messageType: message.type,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  private createRealtimeAgent(): RealtimeAgent {
    const { RealtimeAgent } = require("@openai/agents/realtime");

    return new RealtimeAgent({
      name: this.config.agentConfig.name,
      instructions: this.config.agentConfig.instructions,
      voice: this.config.agentConfig.voice,
      // Tools and other capabilities can be added here if needed
    });
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.disconnect();
        this.transport = undefined;
      }

      if (this.session) {
        // Use the close method if available (from SDK 0.3.0)
        if (typeof (this.session as any).close === "function") {
          await (this.session as any).close();
        }
        this.session = undefined;
      }

      if (this.responseCollector) {
        this.responseCollector.reset();
        this.responseCollector = undefined;
      }
    } catch (error) {
      this.config.logger?.error("Error during cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
