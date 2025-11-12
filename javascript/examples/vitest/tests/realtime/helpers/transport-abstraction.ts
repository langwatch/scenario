/**
 * Transport Abstraction Layer
 *
 * Abstracts the OpenAI Realtime transport layer to provide a clean interface
 * for WebSocket events and message sending. Decouples the session manager
 * from the specific transport implementation.
 */

import type { RealtimeMessage, TransportEvent, AudioResponse } from "./types.js";
import type { Logger } from "./logger.js";
import type { DefaultResponseCollector } from "./response-collector.js";

export interface TransportAbstraction {
  /**
   * Connects to the transport layer
   */
  connect(): Promise<void>;

  /**
   * Disconnects from the transport layer
   */
  disconnect(): Promise<void>;

  /**
   * Sends a message through the transport
   */
  sendMessage(message: RealtimeMessage): Promise<void>;

  /**
   * Checks if the transport is connected
   */
  isConnected(): boolean;

  /**
   * Registers a response collector to handle incoming events
   */
  registerResponseCollector(collector: DefaultResponseCollector): void;
}

export interface TransportAbstractionConfig {
  /** Logger for transport events */
  logger?: Logger;

  /** Enable debug logging of all transport events */
  debugEvents?: boolean;
}

/**
 * OpenAI Realtime Transport Implementation
 *
 * Wraps the OpenAI agents-realtime transport layer with proper error handling
 * and event forwarding to the response collector.
 */
export class OpenAITransportAbstraction implements TransportAbstraction {
  private transport: any = null;
  private responseCollector?: DefaultResponseCollector;
  private isConnectedFlag = false;

  constructor(
    private session: any, // RealtimeSession from @openai/agents/realtime
    private config: TransportAbstractionConfig = {}
  ) {}

  async connect(): Promise<void> {
    if (this.isConnectedFlag) {
      this.config.logger?.warn("Transport already connected");
      return;
    }

    try {
      this.transport = this.session.transport;
      if (!this.transport) {
        throw new Error("Transport not available on session");
      }

      this.setupEventListeners();
      this.isConnectedFlag = true;
      this.config.logger?.info("Transport abstraction connected");
    } catch (error) {
      this.config.logger?.error("Failed to connect transport abstraction", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnectedFlag) {
      return;
    }

    try {
      // Clean up event listeners
      if (this.transport) {
        this.transport.removeAllListeners();
      }

      this.isConnectedFlag = false;
      this.config.logger?.info("Transport abstraction disconnected");
    } catch (error) {
      this.config.logger?.error("Error during transport disconnection", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sendMessage(message: RealtimeMessage): Promise<void> {
    if (!this.isConnectedFlag || !this.transport) {
      throw new Error("Transport not connected");
    }

    try {
      switch (message.type) {
        case "text":
          this.config.logger?.debug("Sending text message", {
            length: message.content.length,
          });
          // Use the SDK's sendMessage method if available, otherwise fall back to transport
          if (this.session.sendMessage) {
            await this.session.sendMessage(message.content);
          } else {
            this.transport.sendEvent({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: message.content }],
              },
            });
            this.transport.sendEvent({ type: "response.create" });
          }
          break;

        case "audio":
          this.config.logger?.debug("Sending audio message", {
            dataLength: message.content.length,
          });
          // Send audio buffer
          this.transport.sendEvent({
            type: "input_audio_buffer.append",
            audio: message.content,
          });
          this.transport.sendEvent({
            type: "input_audio_buffer.commit",
          });
          this.transport.sendEvent({
            type: "response.create",
          });
          break;

        default:
          throw new Error(`Unsupported message type: ${(message as any).type}`);
      }
    } catch (error) {
      this.config.logger?.error("Failed to send message", {
        type: message.type,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag;
  }

  registerResponseCollector(collector: DefaultResponseCollector): void {
    this.responseCollector = collector;
    this.config.logger?.debug("Response collector registered");
  }

  private setupEventListeners(): void {
    if (!this.transport) return;

    // Debug all events if enabled
    if (this.config.debugEvents) {
      this.transport.on("*", (event: any) => {
        this.config.logger?.debug(`Transport event: ${event.type}`, event);
      });
    }

    // Handle audio transcript deltas
    this.transport.on("response.output_audio_transcript.delta", (event: any) => {
      if (event.delta && this.responseCollector) {
        this.responseCollector.collect({ delta: event.delta });
      }
    });

    // Handle audio deltas
    this.transport.on("response.output_audio.delta", (event: any) => {
      if (event.delta && this.responseCollector) {
        this.responseCollector.collect({ delta: event.delta });
      }
    });

    // Handle response completion
    this.transport.on("response.done", (event: any) => {
      this.config.logger?.debug("Response done event received");
      if (this.responseCollector) {
        this.responseCollector.completeResponse();
      }
    });

    // Handle errors
    this.transport.on("error", (error: any) => {
      this.config.logger?.error("Transport error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.responseCollector) {
        this.responseCollector.failResponse(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    this.config.logger?.debug("Transport event listeners setup complete");
  }
}
