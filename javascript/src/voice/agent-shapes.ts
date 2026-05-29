/**
 * @deprecated Import from `domain/agents/agent-shapes` directly.
 *
 * This re-export shim keeps old import paths working while the canonical
 * location is `javascript/src/domain/agents/agent-shapes.ts`.
 * Issue #579.
 */
export {
  isRealtimeUserAgent,
  isVoiceUserSim,
  type RealtimeUserAgent,
  type VoiceUserSimulator,
  type UserSimulatorAgentWithVoice,
} from "../domain/agents/agent-shapes";
