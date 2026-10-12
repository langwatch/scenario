// Package voicetest provides in-memory fakes for testing voice scenarios
// without a network: a scripted transport, a virtual clock, STT and TTS
// stubs, and helpers to build PCM16 audio.
package voicetest

import (
	"context"
	"sync"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
)

// Tone returns seconds of a non-silent PCM16 test signal.
func Tone(seconds float64, transcript string) voice.AudioChunk {
	n := audio.SamplesFor(seconds)
	data := make([]byte, 2*n)
	for i := range n {
		audio.PutSample(data, i, int16((i*97)%20000-10000))
	}
	return voice.AudioChunk{Data: data, Transcript: transcript}
}

// Turn is one scripted agent reply of a [Transport]: its chunks, delivered
// one per ReceiveAudio (the first after Delay, the others after Gap), then
// an empty chunk ending the turn.
type Turn struct {
	Delay  time.Duration
	Gap    time.Duration
	Chunks []voice.AudioChunk
}

// Transport is a scripted in-memory voice transport. Zero fields are
// harmless defaults; Caps defaults to native VAD so no fallback warning
// fires. It is safe for concurrent use.
type Transport struct {
	// TransportName is reported as the adapter name.
	TransportName string
	Caps          voice.Capabilities
	// Turns are the agent's replies, in order. When they run out, each
	// receive returns an empty chunk.
	Turns []Turn
	// ConnectErr, DisconnectErr and SendErr are returned by those calls.
	ConnectErr, DisconnectErr, SendErr error
	// Receive replaces the scripted receive.
	Receive func(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error)

	mu          sync.Mutex
	connected   bool
	connects    int
	disconnects int
	sent        []voice.AudioChunk
	turn, chunk int
	interrupts  int
	dtmf        []string
}

// Name implements voice.Named.
func (t *Transport) Name() string {
	if t.TransportName != "" {
		return t.TransportName
	}
	return "FakeVoiceAdapter"
}

// Capabilities implements voice.Transport.
func (t *Transport) Capabilities() voice.Capabilities {
	if t.Caps.InputFormats == nil && !t.Caps.NativeVAD && !t.Caps.Interruption && !t.Caps.DTMF && !t.Caps.StreamingTranscripts {
		return voice.Capabilities{NativeVAD: true}
	}
	return t.Caps
}

// Connect implements voice.Transport.
func (t *Transport) Connect(context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.connects++
	if t.ConnectErr != nil {
		return t.ConnectErr
	}
	t.connected = true
	return nil
}

// Disconnect implements voice.Transport.
func (t *Transport) Disconnect(context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.disconnects++
	t.connected = false
	return t.DisconnectErr
}

// SendAudio implements voice.Transport.
func (t *Transport) SendAudio(_ context.Context, c voice.AudioChunk) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.SendErr != nil {
		return t.SendErr
	}
	t.sent = append(t.sent, c)
	return nil
}

// ReceiveAudio implements voice.Transport.
func (t *Transport) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	if t.Receive != nil {
		return t.Receive(ctx, timeout)
	}
	t.mu.Lock()
	if t.turn >= len(t.Turns) {
		t.mu.Unlock()
		return voice.AudioChunk{}, nil
	}
	turn := t.Turns[t.turn]
	if t.chunk >= len(turn.Chunks) {
		t.turn++
		t.chunk = 0
		t.mu.Unlock()
		return voice.AudioChunk{}, nil
	}
	c := turn.Chunks[t.chunk]
	first := t.chunk == 0
	t.chunk++
	t.mu.Unlock()
	wait := turn.Gap
	if first {
		wait = turn.Delay
	}
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return voice.AudioChunk{}, ctx.Err()
		}
	}
	return c, nil
}

// Interrupt implements voice.Interrupter.
func (t *Transport) Interrupt(context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.interrupts++
	return nil
}

// SendDTMF implements voice.DTMFSender.
func (t *Transport) SendDTMF(_ context.Context, tones string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dtmf = append(t.dtmf, tones)
	return nil
}

// Connects returns how often Connect was called.
func (t *Transport) Connects() int { t.mu.Lock(); defer t.mu.Unlock(); return t.connects }

// Disconnects returns how often Disconnect was called.
func (t *Transport) Disconnects() int { t.mu.Lock(); defer t.mu.Unlock(); return t.disconnects }

// Sent returns the chunks sent so far.
func (t *Transport) Sent() []voice.AudioChunk {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]voice.AudioChunk(nil), t.sent...)
}

// Interrupts returns how often Interrupt was called.
func (t *Transport) Interrupts() int { t.mu.Lock(); defer t.mu.Unlock(); return t.interrupts }

// DTMF returns the tones sent.
func (t *Transport) DTMF() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.dtmf...)
}

// Clock is a virtual clock: Sleep advances it instantly.
type Clock struct {
	mu  sync.Mutex
	now time.Time
}

// NewClock returns a virtual clock at a fixed epoch.
func NewClock() *Clock { return &Clock{now: time.Unix(1_700_000_000, 0)} }

// Now implements voice.Clock.
func (c *Clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }

// Sleep implements voice.Clock.
func (c *Clock) Sleep(ctx context.Context, d time.Duration) error {
	c.Advance(d)
	return ctx.Err()
}

// Advance moves the clock forward.
func (c *Clock) Advance(d time.Duration) {
	if d <= 0 {
		return
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// STT transcribes every chunk as Text (or with Fn), counting calls.
type STT struct {
	Text string
	Err  error
	Fn   func(voice.AudioChunk) (string, error)

	mu    sync.Mutex
	calls int
}

// Transcribe implements stt.Provider.
func (s *STT) Transcribe(_ context.Context, c voice.AudioChunk) (string, error) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	if s.Fn != nil {
		return s.Fn(c)
	}
	return s.Text, s.Err
}

// Calls returns how often Transcribe ran.
func (s *STT) Calls() int { s.mu.Lock(); defer s.mu.Unlock(); return s.calls }

// Synthesize is a TTS stub for UserSimulatorOptions.Synthesize: a tone
// whose length follows the text.
func Synthesize(_ context.Context, text, _ string) (voice.AudioChunk, error) {
	return Tone(0.05+0.01*float64(len(text)%10), text), nil
}

// User is a scripted voice user simulator: it returns Lines in order (then
// the last one), voiced with [Synthesize].
type User struct {
	Lines       []string
	VoiceName   string
	Probability float64

	mu sync.Mutex
	n  int
}

// Role implements scenario.AgentAdapter.
func (u *User) Role() scenario.AgentRole { return scenario.AgentRoleUser }

// Call implements scenario.AgentAdapter.
func (u *User) Call(ctx context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
	u.mu.Lock()
	line := "hello"
	if len(u.Lines) > 0 {
		line = u.Lines[min(u.n, len(u.Lines)-1)]
	}
	u.n++
	u.mu.Unlock()
	c, _ := Synthesize(ctx, line, u.Voice())
	return scenario.MessageReturn(voice.AudioMessage(c, scenario.RoleUser)), nil
}

// Voice implements voice.VoiceUser.
func (u *User) Voice() string {
	if u.VoiceName != "" {
		return u.VoiceName
	}
	return "fake/voice"
}

// VoiceifyText implements voice.VoiceUser.
func (u *User) VoiceifyText(ctx context.Context, _ *scenario.Executor, text string) (scenario.Message, error) {
	c, _ := Synthesize(ctx, text, u.Voice())
	return voice.AudioMessage(c, scenario.RoleUser), nil
}

// InterruptProbability implements voice.InterruptProber.
func (u *User) InterruptProbability() float64 { return u.Probability }

// Extension implements scenario.ExtensionProvider.
func (u *User) Extension() scenario.Extension { return voice.NewSession() }

// Judge ends the run with a passing verdict on every call (Verdict) or lets
// it continue (nil Verdict).
type Judge struct {
	Verdict *scenario.JudgeResult
}

// Role implements scenario.AgentAdapter.
func (j *Judge) Role() scenario.AgentRole { return scenario.AgentRoleJudge }

// Call implements scenario.AgentAdapter.
func (j *Judge) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	if j.Verdict == nil {
		return nil, nil
	}
	return scenario.VerdictReturn(*j.Verdict), nil
}

// Pass is a passing verdict.
func Pass() *scenario.JudgeResult {
	return &scenario.JudgeResult{Success: true, Reasoning: "ok", MetCriteria: []string{}, UnmetCriteria: []string{}}
}
