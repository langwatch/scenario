package voice

import (
	"context"
	"sync"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/effects"
)

// UserSimulatorOptions configure a voice [UserSimulator].
type UserSimulatorOptions struct {
	// Voice is the "provider/voice" the simulator speaks with, such as
	// "openai/nova". Without it the run's Config.TTSVoice is used.
	Voice string
	// AudioEffects degrade every synthesized turn, applied after the TTS
	// cache so they never enter its key.
	AudioEffects []effects.Effect
	// InterruptProbability in [0, 1] is the chance the simulator barges in
	// on each agent turn during Proceed.
	InterruptProbability float64
	// Synthesize replaces the run's TTS (tests, custom engines).
	Synthesize func(ctx context.Context, text, voice string) (AudioChunk, error)
}

// UserSimulator gives a user simulator a voice: every turn it generates is
// synthesized to audio, so a voice agent under test hears it. It wraps any
// user-role agent, typically scenario.NewUserSimulatorAgent.
type UserSimulator struct {
	inner scenario.AgentAdapter
	opts  UserSimulatorOptions

	mu         sync.Mutex
	style      string
	fx         []effects.Effect
	overrideFX bool
}

// NewUserSimulator wraps a user simulator.
func NewUserSimulator(inner scenario.AgentAdapter, opts UserSimulatorOptions) *UserSimulator {
	return &UserSimulator{inner: inner, opts: opts}
}

// Role implements scenario.AgentAdapter.
func (u *UserSimulator) Role() scenario.AgentRole { return scenario.AgentRoleUser }

// Name implements scenario.Named.
func (u *UserSimulator) Name() string {
	if n, ok := u.inner.(scenario.Named); ok && n.Name() != "" {
		return n.Name()
	}
	return "UserSimulatorAgent"
}

// Extension implements scenario.ExtensionProvider: the voice session.
func (u *UserSimulator) Extension() scenario.Extension { return NewSession() }

// Voice implements VoiceUser: the simulator's own voice.
func (u *UserSimulator) Voice() string { return u.opts.Voice }

// InterruptProbability implements InterruptProber.
func (u *UserSimulator) InterruptProbability() float64 { return u.opts.InterruptProbability }

// Inner returns the wrapped simulator.
func (u *UserSimulator) Inner() scenario.AgentAdapter { return u.inner }

// Call implements scenario.AgentAdapter: the wrapped simulator's text turn,
// voiced when a voice resolves.
func (u *UserSimulator) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	ret, err := u.inner.Call(ctx, in)
	if err != nil || u.voiceFor(in.Executor) == "" {
		return ret, err
	}
	msgs := ret.Messages(scenario.RoleUser)
	out := make([]scenario.Message, len(msgs))
	for i, m := range msgs {
		out[i] = m
		if m.Role != scenario.RoleUser || m.HasAudio() || m.Text() == "" {
			continue
		}
		if out[i], err = u.VoiceifyText(ctx, in.Executor, m.Text()); err != nil {
			return nil, err
		}
	}
	return scenario.MessagesReturn(out...), nil
}

func (u *UserSimulator) voiceFor(ex *scenario.Executor) string {
	if u.opts.Voice != "" {
		return u.opts.Voice
	}
	return ConfigOf(ex).TTSVoice
}

// VoiceifyText implements VoiceUser: text synthesized to a user audio
// message carrying the text as its transcript. Without a voice, or for
// empty text, the text message is returned.
func (u *UserSimulator) VoiceifyText(ctx context.Context, ex *scenario.Executor, text string) (scenario.Message, error) {
	voice := u.voiceFor(ex)
	if voice == "" || text == "" {
		if text != "" {
			resolve(ConfigOf(ex)).warn("[scenario] UserSimulator.VoiceifyText: no voice resolved — sending a TEXT user turn " +
				"to the agent under test. A voice agent will receive text, not audio. Set Voice on the UserSimulator " +
				"(for example \"openai/nova\") or Config.TTSVoice.")
		}
		return scenario.UserMsg(text), nil
	}
	fx, style := u.turnEffects()
	if style != "" {
		voiceStyleWarning.Do(func() {
			resolve(ConfigOf(ex)).warn("UserSimulator: VoiceStyle is accepted for forward compatibility but no TTS " +
				"provider currently honours it. The simulator synthesises without style modification.")
		})
	}
	if s := SessionOf(ex); s != nil {
		if n, ok := s.BackgroundNoise(); ok {
			noise, err := effects.BackgroundNoise(n.Source, n.Volume)
			if err != nil {
				return scenario.Message{}, err
			}
			fx = append(fx, noise)
		}
	}
	var chunk AudioChunk
	var err error
	if u.opts.Synthesize != nil {
		if chunk, err = u.opts.Synthesize(ctx, text, voice); err == nil && len(fx) > 0 {
			chunk.Data = effects.Apply(chunk.Data, fx...)
		}
	} else {
		chunk, err = resolve(ConfigOf(ex)).synthesizer().Synthesize(ctx, text, voice, fx...)
	}
	if err != nil {
		return scenario.Message{}, err
	}
	chunk.Transcript = text
	return AudioMessage(chunk, scenario.RoleUser), nil
}

var voiceStyleWarning sync.Once

func (u *UserSimulator) turnEffects() ([]effects.Effect, string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	fx := u.opts.AudioEffects
	if u.overrideFX {
		fx = u.fx
	}
	return append([]effects.Effect(nil), fx...), u.style
}

// SetOneShotOverride implements OneShotOverrider: the voice style and
// effects of one turn. The returned function restores the previous state.
func (u *UserSimulator) SetOneShotOverride(o UserStepOptions) (restore func()) {
	u.mu.Lock()
	defer u.mu.Unlock()
	prevStyle, prevFX, prevOverride := u.style, u.fx, u.overrideFX
	u.style = o.VoiceStyle
	u.fx, u.overrideFX = o.AudioEffects, o.AudioEffects != nil
	return func() {
		u.mu.Lock()
		defer u.mu.Unlock()
		u.style, u.fx, u.overrideFX = prevStyle, prevFX, prevOverride
	}
}
