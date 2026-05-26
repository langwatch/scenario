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

// SALVAGE-CONFLICT [EDR Gap #4]: issue372/ts-voice-script-steps-result exports AgentSpeakingEvent from ./adapter while issue372/ts-voice-adapter-runtime exports it from ./adapter.runtime — both retained, reconcile duplicate in refactor
export { VoiceAgentAdapter, type AgentSpeakingEvent } from "./adapter";

export {
  OpenAIRealtimeAgentAdapter,
  type OpenAIRealtimeAgentAdapterInit,
} from "./adapters/openai-realtime";

export {
  GeminiLiveAgentAdapter,
  type GeminiLiveAgentAdapterInit,
} from "./adapters/gemini-live";

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
  COMPOSABLE_VOICE_LLM_MODEL,
  ELEVENLABS_DEFAULT_VOICE_ID,
  ELEVENLABS_STT_MODEL,
  ELEVENLABS_TTS_MODEL,
  GEMINI_LIVE_MODEL,
  OPENAI_REALTIME_MODEL,
  OPENAI_STT_MODEL,
  OPENAI_TTS_MODEL,
} from "./voice-models";

// SALVAGE-CONFLICT [EDR Gap #?]: issue372/ts-voice-tts-stt-plumbing vs issue372/ts-voice-adapter-runtime both retained — reconcile in refactor
export {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
  type TTSCallable,
  type TtsEffectFn,
  type TtsProvider,
} from "./tts";

// SALVAGE-CONFLICT [EDR Gap #5]: ElevenLabsSTTProvider exists in both ./stt and ./adapters/composable with divergent implementations — barrel exports ./stt version; ./adapters version retained in adapters sub-barrel — reconcile in refactor
export {
  ELEVENLABS_STT_ENDPOINT,
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

// SALVAGE-CONFLICT [EDR Gap #3]: issue372/ts-voice-adapter-runtime vs issue372/ts-voice-simulator-judge-messages both retained — reconcile in refactor (messages.ts WAV vs PCM16 format split)
export {
  createAudioMessage,
  extractAudio,
  messageHasAudio,
} from "./messages";

// SALVAGE-CONFLICT [EDR Gap #?]: issue372/ts-voice-effects barrel export appended — reconcile in refactor
export * as effects from "./effects";

// SALVAGE-CONFLICT [EDR Gap #5]: issue372/ts-voice-elevenlabs-adapter adds adapters exports including divergent STTProvider/synthesize copies — reconcile in refactor
// ElevenLabsSTTProvider and synthesize intentionally NOT re-exported here: they are already exported above from ./stt and ./tts respectively;
// ./adapters/composable.ts retains divergent copies of both (the Gap #5 duplication site) — reconcile in refactor
export {
  ComposableVoiceAgent,
  ElevenLabsAgentAdapter,
  ElevenLabsVoiceAgent,
  ELEVENLABS_CONVAI_URL_TEMPLATE,
  type ComposableVoiceAgentOptions,
  type ElevenLabsAgentAdapterOptions,
  type ElevenLabsVoiceAgentOptions,
  type SynthesizeOptions,
  type WebSocketLike,
} from "./adapters";
