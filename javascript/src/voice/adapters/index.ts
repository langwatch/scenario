/**
 * Voice adapter barrel — ships ElevenLabs hosted + composable + branded.
 *
 * PR7 of issue #372. Other adapters (Pipecat, Twilio, OpenAI Realtime, Gemini
 * Live, etc.) ship in later slices.
 */

export {
  ElevenLabsAgentAdapter,
  ElevenLabsVoiceAgent,
  ELEVENLABS_CONVAI_URL_TEMPLATE,
  type ElevenLabsAgentAdapterOptions,
  type ElevenLabsVoiceAgentOptions,
  type WebSocketLike,
} from "./elevenlabs";

export {
  ComposableVoiceAgent,
  ElevenLabsSTTProvider,
  synthesize,
  type ComposableVoiceAgentOptions,
  type STTProvider,
  type SynthesizeOptions,
} from "./composable";
