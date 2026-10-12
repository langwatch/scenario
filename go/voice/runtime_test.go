package voice_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

func reply(seconds float64, transcript string) voicetest.Turn {
	return voicetest.Turn{Chunks: []voice.AudioChunk{voicetest.Tone(seconds, transcript)}}
}

func basicAgents(tr *voicetest.Transport) []scenario.AgentAdapter {
	return []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
}

// --- adapter lifecycle -------------------------------------------------------

func TestLifecycleConnectsOnceAndDisconnectsOnFail(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "hi")}}
	var connectedAtCall bool
	check := scenario.StepFunc(func(context.Context, *scenario.Executor) error {
		connectedAtCall = tr.Connects() == 1 && tr.Disconnects() == 0
		return nil
	})
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{check, scenario.User("hi"), scenario.Agent(), scenario.Fail("nope")}, voice.Config{})
	if res.Success {
		t.Fatal("expected failure")
	}
	if !connectedAtCall || tr.Connects() != 1 || tr.Disconnects() != 1 {
		t.Errorf("connect before first step / once each: connected=%v connects=%d disconnects=%d", connectedAtCall, tr.Connects(), tr.Disconnects())
	}
}

func TestLifecycleDisconnectsWhenAStepErrors(t *testing.T) {
	tr := &voicetest.Transport{}
	boom := scenario.StepFunc(func(context.Context, *scenario.Executor) error { return errors.New("boom") })
	_, err := tryScenario(basicAgents(tr), []scenario.ScriptStep{boom}, voice.Config{})
	if err == nil || tr.Disconnects() != 1 {
		t.Errorf("err=%v disconnects=%d", err, tr.Disconnects())
	}
}

func TestLifecycleEveryVoiceAdapterConnectsOnce(t *testing.T) {
	a, b := &voicetest.Transport{TransportName: "A"}, &voicetest.Transport{TransportName: "B"}
	agents := []scenario.AgentAdapter{fastAgent(a), fastAgent(b), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	runScenario(t, agents, []scenario.ScriptStep{scenario.Succeed()}, voice.Config{})
	for _, tr := range []*voicetest.Transport{a, b} {
		if tr.Connects() != 1 || tr.Disconnects() != 1 {
			t.Errorf("%s: connects=%d disconnects=%d", tr.Name(), tr.Connects(), tr.Disconnects())
		}
	}
}

func TestLifecycleDisconnectErrorsAreSwallowed(t *testing.T) {
	tr := &voicetest.Transport{DisconnectErr: errors.New("teardown failed")}
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.Succeed()}, voice.Config{})
	if !res.Success {
		t.Errorf("a disconnect error masked the result: %+v", res)
	}
}

func TestLifecycleConnectErrorFailsTheRunAndStillDisconnects(t *testing.T) {
	tr := &voicetest.Transport{ConnectErr: errors.New("no route")}
	_, err := tryScenario(basicAgents(tr), []scenario.ScriptStep{scenario.Succeed()}, voice.Config{})
	if err == nil || !strings.Contains(err.Error(), "no route") || tr.Disconnects() != 1 {
		t.Errorf("err=%v disconnects=%d", err, tr.Disconnects())
	}
}

// ctxTransport records the state of the context Disconnect ran under.
type ctxTransport struct {
	*voicetest.Transport
	mu            sync.Mutex
	disconnectErr error
	disconnected  bool
}

func (c *ctxTransport) Disconnect(ctx context.Context) error {
	c.mu.Lock()
	c.disconnectErr, c.disconnected = ctx.Err(), true
	c.mu.Unlock()
	return c.Transport.Disconnect(ctx)
}

func TestLifecycleDisconnectOutlivesACancelledRun(t *testing.T) {
	tr := &ctxTransport{Transport: &voicetest.Transport{}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelRun := scenario.StepFunc(func(context.Context, *scenario.Executor) error {
		cancel()
		return nil
	})
	_, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "voice test",
		Description: "a voice scenario",
		Agents:      []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}},
		Script:      []scenario.ScriptStep{cancelRun, scenario.Succeed()},
	}, voice.WithConfig(voice.Config{STT: &voicetest.STT{}, Logger: quiet}), scenario.WithQuiet())
	if err == nil {
		t.Fatal("expected the cancelled run to fail")
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if !tr.disconnected || tr.disconnectErr != nil {
		t.Errorf("disconnected=%v under a context with err=%v; want a live context", tr.disconnected, tr.disconnectErr)
	}
}

// --- connected-state gate ----------------------------------------------------

type gatedTransport struct {
	voicetest.Transport
	hungUp bool
}

func (g *gatedTransport) IsConnected() bool {
	return g.Connects() > g.Disconnects() && g.ConnectErr == nil && !g.hungUp
}
func (g *gatedTransport) AgentHungUp() bool { return g.hungUp }

func TestTurnBeforeConnectFailsWithPendingTransportError(t *testing.T) {
	a := fastAgent(&gatedTransport{})
	_, err := a.Call(context.Background(), scenario.AgentInput{})
	var pending *voice.PendingTransportError
	if !errors.As(err, &pending) || pending.Adapter != "FakeVoiceAdapter" {
		t.Fatalf("got %v", err)
	}
}

func TestTurnAfterConnectSucceeds(t *testing.T) {
	g := &gatedTransport{Transport: voicetest.Transport{Turns: []voicetest.Turn{reply(0.05, "hi")}}}
	_ = g.Connect(context.Background())
	ret, err := fastAgent(g).Call(context.Background(), scenario.AgentInput{})
	if err != nil || len(ret.Messages(scenario.RoleAssistant)) != 1 {
		t.Fatalf("ret=%v err=%v", ret, err)
	}
}

func TestTurnAfterAgentHangupConcludesQuietly(t *testing.T) {
	g := &gatedTransport{hungUp: true}
	ret, err := fastAgent(g).Call(context.Background(), scenario.AgentInput{})
	if err != nil || len(ret.Messages(scenario.RoleAssistant)) != 0 {
		t.Fatalf("ret=%v err=%v", ret, err)
	}
}

// --- result fields -------------------------------------------------------------

func TestResultCarriesRecordingTimelineAndLatency(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{
		{Delay: 20 * time.Millisecond, Chunks: []voice.AudioChunk{voicetest.Tone(0.2, "hello there")}},
	}}
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()}, voice.Config{})
	vr := voice.ResultOf(res)
	if vr == nil || vr.Recording == nil {
		t.Fatal("no voice result")
	}
	segs := vr.Recording.Segments
	if len(segs) != 2 || segs[0].Speaker != voice.SpeakerUser || segs[1].Speaker != voice.SpeakerAgent || segs[1].Transcript != "hello there" {
		t.Fatalf("segments %+v", segs)
	}
	var types []voice.VoiceEventType
	for i, e := range vr.Timeline {
		types = append(types, e.Type)
		if i > 0 && e.Time < vr.Timeline[i-1].Time {
			t.Error("timeline out of order")
		}
	}
	want := []voice.VoiceEventType{voice.UserStartSpeaking, voice.UserStopSpeaking, voice.AgentStartSpeaking, voice.AgentStopSpeaking}
	if strings.Join(eventNames(types), ",") != strings.Join(eventNames(want), ",") {
		t.Errorf("timeline %v", types)
	}
	if vr.Latency == nil || len(vr.Latency.Measurements) != 1 || vr.Latency.TimeToFirstByte == nil || *vr.Latency.TimeToFirstByte < 0.015 {
		t.Errorf("latency %+v", vr.Latency)
	}
	path := filepath.Join(t.TempDir(), "conv.wav")
	if _, err := vr.Recording.Save(context.Background(), path, ""); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	w, err := audio.ParseWAV(b)
	if err != nil || len(w.Data) != len(segs[0].Audio)+len(segs[1].Audio) {
		t.Errorf("saved wav: %v", err)
	}
	// The agent message carries the transcript and the audio.
	last := res.Messages[len(res.Messages)-1]
	if c, ok := voice.ExtractAudio(last); !ok || c.Transcript != "hello there" || last.Role != scenario.RoleAssistant {
		t.Errorf("agent message %+v", last)
	}
}

func eventNames(ts []voice.VoiceEventType) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = string(t)
	}
	return out
}

type textUser struct{}

func (textUser) Role() scenario.AgentRole { return scenario.AgentRoleUser }
func (textUser) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.TextReturn("hello"), nil
}

func TestTextOnlyRunHasNoVoiceResult(t *testing.T) {
	agent := scenario.AgentFunc(func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
		return scenario.TextReturn("hi"), nil
	})
	res, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "text", Description: "text", Agents: []scenario.AgentAdapter{agent, textUser{}, &voicetest.Judge{Verdict: voicetest.Pass()}},
		Script: []scenario.ScriptStep{scenario.User("hi"), scenario.Agent(), scenario.Succeed()},
	}, scenario.WithQuiet())
	if err != nil || voice.ResultOf(res) != nil || res.Extensions[voice.ExtensionKey] != nil {
		t.Errorf("err=%v extensions=%v", err, res.Extensions)
	}
}

func TestVoiceEventHookPanicDoesNotBreakTheRun(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.05, "hi")}}
	var chunks int
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()}, voice.Config{
		OnVoiceEvent: func(voice.VoiceEvent) { panic("observer bug") },
		OnAudioChunk: func(voice.AudioChunk) { chunks++ },
	})
	if !res.Success || chunks != 2 {
		t.Errorf("success=%v chunks=%d", res.Success, chunks)
	}
}

// --- duration fidelity -------------------------------------------------------

func TestRecordingDurationIsByteAccurate(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.5, "one"), reply(0.75, "two")}}
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{
		scenario.User(), scenario.Agent(), scenario.User(), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{})
	rec := voice.ResultOf(res).Recording
	dir, err := rec.SaveSegments(t.TempDir(), voice.SaveSegmentsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	full, _ := os.ReadFile(filepath.Join(dir, "full.wav"))
	w, _ := audio.ParseWAV(full)
	var m struct {
		Duration float64 `json:"duration"`
		Segments []struct {
			File     string  `json:"file"`
			Start    float64 `json:"start_time"`
			End      float64 `json:"end_time"`
			Duration float64 `json:"duration"`
		} `json:"segments"`
	}
	b, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if math.Abs(m.Duration-audio.Seconds(w.Data)) > 1e-9 {
		t.Errorf("manifest duration %v vs full.wav %v", m.Duration, audio.Seconds(w.Data))
	}
	sum := 0.0
	for i, s := range m.Segments {
		sb, _ := os.ReadFile(filepath.Join(dir, s.File))
		sw, _ := audio.ParseWAV(sb)
		if math.Abs(s.Duration-audio.Seconds(sw.Data)) > 1e-9 {
			t.Errorf("segment %d duration %v vs wav %v", i, s.Duration, audio.Seconds(sw.Data))
		}
		if i > 0 && math.Abs(s.Start-m.Segments[i-1].End) > 1e-9 {
			t.Errorf("segment %d not gapless", i)
		}
		sum += s.Duration
	}
	if math.Abs(sum-m.Duration) > 1e-9 {
		t.Errorf("sum %v total %v", sum, m.Duration)
	}
}

// --- transcript grace wait ----------------------------------------------------

type lateTranscript struct {
	voicetest.Transport
	mu         sync.Mutex
	transcript string
	after      time.Duration
	text       string
	resets     int
}

func (l *lateTranscript) LastAgentTranscript() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.transcript
}

func (l *lateTranscript) ResetAgentTranscript() {
	l.mu.Lock()
	l.transcript = ""
	l.resets++
	l.mu.Unlock()
}

func (l *lateTranscript) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	c, err := l.Transport.ReceiveAudio(ctx, timeout)
	if err == nil && len(c.Data) == 0 && l.text != "" {
		text := l.text
		l.text = ""
		time.AfterFunc(l.after, func() {
			l.mu.Lock()
			l.transcript = text
			l.mu.Unlock()
		})
	}
	return c, err
}

func graceAgent(l *lateTranscript, wait time.Duration) *voice.Agent {
	a := voice.NewAgent(l)
	a.ResponseTailSilence = 50 * time.Millisecond
	a.TranscriptGraceWait = wait
	return a
}

func callWithUserAudio(t *testing.T, a *voice.Agent) (scenario.Message, time.Duration) {
	t.Helper()
	in := scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(voicetest.Tone(0.05, "q"), scenario.RoleUser)}}
	start := time.Now()
	ret, err := a.Call(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return ret.Messages(scenario.RoleAssistant)[0], time.Since(start)
}

func TestTranscriptLandingAfterDrainIsAttached(t *testing.T) {
	l := &lateTranscript{Transport: voicetest.Transport{Turns: []voicetest.Turn{{Chunks: []voice.AudioChunk{voicetest.Tone(0.05, "")}}}}, after: 60 * time.Millisecond, text: "late words"}
	m, _ := callWithUserAudio(t, graceAgent(l, 2*time.Second))
	if c, _ := voice.ExtractAudio(m); c.Transcript != "late words" {
		t.Errorf("transcript %q", c.Transcript)
	}
	if l.resets != 1 {
		t.Errorf("the transcript was not reset for the reply (%d)", l.resets)
	}
}

func TestTranscriptAlreadyPresentAddsNoWait(t *testing.T) {
	l := &lateTranscript{Transport: voicetest.Transport{Turns: []voicetest.Turn{{Chunks: []voice.AudioChunk{voicetest.Tone(0.05, "inline")}}}}}
	_, took := callWithUserAudio(t, graceAgent(l, 2*time.Second))
	if took > time.Second {
		t.Errorf("waited %v with the transcript present", took)
	}
}

func TestTranscriptThatNeverArrivesIsBounded(t *testing.T) {
	l := &lateTranscript{Transport: voicetest.Transport{Turns: []voicetest.Turn{{Chunks: []voice.AudioChunk{voicetest.Tone(0.05, "")}}}}}
	m, took := callWithUserAudio(t, graceAgent(l, 150*time.Millisecond))
	if took < 150*time.Millisecond || took > 2*time.Second {
		t.Errorf("took %v", took)
	}
	if _, ok := voice.ExtractTranscript(m); ok {
		t.Error("a text part without a transcript")
	}
}

func TestNoTranscriptSourceAddsNoWait(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{{Chunks: []voice.AudioChunk{voicetest.Tone(0.05, "")}}}}
	a := voice.NewAgent(tr)
	a.ResponseTailSilence = 50 * time.Millisecond
	_, took := callWithUserAudio(t, a)
	if took > time.Second {
		t.Errorf("took %v without a transcript source", took)
	}
}

// --- turn boundary: long utterances, ceiling, reconcile --------------------------

func TestLongUtteranceLandsWholePastTheSoftCap(t *testing.T) {
	chunks := make([]voice.AudioChunk, 6)
	for i := range chunks {
		chunks[i] = voicetest.Tone(0.1, "")
	}
	tr := &voicetest.Transport{Turns: []voicetest.Turn{{Chunks: chunks}, reply(0.05, "next")}}
	a := fastAgent(tr)
	a.ResponseMaxDuration = 350 * time.Millisecond // 0.6s of audio exceeds it, below the 0.7s ceiling
	m, _ := callWithUserAudio(t, a)
	c, _ := voice.ExtractAudio(m)
	if math.Abs(c.Seconds()-0.6) > 1e-9 {
		t.Fatalf("got %vs, want the whole 0.6s utterance", c.Seconds())
	}
	m2, _ := callWithUserAudio(t, a)
	if c2, _ := voice.ExtractAudio(m2); c2.Transcript != "next" {
		t.Errorf("the next turn got %q: the remainder bled", c2.Transcript)
	}
}

func TestNeverSilentStreamStopsAtTheCeiling(t *testing.T) {
	tr := &voicetest.Transport{Receive: func(context.Context, time.Duration) (voice.AudioChunk, error) {
		return voicetest.Tone(0.1, ""), nil
	}}
	a := fastAgent(tr)
	a.ResponseMaxDuration = 200 * time.Millisecond
	m, _ := callWithUserAudio(t, a)
	c, _ := voice.ExtractAudio(m)
	if c.Seconds() < 0.4-1e-9 || c.Seconds() > 0.5+1e-9 {
		t.Errorf("drained %vs, want the 2x ceiling", c.Seconds())
	}
}

type leftoverTransport struct {
	voicetest.Transport
	mu       sync.Mutex
	leftover []voice.AudioChunk
	drained  int
}

func (l *leftoverTransport) ReconcilePendingAudio() (voice.AudioChunk, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.drained++
	if len(l.leftover) == 0 {
		return voice.AudioChunk{}, false
	}
	c := l.leftover[0]
	l.leftover = l.leftover[1:]
	return c, true
}

func TestReconciledLeftoverGrowsThePriorAgentSegment(t *testing.T) {
	lt := &leftoverTransport{Transport: voicetest.Transport{Turns: []voicetest.Turn{reply(0.2, "first"), reply(0.1, "second")}}}
	a := voice.NewAgent(lt)
	a.ResponseTailSilence = 50 * time.Millisecond
	strand := scenario.StepFunc(func(context.Context, *scenario.Executor) error {
		lt.mu.Lock()
		lt.leftover = []voice.AudioChunk{voicetest.Tone(0.3, "")}
		lt.mu.Unlock()
		return nil
	})
	agents := []scenario.AgentAdapter{a, &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{
		scenario.User(), scenario.Agent(), strand, scenario.User(), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{})
	segs := voice.ResultOf(res).Recording.Segments
	if len(segs) != 4 {
		t.Fatalf("%d segments", len(segs))
	}
	first := segs[1]
	if first.Speaker != voice.SpeakerAgent || math.Abs(first.EndTime-first.StartTime-0.5) > 1e-9 || !first.TranscriptTruncated {
		t.Errorf("prior agent segment not grown: %+v", first)
	}
	if math.Abs(segs[2].StartTime-first.EndTime) > 1e-9 {
		t.Error("the user segment does not follow the grown agent segment")
	}
	var stop float64
	for _, e := range voice.ResultOf(res).Timeline {
		if e.Type == voice.AgentStopSpeaking {
			stop = e.Time
			break
		}
	}
	if math.Abs(stop-first.EndTime) > 1e-9 {
		t.Errorf("agent_stop_speaking at %v, segment ends %v", stop, first.EndTime)
	}
}

func TestOpeningGreetingIsNeverReconciled(t *testing.T) {
	lt := &leftoverTransport{Transport: voicetest.Transport{Turns: []voicetest.Turn{reply(0.2, "welcome")}}}
	a := voice.NewAgent(lt)
	a.ResponseTailSilence = 50 * time.Millisecond
	agents := []scenario.AgentAdapter{a, &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{scenario.Agent(), scenario.Succeed()}, voice.Config{})
	if lt.drained != 0 || len(voice.ResultOf(res).Recording.Segments) != 1 {
		t.Errorf("drained=%d segments=%d", lt.drained, len(voice.ResultOf(res).Recording.Segments))
	}
}

func TestLeftoverAfterAUserSegmentIsDrainedButDropped(t *testing.T) {
	lt := &leftoverTransport{Transport: voicetest.Transport{Turns: []voicetest.Turn{reply(0.2, "only")}}}
	a := voice.NewAgent(lt)
	a.ResponseTailSilence = 50 * time.Millisecond
	strand := scenario.StepFunc(func(context.Context, *scenario.Executor) error {
		lt.mu.Lock()
		lt.leftover = []voice.AudioChunk{voicetest.Tone(0.3, "")}
		lt.mu.Unlock()
		return nil
	})
	// No agent segment precedes the stranded audio, so it cannot be
	// attributed: it is drained (no bleed) and dropped.
	userSeg := scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		return ex.UserMessage(ctx, voice.AudioMessage(voicetest.Tone(0.1, "u"), scenario.RoleUser))
	})
	agents := []scenario.AgentAdapter{a, &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}}
	res := runScenario(t, agents, []scenario.ScriptStep{strand, userSeg, scenario.Agent(), scenario.Succeed()}, voice.Config{})
	segs := voice.ResultOf(res).Recording.Segments
	if lt.drained != 1 || len(lt.leftover) != 0 {
		t.Errorf("leftover not drained: %d", lt.drained)
	}
	if len(segs) != 2 || math.Abs(segs[0].EndTime-segs[0].StartTime-audio.Seconds(voicetest.Tone(0.1, "").Data)) > 1e-9 {
		t.Errorf("segments %+v", segs)
	}
}
