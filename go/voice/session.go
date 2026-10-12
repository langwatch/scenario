package voice

import (
	"context"
	"fmt"
	"hash/maphash"
	"slices"
	"sync"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/vad"
	"go.opentelemetry.io/otel/attribute"
)

// ExtensionKey is the key of the voice extension; it also keys the voice
// result in ScenarioResult.Extensions (read it with [ResultOf]).
const ExtensionKey = "voice"

type sessionKey struct{}

// disconnectTimeout bounds one transport's Disconnect at the end of a run.
const disconnectTimeout = 30 * time.Second

// SessionOf returns the voice session of the run ex executes, or nil when
// the run has no voice participant.
func SessionOf(ex *scenario.Executor) *Session {
	if ex == nil {
		return nil
	}
	s, _ := ex.Value(sessionKey{}).(*Session)
	return s
}

// VoiceParticipant is implemented by every scenario agent backed by a voice
// [Agent], including types that embed *Agent to extend it.
type VoiceParticipant interface {
	VoiceAgent() *Agent
}

// VoiceUser is implemented by user simulators that speak: they turn a
// scripted line into an audio user message. A non-empty Voice marks the
// simulator as voice-capable.
type VoiceUser interface {
	Voice() string
	VoiceifyText(ctx context.Context, ex *scenario.Executor, text string) (scenario.Message, error)
}

// InterruptProber is implemented by user simulators that barge in on agent
// turns with a probability during Proceed.
type InterruptProber interface {
	InterruptProbability() float64
}

// participant is a voice agent of the run: the scenario agent value (for
// pending-queue bookkeeping) and the voice runtime behind it.
type participant struct {
	adapter scenario.AgentAdapter
	agent   *Agent
}

// Ambience is the background noise the BackgroundNoise step declared for the
// user simulator's turns.
type Ambience struct {
	Source string
	Volume float64
}

// Session is the per-run voice state and the scenario extension that wires
// voice into the run: it connects and disconnects the voice agents, records
// every segment and timeline event, voices user turns, runs barge-ins and
// attaches the recording to the result. One is created per run; voice
// agents and user simulators bring it automatically.
type Session struct {
	cfg *resolved
	ex  *scenario.Executor

	participants []participant
	users        []scenario.AgentAdapter

	mu        sync.Mutex
	recording *VoiceRecording
	latency   []float64
	ttfb      *float64
	startedAt time.Time
	cursor    float64
	vads      map[*Agent]*vad.Detector
	noise     *Ambience
	playback  *PlaybackSink
	// stepWait is the wait-for-speech budget an Interrupt step threads into
	// the next barge-in; consumed by it.
	stepWait time.Duration
	// bargeInDelay is the delay the proceed-loop scheduler sampled for the
	// next barge-in; consumed by it.
	bargeInDelay time.Duration

	sttCache sync.Map // audioKey -> string
	seed     maphash.Seed
}

// NewSession returns an unstarted session. Voice agents and user simulators
// return one from Extension and the run keeps the first; add one to
// ScenarioConfig.Extensions only for custom voice participants.
func NewSession() *Session { return &Session{} }

// Key implements scenario.Extension.
func (s *Session) Key() string { return ExtensionKey }

// Start implements scenario.RunStarter: it resolves the voice config, and
// when voice agents take part, starts the recording and connects them, each
// under a voice.adapter.connect span.
func (s *Session) Start(ctx context.Context, ex *scenario.Executor) error {
	s.ex = ex
	s.cfg = resolve(ConfigOf(ex))
	s.seed = maphash.MakeSeed()
	ex.SetValue(sessionKey{}, s)
	for _, a := range ex.Agents() {
		if p, ok := a.(VoiceParticipant); ok && p.VoiceAgent() != nil {
			s.participants = append(s.participants, participant{adapter: a, agent: p.VoiceAgent()})
		}
		if a.Role() == scenario.AgentRoleUser {
			s.users = append(s.users, a)
		}
	}
	if len(s.participants) == 0 {
		return nil
	}
	s.recording = &VoiceRecording{Segments: []AudioSegment{}, Timeline: []VoiceEvent{}}
	s.startedAt = s.cfg.Clock.Now()
	s.vads = map[*Agent]*vad.Detector{}
	if s.cfg.AudioPlayback {
		s.playback = NewPlaybackSink(s.cfg.Logger)
		s.playback.Open()
	}
	for _, p := range s.participants {
		a := p.agent
		caps := a.transport.Capabilities()
		err := withSpan(ctx, SpanAdapterConnect, []attribute.KeyValue{
			adapterClass(a.name),
			attribute.String("voice.adapter.role", string(p.adapter.Role())),
			attribute.Bool("voice.adapter.capabilities.native_vad", caps.NativeVAD),
			attribute.Bool("voice.adapter.capabilities.streaming_transcripts", caps.StreamingTranscripts),
			attribute.Bool("voice.adapter.capabilities.dtmf", caps.DTMF),
		}, func(ctx context.Context, _ traceSpan) error { return a.transport.Connect(ctx) })
		if err != nil {
			return err
		}
		if !caps.NativeVAD {
			s.attachVAD(a)
		}
	}
	return nil
}

// Stop implements scenario.RunStopper: it back-fills missing segment
// transcripts, disconnects every voice agent (errors swallowed) and closes
// local playback.
func (s *Session) Stop(ctx context.Context, _ *scenario.Executor) {
	if s.cfg == nil {
		return
	}
	if len(s.participants) > 0 {
		s.backfillTranscripts(ctx)
		for _, p := range s.participants {
			a := p.agent
			// The run's context is already cancelled when the run was, but a
			// disconnect still has work that must reach the far end (Twilio
			// restores the voice URLs it rewrote, a realtime gateway closes
			// its spend record), so it runs detached, under its own bound.
			dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), disconnectTimeout)
			_ = withSpan(dctx, SpanAdapterDisconnect, []attribute.KeyValue{adapterClass(a.name)},
				func(ctx context.Context, _ traceSpan) error { return a.transport.Disconnect(ctx) })
			cancel()
		}
	}
	if s.playback != nil {
		s.playback.Close()
		s.playback = nil
	}
}

// FinalizeResult implements scenario.ResultFinalizer: it flags agent
// segments cut off by a barge-in, computes the latency metrics and attaches
// the voice result.
func (s *Session) FinalizeResult(_ context.Context, _ *scenario.Executor, r *scenario.ScenarioResult) error {
	if s.recording == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.recording
	MarkTruncatedAgentSegments(rec.Segments, rec.Timeline)
	var irt *float64
	if v, ok := InterruptResponseTime(rec.Timeline); ok {
		irt = &v
	}
	lat := ComputeLatencyMetrics(s.latency, s.ttfb, irt)
	r.SetExtension(ExtensionKey, &Result{Recording: rec, Timeline: rec.Timeline, Latency: &lat})
	return nil
}

// Timeline returns a snapshot of the timeline so far, for custom steps that
// assert on it mid-scenario. Empty for text-only runs.
func (s *Session) Timeline() []VoiceEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recording == nil {
		return nil
	}
	return slices.Clone(s.recording.Timeline)
}

// BackgroundNoise returns the ambience declared by the BackgroundNoise step.
func (s *Session) BackgroundNoise() (Ambience, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.noise == nil {
		return Ambience{}, false
	}
	return *s.noise, true
}

func (s *Session) setBackgroundNoise(n Ambience) {
	s.mu.Lock()
	s.noise = &n
	s.mu.Unlock()
}

// agentUnderTest is the voice agent barge-ins target: the first voice
// participant playing the agent role, else the first voice participant.
func (s *Session) agentUnderTest() *participant {
	for i := range s.participants {
		if s.participants[i].adapter.Role() == scenario.AgentRoleAgent {
			return &s.participants[i]
		}
	}
	if len(s.participants) > 0 {
		return &s.participants[0]
	}
	return nil
}

// voiceUserSim is the first user-role agent that can voice text.
func (s *Session) voiceUserSim() VoiceUser {
	for _, a := range s.users {
		if v, ok := a.(VoiceUser); ok && v.Voice() != "" {
			return v
		}
	}
	return nil
}

// realtimeUser is the first user-role agent that speaks natively.
func (s *Session) realtimeUser() RealtimeUser {
	for _, a := range s.users {
		if r, ok := a.(RealtimeUser); ok {
			return r
		}
	}
	return nil
}

func (s *Session) attachVAD(a *Agent) {
	vad.WarnFallbackOnce(a.name, func(m string) { s.cfg.warn(m) })
	s.vads[a] = vad.NewDetector(vad.Options{
		OnSpeechStart: func() {
			s.appendEvent(VoiceEvent{Type: UserStartSpeaking, Time: s.nowOffset(), Metadata: map[string]any{"source": "vad-fallback"}})
		},
		OnSpeechEnd: func() {
			s.appendEvent(VoiceEvent{Type: UserStopSpeaking, Time: s.nowOffset(), Metadata: map[string]any{"source": "vad-fallback"}})
		},
	})
}

// feedVAD runs user audio through the agent's fallback detector.
func (s *Session) feedVAD(a *Agent, c AudioChunk) {
	s.mu.Lock()
	d := s.vads[a]
	s.mu.Unlock()
	if d != nil {
		d.Process(c.Data)
	}
}

// nowOffset is the wall-clock time since the recording started, in seconds.
func (s *Session) nowOffset() float64 {
	if s.startedAt.IsZero() {
		return 0
	}
	return s.cfg.Clock.Now().Sub(s.startedAt).Seconds()
}

// cursorNow is the byte-accurate audio cursor, in seconds.
func (s *Session) cursorNow() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursor
}

// appendEvent adds an event to the timeline and reports it to the hook;
// hook panics are recovered so observability never breaks a run.
func (s *Session) appendEvent(e VoiceEvent) {
	s.mu.Lock()
	if s.recording != nil {
		s.recording.Timeline = append(s.recording.Timeline, e)
	}
	s.mu.Unlock()
	if hook := s.cfg.OnVoiceEvent; hook != nil {
		safeCall(func() { hook(e) })
	}
}

// fireAudioChunk reports a recorded chunk to the hook and the playback sink.
func (s *Session) fireAudioChunk(c AudioChunk) {
	if hook := s.cfg.OnAudioChunk; hook != nil {
		safeCall(func() { hook(c) })
	}
	if s.playback != nil {
		safeCall(func() { s.playback.SendChunk(c) })
	}
}

func safeCall(fn func()) {
	defer func() { _ = recover() }()
	fn()
}

// laySegment places a segment end to end on the audio cursor, so its length
// is its true audio length and the recording duration matches full.wav.
func (s *Session) laySegment(speaker Speaker, c AudioChunk) (start, end float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start = s.cursor
	end = start + c.Seconds()
	s.cursor = end
	if s.recording != nil {
		s.recording.Segments = append(s.recording.Segments, AudioSegment{
			Speaker: speaker, StartTime: start, EndTime: end, Audio: c.Data, Transcript: c.Transcript,
		})
	}
	return start, end
}

// writeUserSegment records a user segment with its speaking events.
func (s *Session) writeUserSegment(c AudioChunk) {
	if len(c.Data) == 0 {
		return
	}
	s.fireAudioChunk(c)
	start, end := s.laySegment(SpeakerUser, c)
	s.appendEvent(VoiceEvent{Type: UserStartSpeaking, Time: start})
	s.appendEvent(VoiceEvent{Type: UserStopSpeaking, Time: end})
}

func (s *Session) recordLatency(l float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latency = append(s.latency, l)
	if s.ttfb == nil {
		v := l
		s.ttfb = &v
	}
}

// attributeLeftover handles prior-turn audio a buffering transport drained
// at a user-turn boundary: it grows the previous agent segment when that is
// still last on the cursor, else drops the audio with a warning.
func (s *Session) attributeLeftover(left AudioChunk) {
	s.mu.Lock()
	var last *AudioSegment
	if s.recording != nil && len(s.recording.Segments) > 0 {
		last = &s.recording.Segments[len(s.recording.Segments)-1]
	}
	if last == nil || last.Speaker != SpeakerAgent {
		s.mu.Unlock()
		s.cfg.warn("drained prior-turn leftover audio at a boundary where it cannot be attributed cursor-safely "+
			"(no prior agent segment, or a user segment is last, e.g. barge-in) — dropped so it is not emitted as a fake next turn",
			"dropped_seconds", left.Seconds())
		return
	}
	oldEnd := last.EndTime
	grown := make([]byte, 0, len(last.Audio)+len(left.Data))
	last.Audio = append(append(grown, last.Audio...), left.Data...)
	last.EndTime = oldEnd + left.Seconds()
	last.TranscriptTruncated = true
	s.cursor = last.EndTime
	tl := s.recording.Timeline
	for i := len(tl) - 1; i >= 0; i-- {
		if tl[i].Type == AgentStopSpeaking && abs(tl[i].Time-oldEnd) < 1e-6 {
			tl[i].Time = last.EndTime
			break
		}
	}
	s.mu.Unlock()
	s.fireAudioChunk(left)
	s.cfg.warn("reconciled prior-turn leftover audio into the previous agent segment so it is not emitted as a fake next turn",
		"reconciled_seconds", left.Seconds())
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// backfillTranscripts transcribes the segments without a transcript (and
// the truncated ones, from what actually played) so the manifest reads as a
// conversation even over audio-only transports. Best effort.
func (s *Session) backfillTranscripts(ctx context.Context) {
	s.mu.Lock()
	var targets []int
	if s.recording != nil {
		for i, seg := range s.recording.Segments {
			if len(seg.Audio) > 0 && (seg.TranscriptTruncated || isBlank(seg.Transcript)) {
				targets = append(targets, i)
			}
		}
	}
	s.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	provider, err := s.cfg.sttProvider()
	if err != nil || provider == nil {
		return
	}
	_ = withSpan(ctx, SpanSTTBackfill, []attribute.KeyValue{
		attribute.String("voice.stt.scope", "run"),
		attribute.Int("voice.stt.segment_count", len(targets)),
		attribute.String("langwatch.origin", "simulation"),
		attribute.String("scenario.run_id", s.ex.RunID()),
		attribute.String("langwatch.thread.id", s.ex.ThreadID()),
	}, func(ctx context.Context, _ traceSpan) error {
		var wg sync.WaitGroup
		slots := make(chan struct{}, maxConcurrentTranscriptions)
		for _, i := range targets {
			s.mu.Lock()
			seg := s.recording.Segments[i]
			s.mu.Unlock()
			wg.Add(1)
			slots <- struct{}{}
			go func() {
				defer func() { <-slots; wg.Done() }()
				text, err := s.transcribeSegment(ctx, provider, seg)
				if err != nil {
					s.cfg.warn(fmt.Sprintf("voice: STT back-fill failed for a %s segment; manifest transcript left unset (%v)", seg.Speaker, err))
					return
				}
				if text != "" {
					s.mu.Lock()
					s.recording.Segments[i].Transcript = text
					s.mu.Unlock()
				}
			}()
		}
		wg.Wait()
		return nil
	})
}

func (s *Session) transcribeSegment(ctx context.Context, provider sttProvider, seg AudioSegment) (string, error) {
	var text string
	err := withSpan(ctx, SpanSTTTranscribe, []attribute.KeyValue{
		attribute.String("voice.stt.scope", "run"),
		attribute.String("voice.stt.speaker", string(seg.Speaker)),
		attribute.Int("voice.stt.audio_bytes", len(seg.Audio)),
	}, func(ctx context.Context, span traceSpan) error {
		t, err := provider.Transcribe(ctx, AudioChunk{Data: seg.Audio})
		if err != nil {
			// Provider errors may embed response bodies or key fragments;
			// the span records only the error type.
			s.cfg.Logger.Debug("voice: STT provider error", "speaker", seg.Speaker, "error", err)
			return fmt.Errorf("STT provider failed: %T", err)
		}
		text = trimSpace(t)
		if text != "" {
			SetSpanAttributes(span, attribute.Int("voice.stt.transcript_chars", len(text)))
		}
		return nil
	})
	return text, err
}
