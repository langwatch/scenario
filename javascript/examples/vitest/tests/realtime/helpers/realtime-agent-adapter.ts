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
import type { AssistantModelMessage } from "ai";
import { RealtimeSession } from "@openai/agents/realtime";
import type { RealtimeAgent } from "@openai/agents/realtime";
import { AGENT_CONFIG } from "../shared/vegetarian-recipe-agent.js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

/**
 * Configuration for RealtimeAgentAdapter
 */
export interface RealtimeAgentAdapterConfig {
  /**
   * The RealtimeAgent instance (from shared configuration)
   */
  agent: RealtimeAgent;

  /**
   * OpenAI API key for direct connection (recommended for testing)
   * If provided, connects directly without ephemeral token server
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
  private currentAudioChunks: string[] = [];
  private responseResolver:
    | ((value: { transcript: string; audio: string }) => void)
    | null = null;
  private errorRejecter: ((error: Error) => void) | null = null;

  constructor(private config: RealtimeAgentAdapterConfig) {
    super();
  }

  /**
   * Connects to the Realtime API
   *
   * Supports two connection modes:
   * 1. Direct API key (recommended for testing)
   * 2. Ephemeral token via token server (for production/browser)
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

    try {
      // Create session with the SAME agent as browser
      this.session = new RealtimeSession(this.config.agent, {
        model: AGENT_CONFIG.model,
      });

      // Set up event listeners
      this.setupEventListeners();

      // Connect with API key (direct or ephemeral token)
      await this.session.connect({ apiKey: this.config.apiKey });

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
   * Handles both text and audio input, returns audio message with transcript.
   *
   * @param input - Scenario agent input with message history
   * @returns Agent response as audio message or text
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
      const transport = (this.session as any).transport;

      if (!transport) {
        throw new Error("Realtime transport not available");
      }

      transport.sendEvent({
        type: "response.create",
      });

      const timeout = this.config.responseTimeout ?? 60000;
      const response = await this.waitForResponse(timeout);

      return {
        role: "assistant",
        content: [
          { type: "text", text: response.transcript },
          { type: "file", mediaType: "audio/pcm16", data: response.audio },
        ],
      } as AssistantModelMessage;
    }

    // Check if message contains audio
    if (Array.isArray(latestMessage.content)) {
      for (const part of latestMessage.content) {
        // Handle both PCM16 (from user simulator) and WAV formats
        if (part.type === "file" && part.mediaType?.startsWith("audio/")) {
          // Type guard: ensure data is a string (base64)
          if (typeof part.data !== "string") {
            throw new Error(
              `Audio data must be base64 string, got: ${typeof part.data}`
            );
          }

          console.log(`🎤 Received audio part:`, {
            mediaType: part.mediaType,
            hasData: !!part.data,
            dataLength: part.data.length,
            dataType: typeof part.data,
            dataPreview: part.data.substring(0, 50),
          });

          // Validate we have audio data
          if (!part.data || part.data.length === 0) {
            console.error(
              "❌ Audio part structure:",
              JSON.stringify(part, null, 2)
            );
            throw new Error(
              `Audio message has no data. Part: ${JSON.stringify(part)}`
            );
          }

          console.log(
            `🎤 Sending ${part.data.length} chars of base64 ${part.mediaType} to Realtime agent`
          );

          // Use transport layer to send audio directly as base64 (avoids SDK ArrayBuffer conversion)
          // Per https://openai.github.io/openai-agents-js/guides/voice-agents/transport/#option-1---accessing-the-transport-layer
          const transport = (this.session as any).transport;

          // Append audio to input buffer (audio is already base64)
          transport.sendEvent({
            type: "input_audio_buffer.append",
            audio: part.data,
          });
          console.log(`✅ Audio appended to input buffer`);

          // Commit the audio buffer
          transport.sendEvent({
            type: "input_audio_buffer.commit",
          });
          console.log(`✅ Audio buffer committed`);

          // Trigger response generation
          transport.sendEvent({
            type: "response.create",
          });
          console.log(`✅ Response generation triggered`);

          // Wait for audio response (increased timeout for voice processing)
          const timeout = this.config.responseTimeout ?? 60000;
          const response = await this.waitForResponse(timeout);

          console.log(`🔊 Received audio response: "${response.transcript}"`);

          // Return audio message with PCM16 format (matching user simulator)
          return {
            role: "assistant",
            content: [
              { type: "text", text: response.transcript },
              { type: "file", mediaType: "audio/pcm16", data: response.audio },
            ],
          } as AssistantModelMessage;
        }
      }
    }

    // Fallback: text input
    const text =
      typeof latestMessage.content === "string" ? latestMessage.content : "";

    if (!text) {
      throw new Error("Message has no text or audio content");
    }

    console.log(`📤 Sending text to Realtime agent: "${text}"`);

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

    console.log(`📥 Received from Realtime agent: "${response.transcript}"`);

    // Return as text for Scenario framework
    return response.transcript;
  }

  /**
   * Sets up event listeners for the RealtimeSession
   */
  private setupEventListeners(): void {
    if (!this.session) return;

    // Use transport layer for raw WebSocket events
    // Per https://openai.github.io/openai-agents-js/guides/voice-agents/transport/#option-1---accessing-the-transport-layer
    const transport = (this.session as any).transport;

    if (!transport) {
      console.error("❌ Transport not available on session");
      return;
    }

    // Listen to all events for debugging
    transport.on("*", (event: any) => {
      console.log(`🔔 Transport event: ${event.type}`);
    });

    // Listen for audio transcript deltas (CORRECT event name from API)
    transport.on("response.output_audio_transcript.delta", (event: any) => {
      if (event.delta) {
        this.currentResponse += event.delta;
        console.log(`📝 Transcript delta: "${event.delta}"`);
      }
    });

    // Listen for audio deltas (CORRECT event name from API)
    transport.on("response.output_audio.delta", (event: any) => {
      if (event.delta) {
        this.currentAudioChunks.push(event.delta);
        console.log(`🔊 Audio delta: ${event.delta.length} bytes`);
      }
    });

    // Listen for response completion
    transport.on("response.done", (event: any) => {
      console.log(`✅ Response complete: transcript="${this.currentResponse}"`);

      if (this.responseResolver) {
        const fullAudio = this.currentAudioChunks.join("");
        this.responseResolver({
          transcript: this.currentResponse,
          audio: fullAudio,
        });
        this.responseResolver = null;
        this.errorRejecter = null;
      }

      // Reset for next response
      this.currentResponse = "";
      this.currentAudioChunks = [];
    });

    // Handle errors
    transport.on("error", (error: any) => {
      console.error("❌ Transport error:", error);
      if (this.errorRejecter) {
        this.errorRejecter(error);
        this.responseResolver = null;
        this.errorRejecter = null;
      }
    });
  }

  /**
   * Waits for the agent's response with timeout
   *
   * @param timeout - Maximum time to wait (ms)
   * @returns Agent's transcript and audio data
   * @throws {Error} If timeout or error occurs
   */
  private waitForResponse(
    timeout: number
  ): Promise<{ transcript: string; audio: string }> {
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
      this.responseResolver = (value: {
        transcript: string;
        audio: string;
      }) => {
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

  /**
   * Converts base64 string to ArrayBuffer (Node.js-optimized)
   * @param base64 - Base64 encoded string
   * @returns ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const buffer = Buffer.from(base64, "base64");
    // Use Node.js buffer's underlying ArrayBuffer
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    return ab;
  }
}
