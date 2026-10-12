package voice

import (
	"context"
	"fmt"
	"strings"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/effects"
	"github.com/langwatch/scenario/go/voice/ffmpeg"
)

// Voice script steps. They compose with the core steps (User, Agent,
// Judge, Proceed): a voice script is a scenario script.

const (
	defaultInterruptWait = 8 * time.Second
	streamingWordsPoll   = 50 * time.Millisecond
)

var audioExtensions = [...]string{".wav", ".mp3", ".ogg", ".flac"}

// firstVoiceAgent returns the first voice participant of the scenario.
func firstVoiceAgent(ex *scenario.Executor) (*Agent, scenario.AgentAdapter) {
	for _, a := range ex.Agents() {
		if p, ok := a.(VoiceParticipant); ok && p.VoiceAgent() != nil {
			return p.VoiceAgent(), a
		}
	}
	return nil, nil
}

func clockOf(ex *scenario.Executor) Clock {
	if s := SessionOf(ex); s != nil {
		return s.cfg.Clock
	}
	if c := ConfigOf(ex).Clock; c != nil {
		return c
	}
	return SystemClock{}
}

// Sleep pauses the script for d. Nothing is sent: see [Silence] to send
// silent audio.
func Sleep(d time.Duration) scenario.ScriptStep {
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		return clockOf(ex).Sleep(ctx, d)
	})
}

// Silence sends d of silent audio to the agent: the transport sees a
// connected but silent user. Without a voice agent it pauses instead.
func Silence(d time.Duration) scenario.ScriptStep {
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		a, _ := firstVoiceAgent(ex)
		if a == nil {
			return clockOf(ex).Sleep(ctx, d)
		}
		return a.transport.SendAudio(ctx, AudioChunk{Data: make([]byte, audioBytesFor(d))})
	})
}

// AudioFile sends a pre-recorded WAV, MP3, OGG or FLAC file to the agent as
// the user's audio, bypassing the user simulator and TTS. WAV decodes
// natively; other formats need ffmpeg. URL-like paths are refused.
func AudioFile(path string) scenario.ScriptStep {
	return audioStep(func(ctx context.Context) ([]byte, error) { return ffmpeg.DecodeFile(ctx, path) })
}

// AudioBytes sends encoded audio bytes (a WAV, MP3, ... file's content) to
// the agent as the user's audio.
func AudioBytes(data []byte) scenario.ScriptStep {
	return audioStep(func(ctx context.Context) ([]byte, error) { return ffmpeg.DecodeBytes(ctx, data) })
}

func audioStep(load func(context.Context) ([]byte, error)) scenario.ScriptStep {
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		pcm, err := load(ctx)
		if err != nil {
			return err
		}
		a, _ := firstVoiceAgent(ex)
		if a == nil {
			return nil
		}
		return a.transport.SendAudio(ctx, AudioChunk{Data: pcm[:len(pcm)&^1]})
	})
}

// DTMF sends DTMF tones (telephony only). It fails with an
// UnsupportedCapabilityError unless the voice agent advertises DTMF.
func DTMF(tones string) scenario.ScriptStep {
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		a, _ := firstVoiceAgent(ex)
		if a == nil {
			return &UnsupportedCapabilityError{Adapter: "<no voice adapter>", Capability: "dtmf"}
		}
		if !a.Capabilities().DTMF {
			return &UnsupportedCapabilityError{Adapter: a.name, Capability: "dtmf"}
		}
		s, ok := a.transport.(DTMFSender)
		if !ok {
			return &UnsupportedCapabilityError{Adapter: a.name, Capability: "dtmf",
				Hint: "This adapter declares Capabilities.DTMF but does not implement SendDTMF. " +
					"Implement voice.DTMFSender on the transport or clear Capabilities.DTMF."}
		}
		return s.SendDTMF(ctx, tones)
	})
}

// InterruptOption configures an [Interrupt] step.
type InterruptOption func(*interruptOptions)

type interruptOptions struct {
	text          string
	audioPath     string
	audioBytes    []byte
	after         time.Duration
	hasAfter      bool
	afterWords    int
	hasAfterWords bool
	wait          time.Duration
}

// WithContent sets the interrupting line: text is voiced like a user turn,
// a path ending in .wav/.mp3/.ogg/.flac is sent as an audio file.
func WithContent(content string) InterruptOption {
	return func(o *interruptOptions) {
		lower := strings.ToLower(content)
		for _, ext := range audioExtensions {
			if strings.HasSuffix(lower, ext) {
				o.audioPath = content
				return
			}
		}
		o.text = content
	}
}

// WithAudioContent interrupts with encoded audio bytes.
func WithAudioContent(data []byte) InterruptOption {
	return func(o *interruptOptions) { o.audioBytes = data }
}

// After interrupts d after the agent starts speaking.
func After(d time.Duration) InterruptOption {
	return func(o *interruptOptions) { o.after, o.hasAfter = d, true }
}

// AfterWords interrupts once the agent's streaming transcript holds n
// words. It needs Capabilities.StreamingTranscripts and takes precedence
// over After.
func AfterWords(n int) InterruptOption {
	return func(o *interruptOptions) { o.afterWords, o.hasAfterWords = n, true }
}

// WaitForSpeechTimeout bounds the wait for the agent to start speaking
// (default 8s).
func WaitForSpeechTimeout(d time.Duration) InterruptOption {
	return func(o *interruptOptions) { o.wait = d }
}

func (o *interruptOptions) isAudio() bool { return o.audioPath != "" || o.audioBytes != nil }

// Interrupt starts the agent's turn in the background and barges in on it:
// after it started speaking (default), d into its speech (After), or once
// it said n words (AfterWords). The barge-in overlaps real agent audio, so
// the agent's VAD detects it even without a native interrupt signal.
func Interrupt(opts ...InterruptOption) scenario.ScriptStep {
	o := interruptOptions{wait: defaultInterruptWait}
	for _, opt := range opts {
		opt(&o)
	}
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		startNonBlocking(ctx, ex)
		switch {
		case o.hasAfterWords:
			if err := waitForStreamingWords(ctx, ex, o.afterWords, o.wait); err != nil {
				return err
			}
		case o.hasAfter:
			waitForAgentSpeaking(ctx, ex, o.wait)
			if err := clockOf(ex).Sleep(ctx, o.after); err != nil {
				return err
			}
		case o.isAudio():
			// Audio goes straight to the transport, so this is its only wait;
			// text content waits inside the barge-in instead.
			waitForAgentSpeaking(ctx, ex, o.wait)
		}
		switch {
		case o.audioPath != "":
			return AudioFile(o.audioPath).Run(ctx, ex)
		case o.audioBytes != nil:
			return AudioBytes(o.audioBytes).Run(ctx, ex)
		}
		if s := SessionOf(ex); s != nil {
			s.setStepWait(o.wait)
		}
		return ex.User(ctx, o.text)
	})
}

// startNonBlocking re-arms the speaking event and starts the agent turn in
// the background.
func startNonBlocking(ctx context.Context, ex *scenario.Executor, content ...scenario.Message) {
	if a, _ := firstVoiceAgent(ex); a != nil && len(content) == 0 {
		a.speaking.Clear()
	}
	ex.AgentNonBlocking(ctx, content...)
}

func waitForAgentSpeaking(ctx context.Context, ex *scenario.Executor, timeout time.Duration) {
	a, _ := firstVoiceAgent(ex)
	if a == nil || a.speaking.IsSet() {
		return
	}
	waitOrSleep(ctx, a.speaking.Wait(), timeout)
}

func waitForStreamingWords(ctx context.Context, ex *scenario.Executor, n int, timeout time.Duration) error {
	a, _ := firstVoiceAgent(ex)
	name := "<no voice adapter>"
	if a != nil {
		name = a.name
	}
	var st StreamingTranscriber
	if a != nil && a.Capabilities().StreamingTranscripts {
		st, _ = a.transport.(StreamingTranscriber)
	}
	if st == nil {
		return &UnsupportedCapabilityError{Adapter: name, Capability: "streaming_transcripts",
			Hint: "Interrupt(AfterWords(n)) needs incremental transcripts. Use Interrupt(WithContent(...)) without " +
				"AfterWords on this adapter — the barge-in fires at the agent's first audio chunk."}
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(strings.Fields(st.StreamingTranscript())) >= n {
			return nil
		}
		if err := (SystemClock{}).Sleep(ctx, streamingWordsPoll); err != nil {
			return err
		}
	}
	return nil
}

// VoiceAgentOptions configure a [VoiceAgent] step.
type VoiceAgentOptions struct {
	// Content, when set, is the agent's turn instead of a response of the
	// agent under test.
	Content string
	// NoWait starts the turn in the background: the agent's audio keeps
	// streaming during the following steps, and a later user turn barges in.
	NoWait bool
}

// VoiceAgent is the agent step with the non-blocking form voice needs.
func VoiceAgent(opts VoiceAgentOptions) scenario.ScriptStep {
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		if !opts.NoWait {
			return ex.Agent(ctx, opts.Content)
		}
		var content []scenario.Message
		if opts.Content != "" {
			content = []scenario.Message{scenario.AssistantMsg(opts.Content)}
		}
		startNonBlocking(ctx, ex, content...)
		return nil
	})
}

// AgentNonBlocking starts the agent's turn without waiting for it; it is
// VoiceAgent(VoiceAgentOptions{NoWait: true}).
func AgentNonBlocking() scenario.ScriptStep { return VoiceAgent(VoiceAgentOptions{NoWait: true}) }

// BackgroundNoise mixes ambience into the user simulator's following turns:
// a preset ("cafe", "street", "office", "airport", "babble") or a WAV path,
// at volume in [0, 1].
func BackgroundNoise(source string, volume float64) scenario.ScriptStep {
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		if volume < 0 || volume > 1 {
			return fmt.Errorf("BackgroundNoise(volume=%v) out of range — expected [0, 1]", volume)
		}
		if s := SessionOf(ex); s != nil {
			s.setBackgroundNoise(Ambience{Source: source, Volume: volume})
		}
		return nil
	})
}

// UserStepOptions are one-turn overrides of a voice user simulator.
type UserStepOptions struct {
	// VoiceStyle styles this turn's voice (accepted for forward
	// compatibility; no TTS provider honours it yet).
	VoiceStyle string
	// AudioEffects replace the simulator's effects for this turn.
	AudioEffects []effects.Effect
}

// OneShotOverrider is implemented by user simulators that accept per-step
// overrides.
type OneShotOverrider interface {
	SetOneShotOverride(UserStepOptions) (restore func())
}

// User is the user step with one-turn voice overrides: text, or a generated
// turn without it, voiced with opts on the scenario's voice user simulator.
func User(opts UserStepOptions, text ...string) scenario.ScriptStep {
	content := ""
	if len(text) > 0 {
		content = text[0]
	}
	return scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		if opts.VoiceStyle != "" || opts.AudioEffects != nil {
			for _, a := range ex.Agents() {
				if o, ok := a.(OneShotOverrider); ok {
					defer o.SetOneShotOverride(opts)()
					break
				}
			}
		}
		return ex.User(ctx, content)
	})
}

// audioBytesFor is the PCM16 byte length of d.
func audioBytesFor(d time.Duration) int {
	return audio.SamplesFor(d.Seconds()) * audio.SampleWidth
}
