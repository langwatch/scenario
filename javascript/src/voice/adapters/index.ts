/**
 * Voice adapter barrel — ships ElevenLabs hosted + composable + branded.
 *
 * PR7 of issue #372. Other adapters (Pipecat, Twilio, OpenAI Realtime,
 * Gemini Live, etc.) ship in later slices.
 */

export {
  ElevenLabsAgentAdapter,
  ELEVENLABS_CONVAI_URL_TEMPLATE,
  type ElevenLabsAgentAdapterOptions,
  type WebSocketLike,
} from "./elevenlabs";

export {
  ComposableVoiceAgent,
  ElevenLabsSTTProvider,
  ELEVENLABS_TTS_MODEL,
  synthesize,
  type ComposableVoiceAgentOptions,
  type STTProvider,
  type SynthesizeOptions,
} from "./composable";

export {
  ElevenLabsVoiceAgent,
  ELEVENLABS_DEFAULT_VOICE_ID,
  ELEVENLABS_VOICE_AGENT_DEFAULT_LLM,
  type ElevenLabsVoiceAgentOptions,
} from "./eleven-labs-voice-agent";
