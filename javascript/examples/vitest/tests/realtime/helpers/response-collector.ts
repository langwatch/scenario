/**
 * Response Collector
 *
 * Responsible for aggregating audio chunks and transcript fragments from
 * realtime events into complete responses. Handles timeouts and error states.
 */

import type { AudioDelta, TranscriptDelta, AudioResponse } from "./types.js";
import type { Logger } from "./logger.js";

export interface ResponseCollector {
  /**
   * Collects an audio or transcript delta
   */
  collect(delta: AudioDelta | TranscriptDelta): void;

  /**
   * Waits for and returns the complete response
   */
  getCompleteResponse(timeoutMs?: number): Promise<AudioResponse>;

  /**
   * Resets the collector for the next response
   */
  reset(): void;

  /**
   * Checks if a response is currently being collected
   */
  isCollecting(): boolean;
}

export interface ResponseCollectorConfig {
  /** Default timeout for waiting for responses (ms) */
  defaultTimeoutMs?: number;

  /** Logger for debugging and error reporting */
  logger?: Logger;
}

/**
 * Default implementation of ResponseCollector
 *
 * Collects audio chunks and transcript fragments, then combines them
 * into complete AudioResponse objects when the response is finished.
 */
export class DefaultResponseCollector implements ResponseCollector {
  private transcriptParts: string[] = [];
  private audioChunks: string[] = [];
  private responseResolver?: (response: AudioResponse) => void;
  private errorRejecter?: (error: Error) => void;
  private timeoutId?: NodeJS.Timeout;
  private isResponseComplete = false;

  constructor(private config: ResponseCollectorConfig = {}) {}

  collect(delta: AudioDelta | TranscriptDelta): void {
    if (this.isResponseComplete) {
      this.config.logger?.warn("Received delta after response was marked complete");
      return;
    }

    if ("delta" in delta && typeof delta.delta === "string") {
      // Audio delta
      this.audioChunks.push(delta.delta);
      this.config.logger?.debug("Collected audio delta", {
        chunkSize: delta.delta.length,
        totalChunks: this.audioChunks.length,
      });
    } else if ("delta" in delta && typeof delta.delta === "string") {
      // Transcript delta
      this.transcriptParts.push(delta.delta);
      this.config.logger?.debug("Collected transcript delta", {
        delta: delta.delta,
        totalParts: this.transcriptParts.length,
      });
    }
  }

  async getCompleteResponse(timeoutMs?: number): Promise<AudioResponse> {
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs ?? 30000;

    return new Promise<AudioResponse>((resolve, reject) => {
      this.responseResolver = resolve;
      this.errorRejecter = reject;

      // Set timeout
      this.timeoutId = setTimeout(() => {
        this.cleanup();
        reject(new Error(`Response collection timeout after ${timeout}ms`));
      }, timeout);

      this.config.logger?.debug("Waiting for response completion", { timeout });
    });
  }

  reset(): void {
    this.cleanup();
    this.transcriptParts = [];
    this.audioChunks = [];
    this.isResponseComplete = false;
    this.config.logger?.debug("Response collector reset");
  }

  isCollecting(): boolean {
    return this.responseResolver !== undefined;
  }

  /**
   * Marks the response as complete and resolves the waiting promise
   */
  completeResponse(): void {
    if (this.isResponseComplete) {
      this.config.logger?.warn("Response already marked as complete");
      return;
    }

    this.isResponseComplete = true;

    const transcript = this.transcriptParts.join("");
    const audio = this.audioChunks.join("");

    const response: AudioResponse = {
      transcript,
      audio,
    };

    this.config.logger?.info("Response completed", {
      transcriptLength: transcript.length,
      audioLength: audio.length,
      transcriptParts: this.transcriptParts.length,
      audioChunks: this.audioChunks.length,
    });

    if (this.responseResolver) {
      this.responseResolver(response);
    }

    this.cleanup();
  }

  /**
   * Marks collection as failed and rejects the waiting promise
   */
  failResponse(error: Error): void {
    this.config.logger?.error("Response collection failed", { error: error.message });

    if (this.errorRejecter) {
      this.errorRejecter(error);
    }

    this.cleanup();
  }

  private cleanup(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
    this.responseResolver = undefined;
    this.errorRejecter = undefined;
  }
}
