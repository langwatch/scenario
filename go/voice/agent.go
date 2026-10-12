package voice

import (
	"context"
	"log/slog"
	"strings"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel/attribute"
)

// Turn timing defaults, identical to the JavaScript and Python SDKs so a
// scenario passes or fails the same way in each.
const (
	DefaultResponseTimeout     = 60 * time.Second
	DefaultResponseTailSilence = 600 * time.Millisecond
	DefaultResponseMaxDuration = 30 * time.Second
	DefaultTranscriptGraceWait = 2 * time.Second

	// maxDurationCeilingFactor bounds one agent turn at this multiple of
	// ResponseMaxDuration. ResponseMaxDuration itself only warns, so a long
	// single utterance is not split across turns; the ceiling stops a
	// transport that never signals the end of its stream.
	maxDurationCeilingFactor = 2
	transcriptGracePoll      = 10 * time.Millisecond
)

// Agent is a scenario agent backed by a voice [Transport]. Each call sends
// the latest user audio, drains the agent's spoken reply until it falls
// silent, records both into the run's voice session and returns the reply
// as an assistant audio message.
//
// The timing fields may be changed before the run starts.
type Agent struct {
	transport Transport
	role      scenario.AgentRole
	name      string

	// ResponseTimeout is how long a turn waits for the agent's first audio:
	// the STT + LLM + TTS budget of one turn. Raise it for agents that run a
	// tool or retrieval step before they speak.
	ResponseTimeout time.Duration
	// ResponseTailSilence ends the turn once no audio arrived for this long.
	ResponseTailSilence time.Duration
	// ResponseMaxDuration is a soft cap on one turn's audio: crossing it
	// warns; the turn is cut at twice it.
	ResponseMaxDuration time.Duration
	// TranscriptGraceWait bounds the wait, after the audio drained, for a
	// turn transcript a TranscriptSource delivers separately. 0 disables it.
	TranscriptGraceWait time.Duration

	speaking SpeakingEvent
}

// AgentOption configures an Agent.
type AgentOption func(*Agent)

// WithRole sets the role the agent plays (default AgentRoleAgent).
func WithRole(r scenario.AgentRole) AgentOption { return func(a *Agent) { a.role = r } }

// WithName overrides the name reported in spans, warnings and LangWatch.
func WithName(name string) AgentOption { return func(a *Agent) { a.name = name } }

// NewAgent wraps a transport as a scenario agent.
func NewAgent(t Transport, opts ...AgentOption) *Agent {
	a := &Agent{
		transport:           t,
		role:                scenario.AgentRoleAgent,
		name:                transportName(t),
		ResponseTimeout:     DefaultResponseTimeout,
		ResponseTailSilence: DefaultResponseTailSilence,
		ResponseMaxDuration: DefaultResponseMaxDuration,
		TranscriptGraceWait: DefaultTranscriptGraceWait,
	}
	for _, o := range opts {
		o(a)
	}
	return a
}

// Role implements scenario.AgentAdapter.
func (a *Agent) Role() scenario.AgentRole { return a.role }

// Name implements scenario.Named.
func (a *Agent) Name() string { return a.name }

// Transport returns the wrapped transport.
func (a *Agent) Transport() Transport { return a.transport }

// Capabilities returns the transport's capabilities.
func (a *Agent) Capabilities() Capabilities { return a.transport.Capabilities() }

// VoiceAgent implements VoiceParticipant.
func (a *Agent) VoiceAgent() *Agent { return a }

// Extension implements scenario.ExtensionProvider: the voice session.
func (a *Agent) Extension() scenario.Extension { return NewSession() }

// Speaking returns the event set when the agent's first audio of the
// current turn arrived.
func (a *Agent) Speaking() *SpeakingEvent { return &a.speaking }

// Call implements scenario.AgentAdapter with [Agent.Turn].
func (a *Agent) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	msgs, err := a.Turn(ctx, in)
	if err != nil {
		return nil, err
	}
	return scenario.MessagesReturn(msgs...), nil
}

// Turn runs one default voice turn and returns its messages: the agent's
// audio reply, or none when the agent already hung up. Types embedding
// *Agent call it from their own Call to extend the turn.
func (a *Agent) Turn(ctx context.Context, in scenario.AgentInput) ([]scenario.Message, error) {
	if cr, ok := a.transport.(ConnectionReporter); ok && !cr.IsConnected() {
		if hr, ok := a.transport.(HangupReporter); ok && hr.AgentHungUp() {
			// The agent ended the call on purpose; a scripted turn left over
			// has nobody to talk to, so the conversation concludes here and
			// the script falls through to the judge.
			a.logger(in).Info(a.name + ": agent ended the call; concluding the conversation instead of failing the remaining scripted turn(s)")
			return nil, nil
		}
		return nil, &PendingTransportError{Adapter: a.name}
	}
	attrs := []attribute.KeyValue{adapterClass(a.name)}
	if in.ScenarioState != nil {
		attrs = append(attrs, attribute.Int("voice.turn.index", in.ScenarioState.CurrentTurn()))
	}
	ctx, span := StartSpan(ctx, SpanTurn, attrs...)
	if obs, ok := a.transport.(TurnObserver); ok {
		obs.BeginTurn(ctx)
		defer obs.EndTurn()
	}
	msg, err := a.runTurn(ctx, in, span)
	EndSpan(span, err)
	if err != nil {
		return nil, err
	}
	return []scenario.Message{msg}, nil
}

func (a *Agent) logger(in scenario.AgentInput) *slog.Logger {
	if s := SessionOf(in.Executor); s != nil {
		return s.cfg.Logger
	}
	return resolve(Config{}).Logger
}

func (a *Agent) runTurn(ctx context.Context, in scenario.AgentInput, turnSpan traceSpan) (scenario.Message, error) {
	turnStart := time.Now()
	a.speaking.Clear()
	s := SessionOf(in.Executor)
	rec := turnRecorder{s: s}

	incoming, hasIncoming := lastAudio(in.NewMessages)
	if hasIncoming {
		a.reconcilePrior(s)
		err := withSpan(ctx, SpanAudioSend, []attribute.KeyValue{attribute.Int("voice.audio.bytes", len(incoming.Data))},
			func(ctx context.Context, _ traceSpan) error { return a.transport.SendAudio(ctx, incoming) })
		if err != nil {
			return scenario.Message{}, err
		}
		if s != nil {
			s.feedVAD(a, incoming)
		}
		rec.recordUser(incoming)
		// Scope the transcript to this reply: one left from a previous turn
		// must not label audio this turn produced.
		if ts, ok := a.transport.(TranscriptSource); ok {
			ts.ResetAgentTranscript()
		}
	}

	merged, err := a.drain(ctx, s, rec.markAgentStart)
	if err != nil {
		return scenario.Message{}, err
	}
	if len(merged.Data) > 0 && merged.Transcript == "" {
		a.awaitTranscript(ctx)
	}
	SetSpanAttributes(turnSpan, attribute.Int64("voice.turn.latency_ms", time.Since(turnStart).Milliseconds()))
	if hasIncoming && len(incoming.Data) > 0 {
		SetSpanAttributes(turnSpan, attribute.Int("voice.turn.user_audio_bytes", len(incoming.Data)))
	}
	if len(merged.Data) > 0 {
		SetSpanAttributes(turnSpan, attribute.Int("voice.turn.agent_audio_bytes", len(merged.Data)))
	}
	spoken := a.attachTranscript(merged)
	rec.recordAgent(spoken)
	return AudioMessage(spoken, scenario.RoleAssistant), nil
}

// lastAudio extracts the audio of the most recent new message.
func lastAudio(msgs []scenario.Message) (AudioChunk, bool) {
	if len(msgs) == 0 {
		return AudioChunk{}, false
	}
	return ExtractAudio(msgs[len(msgs)-1])
}

// drain receives the agent's reply until it falls silent, ends its stream,
// or reaches the hard ceiling, under a voice.audio.receive span.
func (a *Agent) drain(ctx context.Context, s *Session, onFirst func()) (AudioChunk, error) {
	ctx, span := StartSpan(ctx, SpanAudioReceive)
	start := time.Now()
	first, err := a.transport.ReceiveAudio(ctx, a.ResponseTimeout)
	if err != nil {
		SetSpanAttributes(span, attribute.String("voice.audio.terminated_reason", "first_chunk_timeout"))
		EndSpan(span, err)
		return AudioChunk{}, err
	}
	SetSpanAttributes(span, attribute.Int64("voice.audio.first_chunk_latency_ms", time.Since(start).Milliseconds()))
	if len(first.Data) > 0 {
		onFirst()
	}
	a.speaking.Set()

	maxDur := a.ResponseMaxDuration.Seconds()
	ceiling := maxDur * maxDurationCeilingFactor
	accumulated := first.Seconds()
	warned := false
	warnSoftCap := func() {
		if accumulated >= maxDur && !warned {
			warned = true
			warnf(s, "agent turn exceeded ResponseMaxDuration; continuing to drain in-flight audio so the utterance is not split across turns",
				"response_max_duration_s", maxDur, "accumulated_s", accumulated)
		}
	}
	warnSoftCap()

	merged := first
	var buf []byte
	var transcripts []string
	count := 1
	reason := "hard_ceiling"
	for accumulated < ceiling {
		next, err := a.transport.ReceiveAudio(ctx, a.ResponseTailSilence)
		if err != nil {
			reason = "tail_silence"
			break
		}
		if len(next.Data) == 0 {
			reason = "terminal_chunk"
			break
		}
		if buf == nil {
			buf = append(make([]byte, 0, 2*(len(first.Data)+len(next.Data))), first.Data...)
			if first.Transcript != "" {
				transcripts = append(transcripts, first.Transcript)
			}
		}
		buf = append(buf, next.Data...)
		if next.Transcript != "" {
			transcripts = append(transcripts, next.Transcript)
		}
		count++
		accumulated += next.Seconds()
		warnSoftCap()
	}
	if accumulated >= ceiling {
		warnf(s, "agent turn hit the absolute audio ceiling; terminating the drain (the transport never signalled end-of-stream)",
			"ceiling_s", ceiling, "response_max_duration_s", maxDur)
	}
	if buf != nil {
		merged = AudioChunk{Data: buf, Transcript: strings.Join(transcripts, " ")}
	}
	SetSpanAttributes(span,
		attribute.String("voice.audio.terminated_reason", reason),
		attribute.Int("voice.audio.chunk_count", count),
		attribute.Int("voice.audio.bytes", len(merged.Data)))
	EndSpan(span, nil)
	return merged, nil
}

func warnf(s *Session, msg string, args ...any) {
	if s != nil {
		s.cfg.warn(msg, args...)
		return
	}
	resolve(Config{}).warn(msg, args...)
}

// awaitTranscript polls a TranscriptSource, up to TranscriptGraceWait, for
// a transcript that lands after the audio. It returns at once when the
// transcript is there or the transport has none to deliver.
func (a *Agent) awaitTranscript(ctx context.Context) {
	ts, ok := a.transport.(TranscriptSource)
	if !ok || ts.LastAgentTranscript() != "" || a.TranscriptGraceWait <= 0 {
		return
	}
	deadline := time.Now().Add(a.TranscriptGraceWait)
	t := time.NewTicker(transcriptGracePoll)
	defer t.Stop()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if ts.LastAgentTranscript() != "" {
			return
		}
	}
}

// attachTranscript labels the merged reply with the transport's native turn
// transcript when the audio carries none. A turn without audio is never
// labelled, so a no-audio turn cannot pass for a spoken one.
func (a *Agent) attachTranscript(c AudioChunk) AudioChunk {
	if len(c.Data) == 0 || c.Transcript != "" {
		return c
	}
	if ts, ok := a.transport.(TranscriptSource); ok {
		if native := ts.LastAgentTranscript(); native != "" {
			c.Transcript = native
		}
	}
	return c
}

// reconcilePrior drains prior-turn audio a buffering transport stranded,
// before the user turn is recorded.
func (a *Agent) reconcilePrior(s *Session) {
	r, ok := a.transport.(PendingAudioReconciler)
	if !ok || s == nil {
		return
	}
	left, ok := r.ReconcilePendingAudio()
	if !ok || len(left.Data) == 0 {
		return
	}
	s.attributeLeftover(left)
}

// turnRecorder bridges one turn's audio and timing into the session.
// Segments sit on the byte-accurate audio cursor; latency is measured from
// wall-clock marks (the user finishing on the wire, the agent's first
// chunk), since consecutive segments are gapless on the cursor.
type turnRecorder struct {
	s             *Session
	userEnd       float64
	agentStart    float64
	hasUserEnd    bool
	hasAgentStart bool
}

func (r *turnRecorder) recordUser(c AudioChunk) {
	if r.s == nil || len(c.Data) == 0 {
		return
	}
	r.userEnd, r.hasUserEnd = r.s.nowOffset(), true
	r.s.writeUserSegment(c)
}

func (r *turnRecorder) markAgentStart() {
	if r.s == nil {
		return
	}
	r.agentStart, r.hasAgentStart = r.s.nowOffset(), true
}

func (r *turnRecorder) recordAgent(c AudioChunk) {
	if r.s == nil || len(c.Data) == 0 {
		return
	}
	r.s.fireAudioChunk(c)
	start, end := r.s.laySegment(SpeakerAgent, c)
	var latency *float64
	if r.hasUserEnd && r.hasAgentStart {
		// A negative value means the agent started before the user finished
		// sending: a measurement artefact on serial transports, not recorded.
		if v := r.agentStart - r.userEnd; v >= 0 {
			latency = &v
			r.s.recordLatency(v)
		}
	}
	r.s.appendEvent(VoiceEvent{Type: AgentStartSpeaking, Time: start, Latency: latency})
	r.s.appendEvent(VoiceEvent{Type: AgentStopSpeaking, Time: end})
}
