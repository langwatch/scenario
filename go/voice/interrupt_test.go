package voice_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

// longReplies is an agent that starts speaking 40 ms into each turn and
// speaks 1.5 s of audio, so a barge-in always lands mid-reply.
func longReplies(n int) *voicetest.Transport {
	turns := make([]voicetest.Turn, n)
	for i := range turns {
		turns[i] = voicetest.Turn{Delay: 40 * time.Millisecond, Chunks: []voice.AudioChunk{voicetest.Tone(1.5, "a very long agent reply")}}
	}
	return &voicetest.Transport{Turns: turns, Caps: voice.Capabilities{NativeVAD: true, Interruption: true}}
}

func interrupts(r *voice.Result) []voice.VoiceEvent {
	var out []voice.VoiceEvent
	for _, e := range r.Timeline {
		if e.Type == voice.UserInterrupt {
			out = append(out, e)
		}
	}
	return out
}

func alwaysInterrupt(delay [2]float64) voice.Config {
	return voice.Config{
		Rand:         func() float64 { return 0 },
		Interruption: &voice.InterruptionConfig{Probability: 1, Strategy: voice.StrategyRandomPhrase, DelayRange: delay},
	}
}

func TestProceedBargesInMidReplyAndTruncates(t *testing.T) {
	tr := longReplies(4)
	agents := []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{scenario.Proceed(scenario.Turns(2))}, alwaysInterrupt([2]float64{0, 0}))
	vr := voice.ResultOf(res)
	ints := interrupts(vr)
	if len(ints) == 0 {
		t.Fatal("no user_interrupt event")
	}
	if ints[0].Metadata["outcome"] != "fired_after_speech" || ints[0].Metadata["native"] != true {
		t.Errorf("metadata %v", ints[0].Metadata)
	}
	truncated := false
	for _, s := range vr.Recording.Segments {
		truncated = truncated || (s.Speaker == voice.SpeakerAgent && s.TranscriptTruncated)
	}
	if !truncated {
		t.Error("no truncated agent segment")
	}
	if tr.Interrupts() == 0 {
		t.Error("native interrupt not sent")
	}
	found := false
	for _, m := range res.Messages {
		if tx, _ := voice.ExtractTranscript(m); m.Role == scenario.RoleUser && tx == voice.CannedPhrases[0] {
			found = true
		}
	}
	if !found {
		t.Error("the barge-in phrase is not in the conversation")
	}
}

func TestBargeInDelayStillFires(t *testing.T) {
	cfg := alwaysInterrupt([2]float64{0, 0})
	cfg.BargeInDelay = time.Millisecond
	agents := []scenario.AgentAdapter{fastAgent(longReplies(4)), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{scenario.Proceed(scenario.Turns(2))}, cfg)
	if len(interrupts(voice.ResultOf(res))) == 0 {
		t.Fatal("no user_interrupt with a barge-in delay")
	}
}

func TestExplicitBargeInIsRecordedAndNotResent(t *testing.T) {
	tr := longReplies(2)
	agents := []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{
		voice.AgentNonBlocking(),
		scenario.User("barge-in correction"),
		scenario.Agent(),
		scenario.Succeed("done"),
	}, voice.Config{})
	var found bool
	for _, m := range res.Messages {
		if tx, _ := voice.ExtractTranscript(m); m.Role == scenario.RoleUser && tx == "barge-in correction" {
			found = true
		}
	}
	if !found {
		t.Fatal("barge-in user message missing from the conversation")
	}
	if n := len(tr.Sent()); n != 1 {
		t.Errorf("the barge-in audio was sent %d times", n)
	}
	vr := voice.ResultOf(res)
	if ints := interrupts(vr); len(ints) != 1 || ints[0].Metadata["outcome"] != "fired_after_speech" {
		t.Errorf("interrupts %v", ints)
	}
	segs := vr.Recording.Segments
	if len(segs) != 3 || segs[0].Speaker != voice.SpeakerAgent || !segs[0].TranscriptTruncated || segs[1].Speaker != voice.SpeakerUser {
		t.Errorf("want agent (truncated), user, agent: %+v", speakers(segs))
	}
}

func speakers(segs []voice.AudioSegment) []string {
	out := make([]string, len(segs))
	for i, s := range segs {
		out[i] = string(s.Speaker)
		if s.TranscriptTruncated {
			out[i] += "*"
		}
	}
	return out
}

func TestInterruptStepRecordsTheCutOff(t *testing.T) {
	agents := []scenario.AgentAdapter{fastAgent(longReplies(2)), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{
		voice.Interrupt(voice.WithContent("wait, stop")),
		scenario.Succeed(),
	}, voice.Config{})
	vr := voice.ResultOf(res)
	if len(interrupts(vr)) != 1 || !vr.Recording.Segments[0].TranscriptTruncated {
		t.Errorf("timeline %v segments %v", vr.Timeline, speakers(vr.Recording.Segments))
	}
}

func TestInterruptAfterWordsNeedsStreamingTranscripts(t *testing.T) {
	agents := []scenario.AgentAdapter{fastAgent(longReplies(2)), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	_, err := tryScenario(agents, []scenario.ScriptStep{voice.Interrupt(voice.AfterWords(3))}, voice.Config{})
	var uc *voice.UnsupportedCapabilityError
	if !errors.As(err, &uc) || uc.Capability != "streaming_transcripts" {
		t.Fatalf("got %v", err)
	}
}

type streaming struct {
	*voicetest.Transport
	words atomic.Value
}

func (s *streaming) StreamingTranscript() string {
	v, _ := s.words.Load().(string)
	return v
}

func TestInterruptAfterWordsWaitsForTheWords(t *testing.T) {
	chunks := make([]voice.AudioChunk, 10)
	for i := range chunks {
		chunks[i] = voicetest.Tone(0.1, "")
	}
	tr := &voicetest.Transport{Caps: voice.Capabilities{NativeVAD: true, StreamingTranscripts: true},
		Turns: []voicetest.Turn{{Delay: 10 * time.Millisecond, Gap: 25 * time.Millisecond, Chunks: chunks}, reply(0.1, "after")}}
	st := &streaming{Transport: tr}
	go func() {
		time.Sleep(80 * time.Millisecond)
		st.words.Store("one two three")
	}()
	agents := []scenario.AgentAdapter{fastAgent(st), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	start := time.Now()
	res := runScenario(t, agents, []scenario.ScriptStep{voice.Interrupt(voice.AfterWords(3), voice.WithContent("stop")), scenario.Succeed()}, voice.Config{})
	if time.Since(start) < 80*time.Millisecond || len(interrupts(voice.ResultOf(res))) != 1 {
		t.Errorf("interrupt fired before the words or not at all")
	}
}

func TestSpeakingEventIsSetAndRearmedPerTurn(t *testing.T) {
	var a *voice.Agent
	var setAtTurnStart []bool
	calls := 0
	tr := &voicetest.Transport{}
	tr.Receive = func(context.Context, time.Duration) (voice.AudioChunk, error) {
		calls++
		if calls%2 == 1 {
			setAtTurnStart = append(setAtTurnStart, a.Speaking().IsSet())
			return voicetest.Tone(0.05, "x"), nil
		}
		return voice.AudioChunk{}, nil
	}
	a = fastAgent(tr)
	for range 2 {
		if _, err := a.Call(context.Background(), scenario.AgentInput{}); err != nil {
			t.Fatal(err)
		}
		if !a.Speaking().IsSet() {
			t.Error("speaking event not set after the agent spoke")
		}
	}
	if len(setAtTurnStart) != 2 || setAtTurnStart[0] || setAtTurnStart[1] {
		t.Errorf("event not re-armed at turn start: %v", setAtTurnStart)
	}
}

// flakyUser fails to voice its first n lines.
type flakyUser struct {
	voicetest.User
	fail atomic.Int32
}

func (f *flakyUser) VoiceifyText(ctx context.Context, ex *scenario.Executor, text string) (scenario.Message, error) {
	if f.fail.Add(-1) >= 0 {
		return scenario.Message{}, errors.New("tts down")
	}
	return f.User.VoiceifyText(ctx, ex, text)
}

func TestFailedBargeInTTSClearsTheSampledDelay(t *testing.T) {
	clock := voicetest.NewClock()
	cfg := alwaysInterrupt([2]float64{1, 1})
	cfg.Clock = clock
	user := &flakyUser{}
	user.fail.Store(1)
	var before time.Time
	agents := []scenario.AgentAdapter{fastAgent(longReplies(4)), user, &voicetest.Judge{}}
	runScenario(t, agents, []scenario.ScriptStep{
		scenario.Proceed(scenario.Turns(2)),
		scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
			if h := ex.PendingAgentTurn(); h != nil {
				_ = h.Wait()
			}
			before = clock.Now()
			return nil
		}),
		voice.AgentNonBlocking(),
		scenario.User("correction"),
		scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
			if d := clock.Now().Sub(before); d != 0 {
				return &scenario.AssertionError{Message: "the barge-in slept a stale delay of " + d.String()}
			}
			return nil
		}),
		scenario.Succeed(),
	}, cfg)
}

func TestScheduledBargeInPropagatesTheAgentError(t *testing.T) {
	tr := &voicetest.Transport{Caps: voice.Capabilities{NativeVAD: true}}
	n := 0
	tr.Receive = func(ctx context.Context, _ time.Duration) (voice.AudioChunk, error) {
		n++
		time.Sleep(30 * time.Millisecond)
		return voice.AudioChunk{}, errors.New("agent socket dropped")
	}
	cfg := alwaysInterrupt([2]float64{0, 0})
	cfg.WaitForSpeech = 5 * time.Second
	agents := []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{}}
	start := time.Now()
	_, err := tryScenario(agents, []scenario.ScriptStep{scenario.Proceed(scenario.Turns(2))}, cfg)
	if err == nil || !strings.Contains(err.Error(), "agent socket dropped") {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Error("the barge-in waited for speech after the turn had ended")
	}
}

func TestTextOnlyProceedInjectsInterruption(t *testing.T) {
	var lines []string
	agent := scenario.AgentFunc(func(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
		if len(in.NewMessages) > 0 {
			lines = append(lines, in.NewMessages[len(in.NewMessages)-1].Text())
		}
		return scenario.TextReturn("reply"), nil
	})
	user := voice.NewUserSimulator(textUser{}, voice.UserSimulatorOptions{InterruptProbability: 1})
	cfg := alwaysInterrupt([2]float64{0, 0})
	runScenario(t, []scenario.AgentAdapter{agent, user, &voicetest.Judge{}}, []scenario.ScriptStep{scenario.Proceed(scenario.Turns(3)), scenario.Succeed()}, cfg)
	if !strings.Contains(strings.Join(lines, "|"), voice.CannedPhrases[0]) {
		t.Errorf("no interruption reached the agent: %v", lines)
	}
}

// slowStarter is an agent that takes 300 ms to start speaking every turn and
// counts user audio that reaches it while it has not started yet.
type slowStarter struct {
	*voicetest.Transport
	mu       sync.Mutex
	awaiting bool
	early    int
}

func (s *slowStarter) SendAudio(ctx context.Context, c voice.AudioChunk) error {
	s.mu.Lock()
	if s.awaiting {
		s.early++
	}
	s.mu.Unlock()
	return s.Transport.SendAudio(ctx, c)
}

func newSlowStarter() *slowStarter {
	s := &slowStarter{Transport: &voicetest.Transport{Caps: voice.Capabilities{NativeVAD: true, Interruption: true}}}
	speaking := false
	s.Receive = func(ctx context.Context, _ time.Duration) (voice.AudioChunk, error) {
		if speaking {
			speaking = false
			return voice.AudioChunk{}, nil
		}
		s.mu.Lock()
		s.awaiting = true
		s.mu.Unlock()
		select {
		case <-time.After(300 * time.Millisecond):
		case <-ctx.Done():
			return voice.AudioChunk{}, ctx.Err()
		}
		s.mu.Lock()
		s.awaiting = false
		s.mu.Unlock()
		speaking = true
		return voicetest.Tone(0.5, "reply"), nil
	}
	return s
}

func TestScheduledBargeInWaitsForThisTurnsSpeech(t *testing.T) {
	tr := newSlowStarter()
	cfg := alwaysInterrupt([2]float64{0, 0})
	cfg.WaitForSpeech = 5 * time.Second
	// The judge lets the run continue: a passing one would end it on the
	// first turn's judge step, before the barge-in turn is ever scheduled.
	agents := []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{}}
	res := runScenario(t, agents, []scenario.ScriptStep{
		scenario.Agent(),
		scenario.Proceed(scenario.Turns(2)),
		scenario.Succeed("done"),
	}, cfg)
	if len(interrupts(voice.ResultOf(res))) == 0 {
		t.Fatal("no barge-in")
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if tr.early != 0 {
		t.Errorf("%d barge-ins fired before the agent spoke: the speaking event of the previous turn was not re-armed", tr.early)
	}
}
