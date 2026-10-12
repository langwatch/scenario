package voice

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/langwatch/scenario/go/voice/tts"
)

// AudioFormat is an in-message or wire audio format tag.
type AudioFormat string

// Audio formats. The canonical in-message format is PCM16.
const (
	FormatPCM16 AudioFormat = "pcm16"
	FormatWAV   AudioFormat = "wav"
	FormatMulaw AudioFormat = "mulaw"
)

// Config is the per-run voice configuration. It rides on the run's values
// (no process-wide state): pass it with [WithConfig] or put it under
// [ConfigKey] in ScenarioConfig.Values. Zero fields take the defaults.
type Config struct {
	// STT transcribes audio for the judge, the user simulator fallback and
	// the recording back-fill. When nil, STTModel is resolved; when both are
	// unset, a default OpenAI provider is built for the run.
	STT stt.Provider
	// STTModel is a "provider/model" spec, such as "openai/gpt-4o-transcribe".
	STTModel string
	// TTSVoice is the "provider/voice" the user simulator speaks with when
	// it has no voice of its own, such as "openai/nova".
	TTSVoice string
	// TTS synthesizes user turns; defaults to tts.Default().
	TTS *tts.Synthesizer
	// AudioFormat is the default in-message audio format (pcm16).
	AudioFormat AudioFormat
	// AudioPlayback streams the conversation audio to the local speakers
	// (through ffmpeg) while the run executes.
	AudioPlayback bool
	// IncludeAudio, IncludeTimeline and IncludeTraces are the judge knobs;
	// nil leaves the defaults (false, true, true).
	IncludeAudio    *bool
	IncludeTimeline *bool
	IncludeTraces   *bool

	// OnVoiceEvent receives every timeline event. Panics are recovered.
	OnVoiceEvent func(VoiceEvent)
	// OnAudioChunk receives every recorded audio chunk. Panics are recovered.
	OnAudioChunk func(AudioChunk)

	// Interruption forces the barge-in configuration of the run, overriding
	// the user simulator's InterruptProbability.
	Interruption *InterruptionConfig
	// Rand draws the interruption decisions; defaults to math/rand.
	Rand func() float64
	// WaitForSpeech bounds how long a barge-in waits for the agent to start
	// speaking (default 15s).
	WaitForSpeech time.Duration
	// BargeInDelay is waited after the agent started speaking, before the
	// barge-in fires, when the interruption config did not sample one.
	BargeInDelay time.Duration

	// Clock defaults to the system clock.
	Clock Clock
	// Logger defaults to slog.Default().
	Logger *slog.Logger
}

type configKey struct{}

// ConfigKey is the key of the voice Config in the run's values.
var ConfigKey any = configKey{}

// WithConfig passes the voice configuration of a run.
func WithConfig(c Config) scenario.RunOption { return scenario.WithValue(ConfigKey, c) }

// ConfigOf returns the voice configuration of the run ex executes.
func ConfigOf(ex *scenario.Executor) Config {
	if ex == nil {
		return Config{}
	}
	switch c := ex.Value(ConfigKey).(type) {
	case Config:
		return c
	case *Config:
		if c != nil {
			return *c
		}
	}
	return Config{}
}

const defaultWaitForSpeech = 15 * time.Second

// resolved is a Config with its defaults applied. STT is built lazily, once.
type resolved struct {
	Config
	sttOnce sync.Once
	stt     stt.Provider
	sttErr  error
}

func resolve(c Config) *resolved {
	if c.Clock == nil {
		c.Clock = SystemClock{}
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.AudioFormat == "" {
		c.AudioFormat = FormatPCM16
	}
	if c.Rand == nil {
		c.Rand = rand.Float64
	}
	if c.WaitForSpeech <= 0 {
		c.WaitForSpeech = defaultWaitForSpeech
	}
	return &resolved{Config: c}
}

// sttProvider returns the run's STT provider, resolving the spec or
// building the default OpenAI provider on first use.
func (r *resolved) sttProvider() (stt.Provider, error) {
	r.sttOnce.Do(func() {
		switch {
		case r.STT != nil:
			r.stt = r.STT
		case r.STTModel != "":
			r.stt, r.sttErr = stt.Resolve(r.STTModel)
		default:
			r.stt = stt.NewOpenAI(stt.OpenAIOptions{})
		}
	})
	return r.stt, r.sttErr
}

func (r *resolved) synthesizer() *tts.Synthesizer {
	if r.TTS != nil {
		return r.TTS
	}
	return tts.Default()
}

func (r *resolved) includeTimeline() bool { return r.IncludeTimeline == nil || *r.IncludeTimeline }

func (r *resolved) warn(msg string, args ...any) { r.Logger.Warn(msg, args...) }

func (r *resolved) sleep(ctx context.Context, d time.Duration) error { return r.Clock.Sleep(ctx, d) }

// seconds converts a duration to float seconds.
func seconds(d time.Duration) float64 { return d.Seconds() }

// durationOf converts float seconds to a duration.
func durationOf(s float64) time.Duration { return time.Duration(s * float64(time.Second)) }

type sttProvider = stt.Provider

func isBlank(s string) bool { return strings.TrimSpace(s) == "" }

func trimSpace(s string) string { return strings.TrimSpace(s) }
