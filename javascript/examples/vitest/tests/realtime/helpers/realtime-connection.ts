import { RealtimeSession } from "@openai/agents/realtime";
import type { RealtimeAgent } from "@openai/agents/realtime";
import type { RealtimeAgentAdapterConfig } from "./realtime-agent-adapter.js";
import { AGENT_CONFIG } from "../agents/vegetatrian-recipe.agent.js";

/**
 * Manages Realtime API connection lifecycle
 *
 * This class is responsible for establishing and managing connections to the
 * OpenAI Realtime API, ensuring proper setup and cleanup of sessions.
 */
export class RealtimeConnection {
  private session: RealtimeSession | null = null;

  /**
   * Creates a new RealtimeConnection instance
   * @param config - Configuration for the realtime agent adapter
   */
  constructor(private config: RealtimeAgentAdapterConfig) {}

  /**
   * Establishes connection to the Realtime API
   *
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    if (this.session) {
      console.warn(`⚠️  ${this.config.agent.name} already connected`);
      return;
    }

    try {
      this.session = new RealtimeSession(this.config.agent, {
        model: AGENT_CONFIG.model,
      });

      await this.session.connect({ apiKey: this.config.apiKey });

      console.log(`✅ ${this.config.agent.name} connected`);
    } catch (error) {
      console.error(`❌ Failed to connect ${this.config.agent.name}:`, error);
      throw error;
    }
  }

  /**
   * Closes the connection to the Realtime API
   */
  async disconnect(): Promise<void> {
    if (this.session) {
      // @ts-ignore - close method exists in 0.3.0
      await this.session.close();
      this.session = null;
      console.log(`👋 ${this.config.agent.name} disconnected`);
    }
  }

  /**
   * Gets the current RealtimeSession instance
   * @returns The active session or null if not connected
   */
  getSession(): RealtimeSession | null {
    return this.session;
  }

  /**
   * Checks if the connection is currently active
   * @returns True if connected, false otherwise
   */
  isConnected(): boolean {
    return this.session !== null;
  }
}
