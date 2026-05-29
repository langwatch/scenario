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

// Gap #4: `AgentSpeakingEvent` is exported once — as the concrete class from
// ./adapter.runtime (below). The structurally-identical interface in
// ./adapter stays internal (the adapter's `agentSpeakingEvent?` field type).
export { VoiceAgentAdapter } from "./adapter";

// Per-run voice config (Gap #7) — replaces the removed STT global + configure({stt}).
export {
  resolveVoiceConfig,
  DEFAULT_STT_MODEL,
  DEFAULT_AUDIO_FORMAT,
  type VoiceConfig,
  type SttConfig,
  type TtsConfig,
  type ResolvedVoiceConfig,
  type AudioFormat,
} from "./config";

export {
  OpenAIRealtimeAgentAdapter,
  type OpenAIRealtimeAgentAdapterInit,
} from "./adapters/openai-realtime";

export {
  GeminiLiveAgentAdapter,
  type GeminiLiveAgentAdapterInit,
} from "./adapters/gemini-live";

export {
  TwilioAgentAdapter,
  type TwilioAdapterMode,
  type TwilioAgentAdapterOptions,
} from "./adapters/twilio";

export {
  openTwilioTunnel,
  type OpenedTunnel,
  type OpenTunnelOptions,
  type TunnelProvider,
} from "./adapters/twilio-tunnel";

export type {
  AudioSegment,
  LatencyMetrics,
  SpeakerRole,
  VoiceEvent,
  VoiceEventType,
  VoiceRecording,
} from "./recording.types";

export {
  isRealtimeUserAgent,
  isVoiceUserSim,
  type RealtimeUserAgent,
  type VoiceUserSimulator,
} from "./agent-shapes";

export {
  VoiceRecordingRuntime,
  computeLatencyMetrics,
  type VoiceRecordingInit,
} from "./recording.runtime";

// Bundled ffmpeg binary resolution (Python parity: imageio-ffmpeg). Lets
// audio decode/transcode shell out to a vendored binary, no system dep.
export { resolveFfmpegPath } from "./ffmpeg";

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
  AudioFilePart,
  AudioMessage,
  AudioMessageParts,
  AudioMessageRole,
  AudioTextPart,
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

// TTS subtree (split from the flat tts.ts; one file per provider — EDR §5.3).
// LRU cache invariant preserved (key = sha256(text)+voice; effects after read).
export {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
  type TTSCallable,
  type TtsEffectFn,
  type TtsProvider,
} from "./tts";

// STT subtree (Gap #1 — split from the flat stt.ts; one file per provider).
// The PR2 global (getSttProvider/setSttProvider) is removed — provider state
// is per-run on ScenarioConfig.voice (ADR-002). Gap #5 (composable.ts's
// divergent ElevenLabsSTTProvider/synthesize copies) is deferred to Tier B:
// composable still defines its own copies; the canonical one is exported here.
export {
  ELEVENLABS_STT_ENDPOINT,
  ElevenLabsSTTProvider,
  OPENAI_TRANSCRIBE_LIMIT_SECONDS,
  OpenAISTTProvider,
  pcm16ToWav,
  resolveSttProvider,
  registerSttProvider,
  listSttProviders,
  type ElevenLabsSTTProviderOptions,
  type OpenAISTTProviderOptions,
  type STTProvider,
  type SttProviderFactory,
} from "./stt";

export {
  transcribeSegments,
  type TranscribeSegmentsOptions,
} from "./transcribe";

// Judge STT pre-pass (EDR §3.3 / §7.7) — automatic transcription of audio
// `file` parts to text BEFORE the judge's buildTranscriptFromMessages. NOT a
// "judge requests transcript" tool (no such tool, §7.3); STT is upstream.
export {
  prepareJudgeInput,
  type JudgeAudioOptions,
  type JudgePreparedInput,
} from "./judge-stt";

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

// Gap #3 (RESOLVED — LIVE BUG fixed): one encoder + one extractor for the
// canonical AI-SDK `file` audio part (EDR §4.2). The WAV-vs-PCM16 producer
// split is gone; adapter.runtime.ts now imports these instead of its own copy.
export {
  createAudioMessage,
  extractAudio,
  messageHasAudio,
  hasAudio,
  extractTranscript,
  AUDIO_PCM16_MEDIA_TYPE,
} from "./messages";

// Audio effects namespace (PRD §4.5) — `scenario.effects.background_noise(...)`.
export * as effects from "./effects";

// Gap #5 (RESOLVED): composable.ts no longer defines its own STTProvider /
// ElevenLabsSTTProvider / synthesize — it imports the canonical interface from
// ./stt and routes TTS through ./tts (the EL path uses the tts/elevenlabs-tts
// leaf, Gap #10). ElevenLabsSTTProvider/STTProvider are exported above from
// ./stt; `synthesize` (the registry router) from ./tts. The composable-level
// `synthesize` wrapper + SynthesizeOptions (test seam) are internal to the
// adapter surface and re-exported below for the EL preset + tests.
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

// Pipecat adapter + the not-yet-connected transport error (Gap #6 resolved —
// the codec it rides lives in the single reconciled ./adapters/twilio-shared).
export {
  PipecatAgentAdapter,
  type PipecatAgentAdapterInit,
  type PipecatTransport,
  type PipecatWebSocketFactory,
  type PipecatWebSocketLike,
} from "./adapters/pipecat";

export { PendingTransportError } from "./adapters/pending-transport-error";

// Lowercase adapter factories — the documented PRD §9 idiom
// (`scenario.pipecatAgent({...})`). Thin `new XAgentAdapter(params)` wrappers
// over the class forms above; both surfaces are public (EDR §0 barrel).
export {
  pipecatAgent,
  openAIRealtimeAgent,
  geminiLiveAgent,
  elevenLabsAgent,
  twilioAgent,
  composableAgent,
} from "./factories";
