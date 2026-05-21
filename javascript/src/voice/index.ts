/**
 * Voice subsystem barrel — public surface for the TS voice port.
 *
 * PR1 shipped the type contracts. PR3 (this commit) adds the adapter
 * runtime + VAD fallback + executor lifecycle helpers. Real transports
 * land in PR7+ behind this same contract.
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

export { VoiceAgentAdapter, type AgentSpeakingEvent } from "./adapter";

export type {
  AudioSegment,
  LatencyMetrics,
  SpeakerRole,
  VoiceEvent,
  VoiceRecording,
} from "./recording.types";

export {
  VoiceRecordingRuntime,
  computeLatencyMetrics,
  type VoiceRecordingInit,
} from "./recording.runtime";

export {
  CANNED_PHRASES,
  CONTEXTUAL_PROMPT,
  InterruptionConfig,
  type InterruptionConfigInit,
  type InterruptionStrategy,
} from "./interruption";

export type {
  VoiceBackgroundNoise,
  VoiceExecutorState,
} from "./voice-executor-state";

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

export {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
  type TTSCallable,
  type TtsEffectFn,
  type TtsProvider,
} from "./tts";

export {
  ELEVENLABS_STT_ENDPOINT,
  ELEVENLABS_STT_MODEL,
  ElevenLabsSTTProvider,
  OPENAI_TRANSCRIBE_LIMIT_SECONDS,
  OpenAISTTProvider,
  getSttProvider,
  pcm16ToWav,
  setSttProvider,
  type ElevenLabsSTTProviderOptions,
  type OpenAISTTProviderOptions,
  type STTProvider,
} from "./stt";

export {
  transcribeSegments,
  type TranscribeSegmentsOptions,
} from "./transcribe";

export {
  AgentSpeakingEvent,
  AdapterRecorder,
  defaultVoiceCall,
  initVoiceExecutorState,
  pickVoiceAdapters,
  startVoiceAdapters,
  stopVoiceAdapters,
  writeUserSegment,
} from "./adapter.runtime";

export {
  WebRTCVadFallback,
  type WebRTCVadFallbackOptions,
} from "./vad";

export {
  createAudioMessage,
  extractAudio,
  messageHasAudio,
} from "./messages";

export * as effects from "./effects";
