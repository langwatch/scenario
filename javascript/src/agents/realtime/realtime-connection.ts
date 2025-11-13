import { RealtimeSession } from "@openai/agents/realtime";
import type { RealtimeAgent } from "@openai/agents/realtime";

/**
 * Configuration for RealtimeConnection
 */
interface RealtimeConnectionConfig {
  agent: RealtimeAgent;
  model?: string;
  apiKey?: string;
}

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
   * @param config - Configuration for the realtime connection
   */
  constructor(private config: RealtimeConnectionConfig) {}

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
      const model = this.config.model ?? "gpt-4o-realtime-preview-2024-12-17";
      this.session = new RealtimeSession(this.config.agent, {
        model: model as string,
      });

      const apiKey = this.config.apiKey;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required");
      }
      await this.session.connect({ apiKey });

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
      this.session.close();
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
