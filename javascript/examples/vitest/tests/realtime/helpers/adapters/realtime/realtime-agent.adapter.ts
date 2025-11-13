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
import type { RealtimeAgent } from "@openai/agents/realtime";
import { RealtimeConnection } from "./realtime-connection.js";
import { RealtimeEventHandler } from "./realtime-event-handler.js";
import { MessageProcessor } from "./message-processor.js";
import { ResponseFormatter } from "./response-formatter.js";
import { EventEmitter } from "events";

/**
 * Configuration for RealtimeAgentAdapter
 */
export interface RealtimeAgentAdapterConfig {
  /**
   * The role of the agent
   */
  role: AgentRole;
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
 * Event emitted when an audio response is completed
 */
export interface AudioResponseEvent {
  transcript: string;
  audio: string;
}

/**
 * Adapter that connects Scenario testing framework to OpenAI Realtime API
 *
 * This adapter uses composition of focused classes to provide a clean interface
 * for testing Realtime agents. It maintains the same agent configuration as the
 * browser client to ensure accurate testing of the real agent implementation.
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
  role!: AgentRole;

  private connection: RealtimeConnection;
  private eventHandler: RealtimeEventHandler | null = null;
  private messageProcessor = new MessageProcessor();
  private responseFormatter = new ResponseFormatter();
  private audioEvents = new EventEmitter();

  /**
   * Creates a new RealtimeAgentAdapter instance
   * @param config - Configuration for the realtime agent adapter
   */
  constructor(private config: RealtimeAgentAdapterConfig) {
    super();
    this.role = this.config.role;
    this.connection = new RealtimeConnection(config);
  }

  /**
   * Gets the name of the agent
   */
  get name(): string {
    return this.config.agent.name;
  }

  /**
   * Connects to the Realtime API
   *
   * Call this once before running tests (e.g., in beforeAll)
   *
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    await this.connection.connect();

    // Create event handler after connection is established
    const session = this.connection.getSession();
    if (session) {
      this.eventHandler = new RealtimeEventHandler(session);
    }
  }

  /**
   * Disconnects from the Realtime API
   *
   * Call this once after tests complete (e.g., in afterAll)
   */
  async disconnect(): Promise<void> {
    await this.connection.disconnect();
    this.eventHandler = null;
  }

  /**
   * Checks if the adapter is currently connected
   */
  isConnected(): boolean {
    return this.connection.isConnected();
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
    console.log(`🔊 ${this.name} being called with role: ${this.role}`);

    if (!this.connection.isConnected() || !this.eventHandler) {
      throw new Error(
        "RealtimeAgentAdapter not connected. Call connect() first."
      );
    }

    const latestMessage = input.newMessages[input.newMessages.length - 1];

    if (!latestMessage) {
      return this.handleInitialResponse();
    }

    const audioData = this.messageProcessor.processAudioMessage(
      latestMessage.content
    );
    if (audioData) {
      return this.handleAudioInput(audioData);
    }

    const text = this.messageProcessor.extractTextMessage(
      latestMessage.content
    );
    if (!text) {
      throw new Error("Message has no text or audio content");
    }

    return this.handleTextInput(text);
  }

  /**
   * Handles the initial response when no user message exists
   */
  private async handleInitialResponse(): Promise<AssistantModelMessage> {
    console.log(`[${this.name}] First message, creating response`);

    const session = this.connection.getSession();
    if (!session) {
      throw new Error("Realtime session not available");
    }

    const transport = (session as any).transport;
    if (!transport) {
      throw new Error("Realtime transport not available");
    }

    transport.sendEvent({
      type: "response.create",
    });

    const timeout = this.config.responseTimeout ?? 60000;
    const response = await this.eventHandler!.waitForResponse(timeout);

    console.log(`🔊 ${this.name} response: "${response.transcript}"`);

    return this.responseFormatter.formatInitialResponse(response);
  }

  /**
   * Handles audio input from the user
   */
  private async handleAudioInput(
    audioData: string
  ): Promise<AssistantModelMessage> {
    const session = this.connection.getSession();
    if (!session) {
      throw new Error("Realtime session not available");
    }

    const transport = (session as any).transport;

    // Append audio to input buffer
    transport.sendEvent({
      type: "input_audio_buffer.append",
      audio: audioData,
    });

    // Commit the audio buffer
    transport.sendEvent({
      type: "input_audio_buffer.commit",
    });

    // Trigger response generation
    transport.sendEvent({
      type: "response.create",
    });

    // Wait for audio response
    const timeout = this.config.responseTimeout ?? 60000;
    const response = await this.eventHandler!.waitForResponse(timeout);

    console.log(`🔊 ${this.name} response: "${response.transcript}"`);

    return this.responseFormatter.formatAudioResponse(response);
  }

  /**
   * Handles text input from the user
   */
  private async handleTextInput(text: string): Promise<string> {
    const session = this.connection.getSession();
    if (!session) {
      throw new Error("Realtime session not available");
    }

    await session.sendMessage(text);

    // Wait for response
    const timeout = this.config.responseTimeout ?? 30000;
    const response = await this.eventHandler!.waitForResponse(timeout);

    return this.responseFormatter.formatTextResponse(response.transcript);
  }

  /**
   * Subscribe to audio response events
   *
   * @param callback - Function called when an audio response completes
   */
  onAudioResponse(callback: (event: AudioResponseEvent) => void): void {
    this.audioEvents.on("audioResponse", callback);
  }

  /**
   * Remove audio response listener
   *
   * @param callback - The callback function to remove
   */
  offAudioResponse(callback: (event: AudioResponseEvent) => void): void {
    this.audioEvents.off("audioResponse", callback);
  }
}
