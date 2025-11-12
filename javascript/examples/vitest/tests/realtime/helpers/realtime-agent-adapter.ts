/**
 * Realtime Agent Adapter for Scenario Testing
 *
 * Connects Scenario framework to a RealtimeSession using the exact same
 * agent configuration as the browser client.
 *
 * This ensures we test the REAL agent, not a mock.
 */

import {
  AgentAdapter,
  AgentInput,
  AgentRole,
  type AgentReturnTypes,
} from "@langwatch/scenario";
import { RealtimeSession } from "@openai/agents/realtime";
import type { RealtimeAgent } from "@openai/agents/realtime";
import { AGENT_CONFIG } from "../shared/vegetarian-recipe-agent.js";

/**
 * Configuration for RealtimeAgentAdapter
 */
export interface RealtimeAgentAdapterConfig {
  /**
   * The RealtimeAgent instance (from shared configuration)
   */
  agent: RealtimeAgent;

  /**
   * URL of the ephemeral token server
   * @default "http://localhost:3000"
   */
  tokenServerUrl?: string;

  /**
   * Timeout for waiting for agent response (ms)
   * @default 30000
   */
  responseTimeout?: number;
}

/**
 * Adapter that connects Scenario testing framework to OpenAI Realtime API
 *
 * This adapter:
 * - Uses the SAME agent configuration as the browser client
 * - Connects via ephemeral tokens (same as browser)
 * - Handles turn-based conversation for testing
 * - Returns CoreMessage format for Scenario
 *
 * @example
 * ```typescript
 * const agent = createVegetarianRecipeAgent();
 * const adapter = new RealtimeAgentAdapter({ agent });
 *
 * // In beforeAll
 * await adapter.connect();
 *
 * // In test
 * await scenario.run({
 *   agents: [adapter, scenario.userSimulatorAgent()],
 *   script: [scenario.user("quick recipe"), scenario.agent()]
 * });
 *
 * // In afterAll
 * await adapter.disconnect();
 * ```
 */
export class RealtimeAgentAdapter extends AgentAdapter {
  role = AgentRole.AGENT;

  private session: RealtimeSession | null = null;
  private currentResponse: string = "";
  private responseResolver: ((value: string) => void) | null = null;
  private errorRejecter: ((error: Error) => void) | null = null;

  constructor(private config: RealtimeAgentAdapterConfig) {
    super();
  }

  /**
   * Connects to the Realtime API via ephemeral token
   *
   * Call this once before running tests (e.g., in beforeAll)
   *
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    if (this.session) {
      console.warn("⚠️  RealtimeAgentAdapter already connected");
      return;
    }

    const tokenServerUrl =
      this.config.tokenServerUrl ?? "http://localhost:3000";

    try {
      // Fetch ephemeral token from server
      console.log("🔑 Fetching ephemeral token for test...");
      const tokenResponse = await fetch(`${tokenServerUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!tokenResponse.ok) {
        throw new Error(`Failed to fetch token: ${tokenResponse.statusText}`);
      }

      const { token } = await tokenResponse.json();
      console.log("✅ Token received for test");

      // Create session with the SAME agent as browser
      this.session = new RealtimeSession(this.config.agent, {
        model: AGENT_CONFIG.model,
      });

      // Set up event listeners
      this.setupEventListeners();

      // Connect with ephemeral token
      await this.session.connect({ apiKey: token });

      console.log("✅ RealtimeAgentAdapter connected");
    } catch (error) {
      console.error("❌ Failed to connect RealtimeAgentAdapter:", error);
      throw error;
    }
  }

  /**
   * Disconnects from the Realtime API
   *
   * Call this once after tests complete (e.g., in afterAll)
   */
  async disconnect(): Promise<void> {
    if (this.session) {
      // @ts-ignore - close method exists in 0.3.0
      await this.session.close();
      this.session = null;
      console.log("👋 RealtimeAgentAdapter disconnected");
    }
  }

  /**
   * Process input and generate response (implements AgentAdapter interface)
   *
   * This is called by Scenario framework for each agent turn.
   * We send a text message and wait for the agent's audio+transcript response.
   *
   * @param input - Scenario agent input with message history
   * @returns Agent response as text (transcript from audio response)
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!this.session) {
      throw new Error(
        "RealtimeAgentAdapter not connected. Call connect() first."
      );
    }

    // Get the latest user message
    const latestMessage = input.newMessages[input.newMessages.length - 1];

    if (!latestMessage) {
      throw new Error("No message to process");
    }

    // Extract text content
    const text =
      typeof latestMessage.content === "string" ? latestMessage.content : "";

    if (!text) {
      throw new Error("Message has no text content");
    }

    console.log(`📤 Sending to Realtime agent: "${text}"`);

    // In SDK 0.3.0, use sendMessage method
    try {
      // @ts-ignore - sendMessage exists but might not be in types yet
      await this.session.sendMessage(text);
    } catch (sendError) {
      console.error("❌ Failed to send message:", sendError);
      throw sendError;
    }

    // Wait for response with timeout
    const timeout = this.config.responseTimeout ?? 30000;
    const response = await this.waitForResponse(timeout);

    console.log(`📥 Received from Realtime agent: "${response}"`);

    // Return as text for Scenario framework
    // The judge and user simulator will process this text
    return response;
  }

  /**
   * Sets up event listeners for the RealtimeSession
   */
  private setupEventListeners(): void {
    if (!this.session) return;

    // Accumulate transcript as it arrives
    this.session.on("response:transcript:delta", (event: any) => {
      this.currentResponse += event.delta;
    });

    // Response complete - resolve promise
    this.session.on("response:transcript:done", (event: any) => {
      const fullTranscript = event.transcript;

      if (this.responseResolver) {
        this.responseResolver(fullTranscript);
        this.responseResolver = null;
        this.errorRejecter = null;
      }

      // Reset for next response
      this.currentResponse = "";
    });

    // Handle errors
    this.session.on("error", (error: any) => {
      console.error("❌ RealtimeSession error:", error);

      if (this.errorRejecter) {
        this.errorRejecter(
          error instanceof Error ? error : new Error(String(error))
        );
        this.responseResolver = null;
        this.errorRejecter = null;
      }
    });

    // Log voice activity for debugging
    this.session.on("input_audio_buffer.speech_started", () => {
      console.log("🎤 [Test] Speech detected");
    });

    this.session.on("response.audio.delta", () => {
      // Agent is speaking (we get transcript via response:transcript:delta)
    });
  }

  /**
   * Waits for the agent's response with timeout
   *
   * @param timeout - Maximum time to wait (ms)
   * @returns Agent's transcript
   * @throws {Error} If timeout or error occurs
   */
  private waitForResponse(timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.responseResolver = resolve;
      this.errorRejecter = reject;

      // Timeout handler
      const timeoutId = setTimeout(() => {
        if (this.responseResolver) {
          this.responseResolver = null;
          this.errorRejecter = null;
          reject(new Error(`Agent response timeout after ${timeout}ms`));
        }
      }, timeout);

      // Clear timeout when resolved
      const originalResolver = resolve;
      this.responseResolver = (value: string) => {
        clearTimeout(timeoutId);
        originalResolver(value);
      };
    });
  }

  /**
   * Checks if the adapter is currently connected
   */
  isConnected(): boolean {
    return this.session !== null;
  }
}
