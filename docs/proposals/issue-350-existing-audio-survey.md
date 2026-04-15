# Issue 350: Existing Audio Surface Survey

## 1. What Exists Today

### Core Audio Handling
- **MessageProcessor** (`javascript/src/agents/realtime/message-processor.ts:15-49`)
  - `processAudioMessage()` – extracts base64 audio from AI SDK file parts with `mediaType.startsWith("audio/")`
  - `extractTextMessage()` – handles text content
  - `hasValidContent()` – validates text OR audio presence

- **RealtimeEventHandler** (`javascript/src/agents/realtime/realtime-event-handler.ts:6-100+`)
  - `AudioResponseEvent` interface – pairs transcript + audio data
  - Listens to OpenAI Realtime API events (audio delta, transcript delta)
  - Buffers audio chunks and assembles responses

- **ResponseFormatter** (`javascript/src/agents/realtime/response-formatter.ts:17-25`)
  - `formatAudioResponse()` – converts AudioResponseEvent to AssistantModelMessage with two content blocks:
    - `{type: "text", text: transcript}`
    - `{type: "file", mediaType: "audio/pcm16", data: base64}`

- **RealtimeAgentAdapter** (`javascript/src/agents/realtime/realtime-agent.adapter.ts:90-100`)
  - Wraps OpenAI Realtime API session for Scenario framework
  - Role: AGENT or USER
  - Timeout-aware (default 30s)

### Media Truncation (Token Optimization)
- **truncateBase64Media()** (`javascript/src/agents/judge/judge-utils.ts:12-78`)
  - Strips base64 data URLs (`data:audio/wav;base64,...`) → markers like `[AUDIO: audio/wav, ~5000 bytes]`
  - Strips AI SDK file parts (`{type: "file", mediaType: "audio/wav", data: "..."}`) → same markers
  - Used in judge transcript building to reduce token usage

- **truncateMediaUrl()** & **truncateMediaPart()** (`javascript/src/agents/judge/truncate-media.ts:6-64`)
  - Alternative/parallel implementation of same truncation logic

### Audio Encoding & Utility Functions
- **encodeAudioToBase64()** (`javascript/examples/vitest/tests/helpers/audio-encoding.ts:8-11`)
  - File → Buffer → base64 string

- **Audio utilities** (`javascript/examples/vitest/tests/utils/audio/`)
  - `pcm16-to-wav.ts` – PCM16 raw bytes → WAV format
  - `concatenate-wave-files.ts` – Merges multiple WAV files
  - `audio.utils.ts` – (helper module)
  - `realtime-audio-player.ts` – (playback utility, test-only)

### Judge Audio Transcription
- **wrapJudgeForAudioTranscription()** (`javascript/examples/vitest/tests/helpers/wrap-judge-for-audio-transcription.ts:35-48`)
  - Wraps judge agent to convert audio → text (OpenAI Whisper) before evaluation
  - Uses `sanitizeMessagesForV5()` to strip audio before passing to judge

- **wrapJudgeForAudioExtraction()** (`javascript/examples/vitest/tests/helpers/wrap-judge-for-audio-extraction.ts`)
  - (Parallel approach; intent unclear from name)

### OpenAI Voice Agent Base Class
- **OpenAiVoiceAgent** (`javascript/examples/vitest/tests/helpers/openai-voice-agent.ts:61-100+`)
  - Abstract base for voice agents using `gpt-4o-audio-preview` model
  - Config: systemPrompt, voice ("alloy"/"nova"/"echo"/"fable"/"onyx"/"shimmer"), forceUserRole flag
  - `call()` → converts messages to OpenAI format → calls Realtime API → returns audio message or text fallback
  - Workaround: `forceUserRole` to bypass judge limitations with audio in assistant role

### Message Type Extensions
- `ModelMessage` (from AI SDK) supports multimodal content:
  - Text: `{type: "text", text: "..."}`
  - Audio: `{type: "file", mediaType: "audio/wav" | "audio/pcm16", data: "<base64>"}`
  - (No custom audio message type; reuses AI SDK file parts)

- **AgentReturnTypes** (`javascript/src/domain/agents/types/agent-return.types.ts:10-15`)
  - `string | ModelMessage | ModelMessage[] | JudgeResult | null`
  - Audio is carried in ModelMessage.content arrays, not distinct type

---

## 2. How It's Wired In

### Message Flow: Audio to Response
```
AgentInput.messages (ModelMessage[])
  ↓ contains file parts with mediaType: "audio/*"
MessageProcessor.processAudioMessage()
  ↓ extracts base64 data
RealtimeAgentAdapter.call()
  ↓ converts to OpenAI Realtime format
OpenAI gpt-4o-audio-preview
  ↓ generates audio response event
RealtimeEventHandler (listens to transport events)
  ↓ buffers audio chunks + transcript
ResponseFormatter.formatAudioResponse()
  ↓ wraps as AssistantModelMessage with [text, file(audio/pcm16)]
ScenarioExecution (message history)
```

### Judge Integration
- Judge receives full message history (text + audio base64)
- `truncateBase64Media()` is called during judge transcript building → audio replaced with size markers
- For full audio transcription: `wrapJudgeForAudioTranscription()` pre-transcribes all audio → judge sees text-only
- Workaround needed because judge agents in AI SDK can't process audio directly

### Agent Interface Assumptions
- **AgentAdapter.call(input: AgentInput)** returns `AgentReturnTypes`
- Audio responses are ModelMessage with multimodal content
- No dedicated "voice" or "audio" mode flag on agent — determined at runtime by content type

---

## 3. Coverage

### Tests That Exercise Audio
- `multimodal-audio-to-text.test.ts` – agent accepts audio (WAV fixture), responds with text; uses OpenAI gpt-4o-audio-preview
- `multimodal-audio-to-audio.test.ts` – agent accepts audio, responds with audio; wraps judge for transcription
- `multimodal-voice-to-voice-conversation.test.ts` – multi-turn audio conversation with user simulator (OpenAiVoiceAgent subclass)
- `openai-voice-agent.test.ts` – unit tests for OpenAiVoiceAgent base class
- `vegetarian-recipe-realtime.test.ts` – Realtime API usage example (session-based)
- `scenario-expert-realtime.test.ts` – Realtime API scenario

### Unit Tests for Utilities
- `judge-utils.test.ts` – truncateBase64Media() logic
- `truncate-media.test.ts` – truncateMediaUrl/Part() logic
- `judge-span-digest-formatter.test.ts` – truncation in digest formatting

### Helpers/Fixtures
- Audio fixture: `male_or_female_voice.wav` (referenced in tests)
- `audio-conversation.ts` – saveConversationAudio() utility (extract + concatenate audio from messages)
- `convert-core-messages-to-openai.ts` – message format translation
- `sanitize-messages-for-v5.ts` – prepare messages for judge (strip audio, etc.)

### Examples
- `openai-realtime-demo/` – full browser + backend demo with VoiceOrb UI

---

## 4. Gaps & Limitations

### Design Limitations
1. **No first-class audio type**
   - Audio is nested in `ModelMessage.content` as `{type: "file", mediaType: "audio/*", data: "<base64>"}`
   - No AudioMessage variant; no dedicated audio schema
   - Ambiguous: is audio primary (voice-to-voice agent) or secondary (transcribed fallback)?

2. **Judge cannot process audio natively**
   - Requires wrapper (`wrapJudgeForAudioTranscription`) to pre-transcribe
   - Judges built with AI SDK tools cannot see audio in raw form
   - Workaround: convert audio → text before judge evaluation (loses voice tone, paralinguistics)

3. **Two audio format standards**
   - Realtime API returns `audio/pcm16` (raw PCM buffers)
   - OpenAI gpt-4o-audio model returns `audio/wav`
   - Truncation code accepts both but doesn't normalize

4. **No audio codec negotiation**
   - Hard-coded to `audio/pcm16` for Realtime responses
   - No config for input audio format expectations (does agent expect WAV? MP3? Opus?)
   - Users must manually base64-encode audio before sending

5. **Workaround for assistant role + audio**
   - `OpenAiVoiceAgent` has `forceUserRole` flag to work around judge agent limitations
   - Not documented as a limitation; feels like a hack

### Feature Gaps
1. **No streaming audio output**
   - Realtime API supports streaming, but SDK doesn't expose partial audio chunks to user
   - All audio buffered until response complete

2. **No real-time voice detection**
   - No VAD (voice activity detection) support
   - No silence detection on input

3. **No audio metadata**
   - No duration, sample rate, or bitrate fields
   - No speaker identification (only "user" vs "agent" role)
   - No confidence scores from speech-to-text

4. **Minimal audio validation**
   - `processAudioMessage()` only checks for `mediaType.startsWith("audio/")`
   - No format validation, size limits, or codec checks

5. **Test coverage is narrow**
   - All audio tests use OpenAI API (gpt-4o-audio-preview or Realtime)
   - No mock/stub agents with audio for faster unit testing
   - No tests for corrupted or invalid audio handling

6. **No audio input from microphone**
   - Test examples use fixture files (WAV)
   - Real-time microphone input would require browser WebRTC or Node.js audio library
   - Not in scope for SDK, but notable gap for live demo

---

## 5. Supersession Notes

### Likely to Be Replaced by Issue 350 "Voice as First-Class"
- **OpenAiVoiceAgent** – may become redundant if SDK provides native voice agent type
- **RealtimeAgentAdapter** – may be wrapped in higher-level agent factory
- **forceUserRole workaround** – should be fixed at message type level if audio becomes first-class
- **Message content union** – audio may move to dedicated field or variant type

### Likely to Be Kept/Migrated
- **MessageProcessor** – core extraction logic useful even with new types
- **Audio encoding utilities** (pcm16-to-wav, concatenate) – remain utility-level
- **truncateBase64Media()** – token optimization still needed
- **wrapJudgeForAudioTranscription()** – judge limitation may persist (or be fixed upstream in AI SDK)

### Likely to Be Introduced
- **AudioMessage type** or `audio` content block variant in ModelMessage
- **AudioAgentAdapter** or explicit voice mode on AgentAdapter
- **Audio metadata schema** (codec, sample rate, duration, confidence)
- **Audio input validation** (size, format checks)
- **Streaming audio support** in response formatter
- **Judge audio support** or explicit audio → text conversion pipeline

---

## Summary

**Audio is currently scattered across three layers:**
1. **Low-level**: MessageProcessor, audio utilities, encoding/decoding
2. **Mid-level**: Realtime adapter, response formatting, message wiring
3. **High-level**: OpenAiVoiceAgent base class, judge wrapper, test helpers

**Coherence:** Loosely coupled; each component does one thing well (extraction, formatting, encoding), but no unified "audio message" abstraction. Audio is treated as an exotic content type rather than a first-class citizen.

**Surprise finding:** The `forceUserRole` workaround suggests early pain with audio in assistant messages — this may indicate a deeper design issue in how message roles interact with media content that the proposal will address.
