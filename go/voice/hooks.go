package voice

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel/attribute"
)

// TransformUserTurn implements scenario.UserTurnTransformer. A scripted
// text line (producer nil) is spoken by a realtime user agent or voiced by a
// voice user simulator. A generated turn for a voice agent under test is
// voiced by the voice simulator that produced it, then must carry audio:
// a content-less user turn fails closed with ErrUserTurnNoAudio.
func (s *Session) TransformUserTurn(ctx context.Context, ex *scenario.Executor, producer scenario.AgentAdapter, msgs []scenario.Message) ([]scenario.Message, error) {
	if producer == nil {
		return s.voiceScriptedLine(ctx, ex, msgs)
	}
	if len(msgs) == 0 || s.agentUnderTest() == nil {
		return msgs, nil
	}
	out := msgs
	if vu, ok := producer.(VoiceUser); ok && vu.Voice() != "" {
		out = make([]scenario.Message, len(msgs))
		for i, m := range msgs {
			text := m.Text()
			if MessageHasAudio(m) || text == "" {
				out[i] = m
				continue
			}
			voiced, err := vu.VoiceifyText(ctx, ex, text)
			if err != nil {
				return nil, err
			}
			out[i] = voiced
		}
	}
	for _, m := range out {
		if c, ok := ExtractAudio(m); ok && (len(c.Data) > 0 || c.Transcript != "") {
			return out, nil
		}
	}
	return nil, ErrUserTurnNoAudio
}

func (s *Session) voiceScriptedLine(ctx context.Context, ex *scenario.Executor, msgs []scenario.Message) ([]scenario.Message, error) {
	if len(msgs) != 1 || msgs[0].HasAudio() {
		return msgs, nil
	}
	text := msgs[0].Text()
	if ru := s.realtimeUser(); ru != nil {
		spoken, err := ru.SpeakUserTurn(ctx, text)
		if err != nil {
			return nil, err
		}
		if spoken.Transcript == "" {
			spoken.Transcript = text
		}
		return []scenario.Message{AudioMessage(spoken, scenario.RoleUser)}, nil
	}
	if vu := s.voiceUserSim(); vu != nil {
		voiced, err := vu.VoiceifyText(ctx, ex, text)
		if err != nil {
			return nil, err
		}
		return []scenario.Message{voiced}, nil
	}
	return msgs, nil
}

// InterceptUserTurn implements scenario.UserTurnInterceptor: a voiced
// scripted line arriving while a non-blocking agent turn is in flight is the
// barge-in. The audio goes out mid-reply, the interrupted turn settles, and
// the line is recorded.
func (s *Session) InterceptUserTurn(ctx context.Context, ex *scenario.Executor, m scenario.Message) (bool, error) {
	if s.realtimeUser() == nil && s.voiceUserSim() == nil {
		return false, nil
	}
	h := ex.PendingAgentTurn()
	if h == nil || h.Finished() {
		return false, nil
	}
	sent, err := s.fireUserInterrupt(ctx, ex, m)
	if err != nil {
		return true, err
	}
	s.recordBargeIn(ex, m, sent)
	return true, nil
}

// recordBargeIn adds the barge-in line to the conversation. Its audio was
// already delivered out of band, so it is dropped again from the agent
// under test's queue: the recovery turn must not send it a second time.
func (s *Session) recordBargeIn(ex *scenario.Executor, m scenario.Message, sent bool) {
	ex.AddMessage(m)
	if p := s.agentUnderTest(); sent && p != nil {
		ex.ClearPendingMessages(p.adapter)
	}
}

// AfterGeneratedUserTurn implements scenario.GeneratedUserTurnHook: a
// generated user turn landing while a non-blocking agent turn is in flight
// barges in on it.
func (s *Session) AfterGeneratedUserTurn(ctx context.Context, ex *scenario.Executor, m scenario.Message) error {
	h := ex.PendingAgentTurn()
	if h == nil || h.Finished() {
		return nil
	}
	_, err := s.fireUserInterrupt(ctx, ex, m)
	return err
}

// interruptionConfig is the run's barge-in configuration: the forced one,
// else one from a user simulator's InterruptProbability.
func (s *Session) interruptionConfig() (InterruptionConfig, bool) {
	if s.cfg.Interruption != nil {
		return *s.cfg.Interruption, true
	}
	for _, a := range s.ex.Agents() {
		if p, ok := a.(InterruptProber); ok && p.InterruptProbability() > 0 {
			return NewInterruptionConfig(p.InterruptProbability()), true
		}
	}
	return InterruptionConfig{}, false
}

// BeforeProceedStep implements scenario.BeforeProceedStepHook: with a
// barge-in configuration, a voice agent and a voice user simulator, it rolls
// the interruption probability before the agent's turn. On a hit the agent
// turn starts in the background and a phrase is voiced and fired into it
// once the agent speaks.
func (s *Session) BeforeProceedStep(ctx context.Context, ex *scenario.Executor) error {
	cfg, ok := s.interruptionConfig()
	if !ok || s.agentUnderTest() == nil {
		return nil
	}
	sim := s.voiceUserSim()
	if sim == nil {
		return nil
	}
	if h := ex.PendingAgentTurn(); h != nil && !h.Finished() {
		return nil
	}
	rng := s.cfg.Rand
	if rng() >= cfg.Probability {
		return nil
	}
	// Re-arm the speaking event before the turn starts, as the
	// AgentNonBlocking step does: the previous turn left it set, and the
	// barge-in below would otherwise fire before the agent speaks whenever
	// it wins the race against the turn goroutine's own re-arm.
	s.agentUnderTest().agent.speaking.Clear()
	h, ok := ex.ScheduleAgentTurnNonBlocking(ctx)
	if !ok {
		return nil
	}
	// The delay is applied after the agent starts speaking (in the
	// barge-in), not before the TTS, so a burst-speaking agent cannot finish
	// before the window opens.
	delay := durationOf(cfg.SampleDelay(rng)).Truncate(time.Millisecond)
	s.setBargeInDelay(max(delay, 0))
	voiced, err := sim.VoiceifyText(ctx, ex, cfg.PickRandomPhrase(rng))
	if err != nil || h.Finished() {
		s.setBargeInDelay(0)
		return nil
	}
	sent, err := s.fireUserInterrupt(ctx, ex, voiced)
	if err != nil {
		return err
	}
	s.recordBargeIn(ex, voiced, sent)
	return nil
}

// AfterProceedStep implements scenario.AfterProceedStepHook: the text-only
// interruption fallback. Without a voice agent it injects an interrupting
// user turn after the agent spoke, honouring the configured delay.
func (s *Session) AfterProceedStep(ctx context.Context, ex *scenario.Executor) error {
	if s.agentUnderTest() != nil {
		return nil
	}
	cfg, ok := s.interruptionConfig()
	if !ok || !cfg.ShouldInterrupt(s.cfg.Rand) {
		return nil
	}
	if d := cfg.SampleDelay(s.cfg.Rand); d > 0 {
		if err := s.cfg.sleep(ctx, durationOf(d)); err != nil {
			return err
		}
	}
	s.appendEvent(VoiceEvent{Type: UserInterrupt, Time: s.cursorNow(), Metadata: map[string]any{
		"source": "proceed-interruption", "strategy": string(cfg.strategy()),
	}})
	if cfg.strategy() == StrategyRandomPhrase {
		return ex.User(ctx, cfg.PickRandomPhrase(s.cfg.Rand))
	}
	return ex.User(ctx, "")
}

func (s *Session) setBargeInDelay(d time.Duration) {
	s.mu.Lock()
	s.bargeInDelay = d
	s.mu.Unlock()
}

// setStepWait threads an Interrupt step's wait budget into the next
// barge-in.
func (s *Session) setStepWait(d time.Duration) {
	s.mu.Lock()
	s.stepWait = d
	s.mu.Unlock()
}

// takeInterruptTiming consumes the per-barge-in wait and delay.
func (s *Session) takeInterruptTiming() (wait, delay time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	wait, delay = s.stepWait, s.bargeInDelay
	s.stepWait, s.bargeInDelay = 0, 0
	if wait <= 0 {
		wait = s.cfg.WaitForSpeech
	}
	if delay <= 0 {
		delay = s.cfg.BargeInDelay
	}
	return wait, delay
}

// fireUserInterrupt barges in on the in-flight agent turn: it waits
// (bounded) for the agent to start speaking, sends the native interrupt when
// the transport has one, pushes the user audio onto the wire, lets the
// interrupted turn settle, then records the interrupting user segment and a
// user_interrupt event on the audio cursor. It reports whether the audio
// was delivered; the interrupted turn's error is returned.
func (s *Session) fireUserInterrupt(ctx context.Context, ex *scenario.Executor, m scenario.Message) (sent bool, err error) {
	wait, delay := s.takeInterruptTiming()
	h := ex.PendingAgentTurn()
	if h == nil || h.Finished() {
		return false, nil
	}
	settle := func() error {
		if ex.PendingAgentTurn() == h {
			ex.TakePendingAgentTurn()
		}
		return h.Wait()
	}
	interruptTime := s.cursorNow()
	outcome, native := "no_adapter", false
	p := s.agentUnderTest()
	if p == nil {
		if err := settle(); err != nil {
			return false, err
		}
	} else {
		a := p.agent
		if !a.speaking.IsSet() {
			waitForSpeech(ctx, a.speaking.Wait(), h.Done(), wait)
		}
		outcome = "fired_before_speech"
		if a.speaking.IsSet() {
			outcome = "fired_after_speech"
		}
		if delay > 0 {
			_ = s.cfg.sleep(ctx, delay)
		}
		interruptTime = s.cursorNow()
		if it, ok := a.transport.(Interrupter); ok && a.transport.Capabilities().Interruption {
			err := withSpan(ctx, SpanAdapterInterrupt, []attribute.KeyValue{adapterClass(a.name)},
				func(ctx context.Context, _ traceSpan) error { return it.Interrupt(ctx) })
			native = err == nil
		}
		chunk, hasAudio := ExtractAudio(m)
		if hasAudio && a.transport.SendAudio(ctx, chunk) == nil {
			sent = true
			ex.ClearPendingMessages(p.adapter)
		}
		if err := settle(); err != nil {
			return sent, err
		}
		// Recorded after the interrupted agent segment, so the recording
		// reads agent (truncated) then the barge-in.
		if sent {
			s.writeUserSegment(chunk)
		}
	}
	s.appendEvent(VoiceEvent{Type: UserInterrupt, Time: interruptTime, Metadata: map[string]any{
		"source": "barge-in", "outcome": outcome, "native": native,
	}})
	return sent, nil
}

// PreprocessJudgeInput implements scenario.JudgeInputPreprocessor: the
// automatic STT pre-pass, so the judge reads spoken words; audio parts are
// kept only for an audio-capable judge.
func (s *Session) PreprocessJudgeInput(ctx context.Context, _ *scenario.Executor, msgs []scenario.Message, opts scenario.JudgeInputOptions) ([]scenario.Message, error) {
	provider, err := s.cfg.sttProvider()
	if err != nil {
		return nil, err
	}
	return TranscribeAudioMessages(ctx, msgs, provider, TranscribeMessagesOptions{
		IncludeAudio: opts.IncludeAudio,
		Warn:         func(m string) { s.cfg.warn(m) },
	}), nil
}

// PreprocessUserSimulatorInput implements
// scenario.UserSimulatorInputPreprocessor: audio turns without a transcript
// are transcribed so the text-only simulator does not see a bare
// "[audio message]". Transcripts are cached for the run, so a chunk is
// transcribed at most once across Proceed turns.
func (s *Session) PreprocessUserSimulatorInput(ctx context.Context, _ *scenario.Executor, msgs []scenario.Message) ([]scenario.Message, error) {
	provider, err := s.cfg.sttProvider()
	if err != nil {
		return nil, err
	}
	return TranscribeAudioMessages(ctx, msgs, provider, TranscribeMessagesOptions{
		IncludeAudio: true,
		Cache:        s,
		Warn:         func(m string) { s.cfg.warn(m) },
	}), nil
}

// JudgeContext implements scenario.JudgeContextProvider: the voice timeline,
// unless the run's config turned it off.
func (s *Session) JudgeContext(context.Context, *scenario.Executor) string {
	if !s.cfg.includeTimeline() {
		return ""
	}
	return FormatTimeline(s.Timeline())
}

// FormatTimeline renders timeline events for the judge, one per line.
func FormatTimeline(events []VoiceEvent) string {
	if len(events) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<voice_timeline>")
	for _, e := range events {
		b.WriteString("\n    ")
		b.WriteString(strconv.FormatFloat(e.Time, 'f', 2, 64))
		b.WriteString("s ")
		b.WriteString(string(e.Type))
		if e.Latency != nil {
			fmt.Fprintf(&b, " (latency %.2fs)", *e.Latency)
		}
		if src, ok := e.Metadata["source"].(string); ok {
			b.WriteString(" [")
			b.WriteString(src)
			if o, ok := e.Metadata["outcome"].(string); ok {
				b.WriteString(", ")
				b.WriteString(o)
			}
			b.WriteByte(']')
		}
	}
	b.WriteString("\n    </voice_timeline>")
	return b.String()
}
