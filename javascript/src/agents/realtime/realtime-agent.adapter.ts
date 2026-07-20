/**
 * Realtime Agent Adapter for Scenario Testing
 *
 * Adapts a connected RealtimeSession to the Scenario framework interface.
 * The session must be created and connected before passing to this adapter.
 *
 * This ensures we test the REAL agent, not a mock, using the same session
 * creation pattern as the browser client.
 */

import { EventEmitter } from "events";
import type { RealtimeSession } from "@openai/agents/realtime";
import type { AssistantModelMessage } from "ai";
import { MessageProcessor } from "./message-processor";
import {
  RealtimeEventHandler,
  type AudioResponseEvent,
} from "./realtime-event-handler";
import { ResponseFormatter } from "./response-formatter";
import type { AgentInput, AgentReturnTypes, AgentRole } from "../../domain";
import { AgentAdapter } from "../../domain/agents";
import { Logger } from "../../utils/logger";

/**
 * Configuration for RealtimeAgentAdapter
 */
export interface RealtimeAgentAdapterConfig {
  /**
   * The role of the agent
   */
  role: AgentRole;

  /**
   * A connected RealtimeSession instance
   *
   * The session should be created using your agent's session creator function
   * and connected before passing to this adapter.
   *
   * @example
   * ```typescript
   * const session = createVegetarianRecipeSession();
   * await session.connect({ apiKey: process.env.OPENAI_API_KEY });
   * const adapter = new RealtimeAgentAdapter({
   *   session,
   *   role: AgentRole.AGENT,
   *   agentName: "Vegetarian Recipe Assistant"
   * });
   * ```
   */
  session: RealtimeSession;

  /**
   * Name of the agent (for logging/identification)
   */
  agentName: string;

  /**
   * Timeout for waiting for agent response (ms)
   * @default 30000
   */
  responseTimeout?: number;
}

/**
 * Adapter that connects Scenario testing framework to OpenAI Realtime API
 *
 * This adapter wraps a connected RealtimeSession to provide the Scenario
 * framework interface. The session must be created and connected externally,
 * ensuring the same session creation pattern is used in both browser and tests.
 *
 * @example
 * ```typescript
 * // In beforeAll
 * const session = createVegetarianRecipeSession();
 * await session.connect({ apiKey: process.env.OPENAI_API_KEY });
 * const adapter = new RealtimeAgentAdapter({
 *   session,
 *   role: AgentRole.AGENT
 * });
 *
 * // In test
 * await scenario.run({
 *   agents: [adapter, scenario.userSimulatorAgent()],
 *   script: [scenario.user("quick recipe"), scenario.agent()]
 * });
 *
 * // In afterAll
 * session.close();
 * ```
 */
export class RealtimeAgentAdapter extends AgentAdapter {
  role: AgentRole;
  name: string;

  private session: RealtimeSession;
  private eventHandler: RealtimeEventHandler;
  private messageProcessor = new MessageProcessor();
  private responseFormatter = new ResponseFormatter();
  private audioEvents = new EventEmitter();
  private readonly logger = new Logger("RealtimeAgentAdapter");

  /**
   * Creates a new RealtimeAgentAdapter instance
   *
   * The session can be either connected or unconnected.
   * If unconnected, call connect() with an API key before use.
   *
   * @param config - Configuration for the realtime agent adapter
   */
  constructor(private config: RealtimeAgentAdapterConfig) {
    super();
    this.role = this.config.role;
    this.name = this.config.agentName;
    this.session = config.session;
    this.eventHandler = new RealtimeEventHandler(this.session);
  }

  /**
   * Get the connect method from the session
   */
  async connect(
    params?: Parameters<RealtimeSession["connect"]>[0] | undefined
  ): Promise<void> {
    const { apiKey, ...rest } = params ?? {};
    const resolvedApiKey = apiKey ?? process.env.OPENAI_API_KEY;
    if (!resolvedApiKey) {
      throw new Error(
        "RealtimeAgentAdapter.connect requires an API key: pass params.apiKey or set OPENAI_API_KEY.",
      );
    }
    await this.session.connect({
      apiKey: resolvedApiKey,
      ...rest,
    });
  }

  /**
   * Closes the session connection
   */
  async disconnect(): Promise<void> {
    this.session.close();
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
    this.logger.debug(`[${this.name}] being called with role: ${this.role}`);

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
    this.logger.debug(`[${this.name}] First message, creating response`);

    const sessionWithTransport = this.session as RealtimeSession & {
      transport?: {
        sendEvent: (event: { type: string; [key: string]: unknown }) => void;
      };
    };

    const transport = sessionWithTransport.transport;
    if (!transport) {
      throw new Error("Realtime transport not available");
    }

    if (!this.eventHandler.isResponseActive()) {
      transport.sendEvent({
        type: "response.create",
      });
    }

    const timeout = this.config.responseTimeout ?? 60000;
    const response = await this.eventHandler.waitForResponse(timeout);

    // Emit audio response event
    this.audioEvents.emit("audioResponse", response);

    return this.responseFormatter.formatInitialResponse(response);
  }

  /**
   * Handles audio input from the user
   */
  private async handleAudioInput(
    audioData: string
  ): Promise<AssistantModelMessage> {
    const sessionWithTransport = this.session as RealtimeSession & {
      transport?: {
        sendEvent: (event: { type: string; [key: string]: unknown }) => void;
      };
    };

    const transport = sessionWithTransport.transport;
    if (!transport) {
      throw new Error("Realtime transport not available");
    }

    // Append audio to input buffer
    transport.sendEvent({
      type: "input_audio_buffer.append",
      audio: audioData,
    });

    // Commit the audio buffer
    transport.sendEvent({
      type: "input_audio_buffer.commit",
    });

    // Trigger response generation — guard against active-response race
    if (!this.eventHandler.isResponseActive()) {
      transport.sendEvent({
        type: "response.create",
      });
    }

    // Wait for audio response
    const timeout = this.config.responseTimeout ?? 60000;
    const response = await this.eventHandler.waitForResponse(timeout);

    // Emit audio response event
    this.audioEvents.emit("audioResponse", response);

    return this.responseFormatter.formatAudioResponse(response);
  }

  /**
   * Handles text input from the user
   */
  private async handleTextInput(text: string): Promise<string> {
    this.session.sendMessage(text);

    // Wait for response
    const timeout = this.config.responseTimeout ?? 30000;
    const response = await this.eventHandler.waitForResponse(timeout);

    // Emit audio response event (Realtime API always responds with audio, even for text input)
    this.audioEvents.emit("audioResponse", response);

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
