/**
 * Voice subsystem barrel — type contract surface for the TS voice port.
 *
 * PR1 ships types + the {@link UnsupportedCapabilityError} class only.
 * Runtime (TTS, STT, VAD, recording, transports) lands in PR2+ behind this
 * same contract.
 */

export {
  AudioChunk,
  silentChunk,
  PCM16_SAMPLE_RATE,
  PCM16_CHANNELS,
  PCM16_SAMPLE_WIDTH_BYTES,
  type AudioChunkInit,
} from "./audio-chunk";

export {
  AdapterCapabilities,
  UnsupportedCapabilityError,
  type AdapterCapabilitiesInit,
} from "./capabilities";

export { VoiceAgentAdapter } from "./adapter";

export type {
  AudioSegment,
  LatencyMetrics,
  SpeakerRole,
  VoiceEvent,
  VoiceRecording,
} from "./recording.types";

export type { VoiceExecutorState } from "./voice-executor-state";

export type {
  AudioContentPart,
  AudioMessageContentPart,
  AudioMessageParam,
  AudioMessageRole,
  InputAudioContentPart,
  TextContentPart,
} from "./messages.types";

export {
  GEMINI_LIVE_MODEL,
  OPENAI_REALTIME_MODEL,
  OPENAI_STT_MODEL,
  OPENAI_TTS_MODEL,
} from "./voice-models";
