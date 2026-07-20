import type { RealtimeSession } from "@openai/agents/realtime";

import { Logger } from "../../utils/logger";

/**
 * Event emitted when an audio response is completed
 */
export interface AudioResponseEvent {
  transcript: string;
  audio: string;
}

/**
 * Transport interface for RealtimeSession events
 */
interface RealtimeTransport {
  on(event: string, callback: (data: unknown) => void): void;
  sendEvent(event: { type: string; [key: string]: unknown }): void;
}

/**
 * RealtimeSession with transport access
 */
type RealtimeSessionWithTransport = RealtimeSession & {
  transport?: RealtimeTransport;
};

/**
 * Delta event structure from Realtime API
 */
interface DeltaEvent {
  delta?: string;
  [key: string]: unknown;
}

/**
 * Handles event parsing and response collection from Realtime API
 *
 * This class manages the complex event-driven response collection from the
 * Realtime API, ensuring proper assembly of audio and text responses.
 */
export class RealtimeEventHandler {
  private currentResponse = "";
  private currentAudioChunks: string[] = [];
  private responseResolver: ((value: AudioResponseEvent) => void) | null = null;
  private errorRejecter: ((error: Error) => void) | null = null;
  private listenersSetup = false;
  private readonly logger = new Logger("RealtimeEventHandler");
  private _active = false;

  /**
   * Creates a new RealtimeEventHandler instance
   * @param session - The RealtimeSession to listen to events from
   */
  constructor(private session: RealtimeSession) {
    // Set up event listeners - transport may not be available yet
    this.ensureEventListeners();
  }

  /**
   * Gets the transport from the session
   */
  private getTransport(): RealtimeTransport | null {
    const sessionWithTransport = this.session as RealtimeSessionWithTransport;
    return sessionWithTransport.transport ?? null;
  }

  /**
   * Ensures event listeners are set up, retrying if transport not available
   */
  private ensureEventListeners(): void {
    if (this.listenersSetup) return;

    const transport = this.getTransport();

    if (!transport) {
      // Transport not available yet, try again in a bit
      setTimeout(() => this.ensureEventListeners(), 100);
      return;
    }

    this.setupEventListeners();
  }

  /**
   * Sets up event listeners for the RealtimeSession transport layer
   */
  private setupEventListeners(): void {
    if (this.listenersSetup) return;

    const transport = this.getTransport();

    if (!transport) {
      this.logger.error("Transport not available on session");
      return;
    }

    // Listen for audio transcript deltas
    transport.on("response.output_audio_transcript.delta", (event: unknown) => {
      const deltaEvent = event as DeltaEvent;
      if (typeof deltaEvent.delta === "string") {
        this.currentResponse += deltaEvent.delta;
      }
    });

    // Listen for audio deltas
    transport.on("response.output_audio.delta", (event: unknown) => {
      const deltaEvent = event as DeltaEvent;
      if (typeof deltaEvent.delta === "string") {
        this.currentAudioChunks.push(deltaEvent.delta);
      }
    });

    // Track response lifecycle — set on response.created, clear on response.done/cancelled
    transport.on("response.created", () => {
      this._active = true;
    });

    transport.on("response.cancelled", () => {
      this._active = false;
    });

    // Listen for response completion
    transport.on("response.done", () => {
      this._active = false;
      const fullAudio = this.currentAudioChunks.join("");
      const audioResponse: AudioResponseEvent = {
        transcript: this.currentResponse,
        audio: fullAudio,
      };

      if (this.responseResolver) {
        this.responseResolver(audioResponse);
        this.reset();
      }
    });

    // Handle transport errors
    transport.on("error", (error: unknown) => {
      this.logger.error("Transport error", error);
      if (this.errorRejecter) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        this.errorRejecter(errorObj);
        this.reset();
      }
    });

    this.listenersSetup = true;
  }

  /**
   * Waits for the agent response with timeout
   *
   * @param timeout - Maximum time to wait in milliseconds
   * @returns Promise that resolves with the audio response event
   * @throws {Error} If timeout occurs or transport error happens
   */
  waitForResponse(timeout: number): Promise<AudioResponseEvent> {
    return new Promise((resolve, reject) => {
      this.responseResolver = resolve;
      this.errorRejecter = reject;

      const timeoutId = setTimeout(() => {
        if (this.responseResolver) {
          this.reset();
          reject(new Error(`Agent response timeout after ${timeout}ms`));
        }
      }, timeout);

      // Clear timeout when resolved
      const originalResolver = resolve;
      this.responseResolver = (value: AudioResponseEvent) => {
        clearTimeout(timeoutId);
        originalResolver(value);
      };
    });
  }

  /**
   * Resets the internal state for the next response
   */
  private reset(): void {
    this._active = false;
    this.responseResolver = null;
    this.errorRejecter = null;
    this.currentResponse = "";
    this.currentAudioChunks = [];
  }

  /**
   * Returns true while a response is in flight (between response.created
   * and response.done). Used by RealtimeAgentAdapter to guard response.create.
   */
  isResponseActive(): boolean {
    return this._active;
  }
}
