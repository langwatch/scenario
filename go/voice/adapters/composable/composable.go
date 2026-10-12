package composable

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/langwatch/scenario/go/voice/tts"
)

// DefaultSystemPrompt seeds the conversation when Options.SystemPrompt is
// unset.
const DefaultSystemPrompt = "You are a helpful voice assistant. Respond naturally and conversationally " +
	"as this is an audio conversation — be concise, friendly, and clear."

// SynthesizeFunc speaks text with a "provider/voice" voice and returns
// canonical PCM16.
type SynthesizeFunc func(ctx context.Context, text, voice string) (voice.AudioChunk, error)

// Options configure a composable [Transport].
type Options struct {
	// STT transcribes the user's audio. Required.
	STT stt.Provider
	// LLM answers the conversation. Unset, the default model configured
	// with scenario.Configure(scenario.WithDefaultModel(...)) is used.
	LLM scenario.LLM
	// Model is passed to the LLM; unset, the configured default model's.
	Model string
	// Voice is the TTS voice, "provider/voice" (for example "openai/nova"
	// or "elevenlabs/<voiceId>"). Required.
	Voice string
	// SystemPrompt seeds the conversation; defaults to DefaultSystemPrompt.
	SystemPrompt string
	// Synthesize speaks the reply; defaults to tts.Default().Synthesize.
	Synthesize SynthesizeFunc
}

func defaultSynthesize(ctx context.Context, text, v string) (voice.AudioChunk, error) {
	return tts.Default().Synthesize(ctx, text, v)
}

// Transport is the composable agent's voice transport. SendAudio
// transcribes a user turn; the turn's first ReceiveAudio runs the LLM on the
// conversation and synthesizes the reply, and later receives of the same
// turn return the empty end-of-turn chunk. It is safe for concurrent use.
type Transport struct {
	name       string
	stringer   func(*Transport) string
	synthesize SynthesizeFunc

	mu          sync.Mutex
	stt         stt.Provider
	llm         scenario.LLM
	model       string
	voice       string
	history     []scenario.Message
	lastUser    string
	lastReply   string
	turnEmitted bool
}

// New returns a composable transport.
func New(o Options) (*Transport, error) {
	return newTransport(o, "ComposableVoiceAgent", func(t *Transport) string {
		return fmt.Sprintf("ComposableVoiceAgent(llm=<LLM>, tts='%s')", t.Voice())
	})
}

func newTransport(o Options, name string, stringer func(*Transport) string) (*Transport, error) {
	if o.STT == nil {
		return nil, errors.New(name + ": STT is required")
	}
	if _, _, ok := strings.Cut(o.Voice, "/"); !ok {
		return nil, fmt.Errorf("%s: voice must be '<provider>/<voiceId>', got '%s'", name, o.Voice)
	}
	if o.SystemPrompt == "" {
		o.SystemPrompt = DefaultSystemPrompt
	}
	if o.Synthesize == nil {
		o.Synthesize = defaultSynthesize
	}
	return &Transport{
		name: name, stringer: stringer, synthesize: o.Synthesize,
		stt: o.STT, llm: o.LLM, model: o.Model, voice: o.Voice,
		history: []scenario.Message{scenario.SystemMsg(o.SystemPrompt)},
	}, nil
}

// Name implements voice.Named.
func (t *Transport) Name() string { return t.name }

// String names the agent without credentials.
func (t *Transport) String() string { return t.stringer(t) }

// Capabilities implements voice.Transport.
func (t *Transport) Capabilities() voice.Capabilities {
	return voice.Capabilities{
		StreamingTranscripts: true,
		InputFormats:         []string{"pcm16/24000"},
		OutputFormats:        []string{"pcm16/24000"},
	}
}

// STT returns the speech-to-text seam.
func (t *Transport) STT() stt.Provider { t.mu.Lock(); defer t.mu.Unlock(); return t.stt }

// SetSTT swaps the speech-to-text seam; the LLM and TTS are untouched.
func (t *Transport) SetSTT(p stt.Provider) { t.mu.Lock(); t.stt = p; t.mu.Unlock() }

// LLM returns the LLM seam (nil: the configured default model).
func (t *Transport) LLM() scenario.LLM { t.mu.Lock(); defer t.mu.Unlock(); return t.llm }

// SetLLM swaps the LLM seam and its model name.
func (t *Transport) SetLLM(llm scenario.LLM, model string) {
	t.mu.Lock()
	t.llm, t.model = llm, model
	t.mu.Unlock()
}

// Voice returns the TTS voice.
func (t *Transport) Voice() string { t.mu.Lock(); defer t.mu.Unlock(); return t.voice }

// SetVoice swaps the TTS voice ("provider/voice").
func (t *Transport) SetVoice(v string) { t.mu.Lock(); t.voice = v; t.mu.Unlock() }

// LastUserTranscript is the STT of the latest user turn.
func (t *Transport) LastUserTranscript() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastUser
}

// LastLLMResponse is the LLM's latest reply text.
func (t *Transport) LastLLMResponse() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastReply
}

// StreamingTranscript implements voice.StreamingTranscriber with the
// current reply's text, known as soon as the LLM answered.
func (t *Transport) StreamingTranscript() string { return t.LastLLMResponse() }

// Connect implements voice.Transport; there is nothing to connect.
func (t *Transport) Connect(context.Context) error { return nil }

// Disconnect implements voice.Transport; there is nothing to tear down.
func (t *Transport) Disconnect(context.Context) error { return nil }

// SendAudio transcribes a user turn into the conversation.
func (t *Transport) SendAudio(ctx context.Context, chunk voice.AudioChunk) error {
	transcript, err := t.STT().Transcribe(ctx, chunk)
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastUser = transcript
	t.history = append(t.history, scenario.UserMsg(transcript))
	t.turnEmitted = false
	return nil
}

// ReceiveAudio answers the turn once: the LLM reply, synthesized, with the
// reply text as the chunk transcript (so the runtime labels the turn
// without waiting for or re-transcribing it). Later receives of the turn
// return an empty chunk. Exceeding timeout is an error wrapping
// voice.ErrReceiveTimeout.
func (t *Transport) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	t.mu.Lock()
	if t.turnEmitted {
		t.mu.Unlock()
		return voice.AudioChunk{}, nil
	}
	llm, model, v := t.llm, t.model, t.voice
	history := append([]scenario.Message(nil), t.history...)
	t.mu.Unlock()

	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	chunk, err := t.reply(wctx, llm, model, v, history)
	if err != nil {
		if wctx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
			return voice.AudioChunk{}, fmt.Errorf("%s: receiveAudio timed out: %w", t.name, voice.ErrReceiveTimeout)
		}
		return voice.AudioChunk{}, err
	}
	t.mu.Lock()
	t.turnEmitted = true
	t.mu.Unlock()
	return chunk, nil
}

func (t *Transport) reply(ctx context.Context, llm scenario.LLM, model, v string, history []scenario.Message) (voice.AudioChunk, error) {
	params := scenario.InferenceParams{Model: model, Messages: history}
	if llm == nil {
		def := scenario.CurrentSettings().DefaultModel
		llm = def.LLM
		if params.Model == "" {
			params.Model = def.Model
		}
		params.Temperature, params.MaxTokens = def.Temperature, def.MaxTokens
	}
	if llm == nil {
		return voice.AudioChunk{}, scenario.ErrNoModel
	}
	res, err := llm.Inference(ctx, params)
	if err != nil {
		return voice.AudioChunk{}, err
	}
	text := res.Message.Text()
	t.mu.Lock()
	t.lastReply = text
	t.history = append(t.history, scenario.AssistantMsg(text))
	t.mu.Unlock()

	audio, err := t.synthesize(ctx, text, v)
	if err != nil {
		return voice.AudioChunk{}, err
	}
	audio.Transcript = ""
	if text != "" && len(audio.Data) > 0 {
		audio.Transcript = text
	}
	return audio, nil
}

// Agent is a composable voice agent as a scenario agent: the default voice
// turn over a [Transport].
type Agent struct {
	*voice.Agent
	t *Transport
}

// NewAgent returns the scenario agent for o (the JavaScript SDK's
// composableAgent factory).
func NewAgent(o Options, opts ...voice.AgentOption) (*Agent, error) {
	t, err := New(o)
	if err != nil {
		return nil, err
	}
	return wrap(t, opts), nil
}

func wrap(t *Transport, opts []voice.AgentOption) *Agent {
	return &Agent{Agent: voice.NewAgent(t, opts...), t: t}
}

// Composable returns the agent's transport, for its seams and transcripts.
func (a *Agent) Composable() *Transport { return a.t }

// String names the agent without credentials.
func (a *Agent) String() string { return a.t.String() }
