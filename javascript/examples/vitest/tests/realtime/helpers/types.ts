/**
 * Core types and interfaces for Realtime Agent Architecture
 *
 * This file defines the contracts for the improved architecture that separates
 * concerns between agent configuration, session management, message handling,
 * transport layer, and logging.
 */

import type { AssistantModelMessage } from "ai";
import type { AgentInput, AgentReturnTypes } from "@langwatch/scenario";

/**
 * Agent personality configuration - what defines the agent's behavior and identity
 */
export interface AgentPersonality {
  /** Display name of the agent */
  name: string;

  /** Instructions that define the agent's behavior and role */
  instructions: string;

  /** Voice type for audio responses */
  voice: string;
}

/**
 * Realtime capabilities - technical configuration for the realtime session
 */
export interface RealtimeCapabilities {
  /** Model to use for the realtime session */
  model: string;

  /** Optional tools available to the agent */
  tools?: any[];

  /** Optional modalities (text, audio) supported */
  modalities?: string[];
}

/**
 * Complete agent configuration combining personality and capabilities
 */
export interface AgentConfig extends AgentPersonality, RealtimeCapabilities {}

/**
 * Connection configuration for establishing realtime sessions
 */
export interface ConnectionConfig {
  /** Direct API key (recommended for testing) */
  apiKey?: string;

  /** Ephemeral token server URL (for production/browser) */
  tokenServerUrl?: string;
}

/**
 * Audio response event data
 */
export interface AudioResponse {
  /** Text transcript of the audio response */
  transcript: string;

  /** Base64-encoded audio data */
  audio: string;
}

/**
 * Audio delta event from transport layer
 */
export interface AudioDelta {
  /** Base64-encoded audio chunk */
  delta: string;
}

/**
 * Transcript delta event from transport layer
 */
export interface TranscriptDelta {
  /** Text fragment of the transcript */
  delta: string;
}

/**
 * Realtime message format for sending to the transport layer
 */
export interface RealtimeMessage {
  /** Message type (text or audio) */
  type: "text" | "audio";

  /** Message content */
  content: string;

  /** Optional metadata */
  metadata?: Record<string, any>;
}

/**
 * Realtime response from the transport layer
 */
export interface RealtimeResponse {
  /** Text transcript */
  transcript: string;

  /** Audio data */
  audio: string;

  /** Response metadata */
  metadata?: Record<string, any>;
}

/**
 * Response handler callback type
 */
export type ResponseHandler = (response: AudioResponse) => void;

/**
 * Error handler callback type
 */
export type ErrorHandler = (error: Error) => void;

/**
 * Transport event types
 */
export type TransportEvent =
  | { type: "audio_delta"; data: AudioDelta }
  | { type: "transcript_delta"; data: TranscriptDelta }
  | { type: "response_complete"; data: AudioResponse }
  | { type: "error"; data: Error };
