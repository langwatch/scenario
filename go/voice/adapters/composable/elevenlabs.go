package composable

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/langwatch/scenario/go/voice/tts"
)

// DefaultLLMModel is the model the JavaScript and Python presets default
// to ("gpt-5.4-mini" on OpenAI). Go links no provider by default, so pass
// it with an OpenAI LLM to reproduce their default stack.
const DefaultLLMModel = "gpt-5.4-mini"

// VoiceIDEnv overrides the preset's default ElevenLabs voice.
const VoiceIDEnv = "ELEVENLABS_VOICE_ID"

// ElevenLabsOptions configure the ElevenLabs preset. Every field is
// optional; each overrides one piece and leaves the others on their
// ElevenLabs defaults.
type ElevenLabsOptions struct {
	// APIKey is the ElevenLabs key for the default STT and TTS; unset,
	// ELEVENLABS_API_KEY.
	APIKey string
	// LLM and Model override the language model (see Options.LLM).
	LLM   scenario.LLM
	Model string
	// Voice is the TTS voice, "provider/voice". Unset, "elevenlabs/" plus
	// ELEVENLABS_VOICE_ID, else the free-tier "Sarah" voice.
	Voice string
	// STT overrides the default ElevenLabs speech-to-text.
	STT stt.Provider
	// SystemPrompt defaults to DefaultSystemPrompt.
	SystemPrompt string
	// HTTPClient is used by the default ElevenLabs STT and TTS.
	HTTPClient *http.Client
	// Synthesize overrides the TTS entirely.
	Synthesize SynthesizeFunc
}

// NewElevenLabs returns the composable transport with ElevenLabs defaults:
// ElevenLabs STT, ElevenLabs TTS (eleven_v3) and the given or configured
// LLM.
func NewElevenLabs(o ElevenLabsOptions) (*Transport, error) {
	if o.Voice == "" {
		o.Voice = defaultVoice()
	}
	if o.STT == nil {
		o.STT = stt.NewElevenLabs(stt.ElevenLabsOptions{APIKey: o.APIKey, HTTPClient: o.HTTPClient})
	}
	if o.Synthesize == nil {
		o.Synthesize = elevenLabsSynthesize(o.APIKey, o.HTTPClient)
	}
	return newTransport(Options{
		STT: o.STT, LLM: o.LLM, Model: o.Model, Voice: o.Voice,
		SystemPrompt: o.SystemPrompt, Synthesize: o.Synthesize,
	}, "ElevenLabsVoiceAgent", func(t *Transport) string {
		return fmt.Sprintf("ElevenLabsVoiceAgent(apiKey='***', llm=<LLM>, voice='%s')", t.Voice())
	})
}

// NewElevenLabsAgent returns the ElevenLabs preset as a scenario agent.
func NewElevenLabsAgent(o ElevenLabsOptions, opts ...voice.AgentOption) (*Agent, error) {
	t, err := NewElevenLabs(o)
	if err != nil {
		return nil, err
	}
	return wrap(t, opts), nil
}

func defaultVoice() string {
	if id := os.Getenv(VoiceIDEnv); id != "" {
		return "elevenlabs/" + id
	}
	return "elevenlabs/" + tts.ElevenLabsDefaultVoiceID
}

// elevenLabsSynthesize speaks elevenlabs/ voices with the preset's key and
// client, and routes any other provider through tts.Default().
func elevenLabsSynthesize(apiKey string, client *http.Client) SynthesizeFunc {
	el := tts.NewSynthesizer(0)
	el.Register("elevenlabs", tts.NewElevenLabs(tts.ElevenLabsOptions{APIKey: apiKey, HTTPClient: client}).Synthesize)
	return func(ctx context.Context, text, v string) (voice.AudioChunk, error) {
		if provider, _, _ := strings.Cut(v, "/"); strings.EqualFold(provider, "elevenlabs") {
			return el.Synthesize(ctx, text, v)
		}
		return defaultSynthesize(ctx, text, v)
	}
}
