/**
 * Improved Realtime Agent Architecture
 *
 * Exports all components of the refactored architecture with separated concerns.
 */

// Core types and interfaces
export type {
  AgentConfig,
  AgentPersonality,
  RealtimeCapabilities,
  ConnectionConfig,
  AudioResponse,
  AudioDelta,
  TranscriptDelta,
  RealtimeMessage,
  RealtimeResponse,
  ResponseHandler,
  ErrorHandler,
  TransportEvent,
} from "./types.js";

// Logging service
export type { Logger } from "./logger.js";
export { ConsoleLogger, NoOpLogger, createLogger, defaultLogger } from "./logger.js";

// Response collection
export type { ResponseCollector } from "./response-collector.js";
export { DefaultResponseCollector } from "./response-collector.js";

// Transport abstraction
export type { TransportAbstraction } from "./transport-abstraction.js";
export { OpenAITransportAbstraction } from "./transport-abstraction.js";

// Session management
export type { SessionManager, SessionManagerConfig } from "./session-manager.js";
export { OpenAISessionManager } from "./session-manager.js";

// Message transformation
export type { MessageTransformer } from "./message-transformer.js";
export { DefaultMessageTransformer } from "./message-transformer.js";

// Agent adapter (orchestrator)
export type { RealtimeAgentAdapterConfig } from "./realtime-agent-adapter.js";
export { RealtimeAgentAdapter } from "./realtime-agent-adapter.js";