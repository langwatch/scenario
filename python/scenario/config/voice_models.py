"""
Default model identifiers for voice paths.

Single source of truth so demos, adapters, and the stub bot don't drift.
Anything outside `config/` that needs a model name should import from here.

Update strategy: when OpenAI / Google / ElevenLabs ship a new generation,
update this file and re-test once. Avoid sprinkling magic strings.
"""

# OpenAI Realtime — bidirectional streaming audio API.
# Used by OpenAIRealtimeAgentAdapter and the Pipecat-Twilio reference bot.
# `gpt-realtime-mini` is the cost-efficient GA model; `gpt-realtime-1.5`
# is the premium tier (~3× more expensive) for higher voice quality.
OPENAI_REALTIME_MODEL: str = "gpt-realtime-mini"

# OpenAI chat completions for the stub bot's brain (STT → chat → TTS
# pipeline). `gpt-5.4-nano` is the cheapest current-GA chat model;
# bot replies cap at 60 tokens so we don't need mini-tier capability.
OPENAI_BOT_LLM_MODEL: str = "gpt-5.4-nano"

# OpenAI TTS — text-to-speech endpoint. `gpt-4o-mini-tts` supersedes
# `tts-1`; same API surface, modern voices.
# Deliberate: gpt-4o-mini-tts is OpenAI's current-gen TTS model as of 2026-06
# (no gpt-5-tts exists on the public API). Revisit when OpenAI ships a
# gpt-5-family speech successor.
OPENAI_TTS_MODEL: str = "gpt-4o-mini-tts"

# OpenAI STT — speech-to-text. Used by voice adapters that need to
# transcribe audio (e.g. the Realtime adapter's input_audio_transcription
# config). Standard tier — accuracy here directly drives downstream
# judge correctness on non-multimodal paths.
# Deliberate: gpt-4o-transcribe is OpenAI's current-gen transcription model
# as of 2026-06 (no gpt-5-transcribe exists on the public API). Revisit when
# OpenAI ships a gpt-5-family transcription successor.
OPENAI_STT_MODEL: str = "gpt-4o-transcribe"

# Cheap STT for the stub bot. Bot replies are 60-token throwaways —
# accuracy matters less than cost.
OPENAI_BOT_STT_MODEL: str = "gpt-4o-mini-transcribe"

# Gemini Live — bidirectional audio. `latest` follows whatever Google
# promotes so this doesn't bitrot when previews shift.
GEMINI_LIVE_MODEL: str = "gemini-2.5-flash-native-audio-latest"

# OpenAI multimodal audio chat — used by the example openai_voice_agent
# helper (chat completions with audio modality, separate API surface
# from Realtime). `gpt-audio-mini` is the current cost-efficient GA
# tier; `gpt-4o-audio-preview` was the legacy preview model.
OPENAI_AUDIO_CHAT_MODEL: str = "gpt-audio-mini"

# Composable voice agent LLM — text-only, drives the brain of the
# `ComposableVoiceAgent` and `ElevenLabsVoiceAgent` stacks (STT → LLM
# → TTS). Litellm-style identifier ("openai/...", "anthropic/...").
COMPOSABLE_VOICE_LLM_MODEL: str = "openai/gpt-5.4-mini"
