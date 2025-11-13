import type { RealtimeSession } from "@openai/agents/realtime";
import type { AudioResponseEvent } from "./realtime-agent-adapter.js";

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

  /**
   * Creates a new RealtimeEventHandler instance
   * @param session - The RealtimeSession to listen to events from
   */
  constructor(private session: RealtimeSession) {
    // Set up event listeners - transport may not be available yet
    this.ensureEventListeners();
  }

  /**
   * Ensures event listeners are set up, retrying if transport not available
   */
  private ensureEventListeners(): void {
    if (this.listenersSetup) return;

    const transport = (this.session as any).transport;

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

    const transport = (this.session as any).transport;

    if (!transport) {
      console.error("❌ Transport not available on session");
      return;
    }

    // Listen for audio transcript deltas
    transport.on("response.output_audio_transcript.delta", (event: any) => {
      if (event.delta) {
        this.currentResponse += event.delta;
      }
    });

    // Listen for audio deltas
    transport.on("response.output_audio.delta", (event: any) => {
      if (event.delta) {
        this.currentAudioChunks.push(event.delta);
      }
    });

    // Listen for response completion
    transport.on("response.done", () => {
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
    transport.on("error", (error: any) => {
      console.error(`❌ Transport error:`, error);
      if (this.errorRejecter) {
        this.errorRejecter(error);
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
    this.responseResolver = null;
    this.errorRejecter = null;
    this.currentResponse = "";
    this.currentAudioChunks = [];
  }
}
