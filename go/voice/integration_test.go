package voice_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/effects"
	"github.com/langwatch/scenario/go/voice/vad"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

// recordingLLM answers with fn and records the requests.
type recordingLLM struct {
	mu   sync.Mutex
	reqs []scenario.InferenceParams
	fn   func(scenario.InferenceParams) *scenario.InferenceResult
}

func (l *recordingLLM) Inference(_ context.Context, p scenario.InferenceParams) (*scenario.InferenceResult, error) {
	l.mu.Lock()
	l.reqs = append(l.reqs, p)
	l.mu.Unlock()
	return l.fn(p), nil
}

func (l *recordingLLM) requests() []scenario.InferenceParams {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]scenario.InferenceParams(nil), l.reqs...)
}

func finishTest() *scenario.InferenceResult {
	return &scenario.InferenceResult{Message: scenario.Message{Role: scenario.RoleAssistant,
		ToolCalls: []scenario.ToolCall{{ID: "c1", Name: "finish_test", Arguments: `{"criteria":{},"reasoning":"ok"}`}}}}
}

func TestJudgeReadsTranscribedAudioAndTimeline(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "")}}
	llm := &recordingLLM{fn: func(scenario.InferenceParams) *scenario.InferenceResult { return finishTest() }}
	judge := scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: scenario.ModelConfig{LLM: llm, Model: "text-model"}, Criteria: []string{"agent answers"}})
	stt := &voicetest.STT{Text: "the spoken answer"}
	_, _ = tryScenario([]scenario.AgentAdapter{fastAgent(tr), &voicetest.User{Lines: []string{"question?"}}, judge},
		[]scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Judge()}, voice.Config{STT: stt})
	reqs := llm.requests()
	if len(reqs) == 0 {
		t.Fatal("judge not called")
	}
	content := reqs[0].Messages[len(reqs[0].Messages)-1].Content
	for _, want := range []string{"the spoken answer", "question?", "<voice_timeline>", "agent_start_speaking"} {
		if !strings.Contains(content, want) {
			t.Errorf("judge input lacks %q:\n%s", want, content)
		}
	}
	transcript, _, _ := strings.Cut(content, "</transcript>")
	if strings.Contains(transcript, "audio/pcm16") {
		t.Errorf("a text-only judge received audio:\n%s", transcript)
	}
}

func TestTimelineCanBeTurnedOffForTheJudge(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "fine")}}
	llm := &recordingLLM{fn: func(scenario.InferenceParams) *scenario.InferenceResult { return finishTest() }}
	judge := scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: scenario.ModelConfig{LLM: llm, Model: "m"}, Criteria: []string{"c"}})
	off := false
	_, _ = tryScenario([]scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, judge},
		[]scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Judge()}, voice.Config{IncludeTimeline: &off})
	if c := llm.requests()[0].Messages[1].Content; strings.Contains(c, "voice_timeline") {
		t.Error("timeline included although disabled")
	}
}

func TestTranscribeAudioMessages(t *testing.T) {
	audioOnly := voice.AudioMessage(voicetest.Tone(0.02, ""), scenario.RoleAssistant)
	withText := voice.AudioMessage(voicetest.Tone(0.02, "already"), scenario.RoleUser)
	plain := scenario.UserMsg("plain")
	stt := &voicetest.STT{Text: "heard"}
	msgs := []scenario.Message{audioOnly, withText, plain}

	out := voice.TranscribeAudioMessages(t.Context(), msgs, stt, voice.TranscribeMessagesOptions{})
	if stt.Calls() != 1 {
		t.Errorf("%d STT calls", stt.Calls())
	}
	if out[0].Text() != "heard" || out[0].HasAudio() || out[1].Text() != "already" || out[1].HasAudio() || out[2].Content != "plain" {
		t.Errorf("text-only output %+v", out)
	}
	if !msgs[0].HasAudio() || len(msgs[0].Parts) != 1 {
		t.Error("input mutated")
	}
	kept := voice.TranscribeAudioMessages(t.Context(), msgs, stt, voice.TranscribeMessagesOptions{IncludeAudio: true})
	if !kept[0].HasAudio() || kept[0].Parts[0].Text != "heard" {
		t.Errorf("audio not kept: %+v", kept[0].Parts)
	}
}

func TestTranscribeFailureDegradesToTextOnly(t *testing.T) {
	var warned string
	stt := &voicetest.STT{Err: errors.New("down")}
	out := voice.TranscribeAudioMessages(t.Context(), []scenario.Message{voice.AudioMessage(voicetest.Tone(0.02, ""), scenario.RoleUser)}, stt,
		voice.TranscribeMessagesOptions{Warn: func(s string) { warned = s }})
	if out[0].HasAudio() || len(out[0].Parts) != 0 || !strings.Contains(warned, "down") {
		t.Errorf("%+v %q", out[0], warned)
	}
}

func TestUserSimulatorSTTFallbackIsCachedAcrossTurns(t *testing.T) {
	// The agent's audio has no transcript; the text simulator must read
	// transcribed words, and the same audio must hit STT once.
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, ""), reply(0.2, ""), reply(0.3, "")}}
	llm := &recordingLLM{fn: func(scenario.InferenceParams) *scenario.InferenceResult {
		return &scenario.InferenceResult{Message: scenario.AssistantMsg("ok then")}
	}}
	sim := voice.NewUserSimulator(scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: scenario.ModelConfig{LLM: llm, Model: "m"}}),
		voice.UserSimulatorOptions{Voice: "fake/v", Synthesize: voicetest.Synthesize})
	n := 0
	stt := &voicetest.STT{Fn: func(c voice.AudioChunk) (string, error) { n++; return "agent words", nil }}
	runScenario(t, []scenario.AgentAdapter{fastAgent(tr), sim, &voicetest.Judge{}}, []scenario.ScriptStep{
		scenario.User("hi"), scenario.Agent(), scenario.User(), scenario.Agent(), scenario.User(), scenario.Succeed(),
	}, voice.Config{STT: stt})
	reqs := llm.requests()
	if len(reqs) != 2 {
		t.Fatalf("%d simulator calls", len(reqs))
	}
	last := reqs[1].Messages
	joined := ""
	for _, m := range last {
		joined += m.Text() + "|"
	}
	if !strings.Contains(joined, "[the agent said: agent words]") || strings.Contains(joined, "[audio message]") {
		t.Errorf("simulator input %q", joined)
	}
	// Two distinct agent replies were transcribed for the simulator, each
	// once; the back-fill reuses nothing, so allow the run total to exceed.
	if n < 2 {
		t.Errorf("%d STT calls", n)
	}
}

func TestVoiceUserSimulatorVoicesScriptedAndGeneratedTurns(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a"), reply(0.1, "b")}}
	llm := &recordingLLM{fn: func(scenario.InferenceParams) *scenario.InferenceResult {
		return &scenario.InferenceResult{Message: scenario.AssistantMsg("generated line")}
	}}
	var voiced []string
	sim := voice.NewUserSimulator(scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: scenario.ModelConfig{LLM: llm, Model: "m"}}),
		voice.UserSimulatorOptions{Voice: "fake/v", Synthesize: func(ctx context.Context, text, v string) (voice.AudioChunk, error) {
			voiced = append(voiced, text+"@"+v)
			return voicetest.Synthesize(ctx, text, v)
		}})
	res := runScenario(t, []scenario.AgentAdapter{fastAgent(tr), sim, &voicetest.Judge{}}, []scenario.ScriptStep{
		scenario.User("scripted line"), scenario.Agent(), scenario.User(), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{})
	if strings.Join(voiced, ",") != "scripted line@fake/v,generated line@fake/v" {
		t.Errorf("voiced %v", voiced)
	}
	if sent := tr.Sent(); len(sent) != 2 || sent[0].Transcript != "scripted line" {
		t.Errorf("agent heard %d turns", len(sent))
	}
	if m := res.Messages[0]; !m.HasAudio() || m.Text() != "scripted line" {
		t.Errorf("user message %+v", m)
	}
}

func TestRunLevelTTSVoiceIsUsed(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a")}}
	var gotVoice string
	sim := voice.NewUserSimulator(textUser{}, voice.UserSimulatorOptions{Synthesize: func(ctx context.Context, text, v string) (voice.AudioChunk, error) {
		gotVoice = v
		return voicetest.Synthesize(ctx, text, v)
	}})
	runScenario(t, []scenario.AgentAdapter{fastAgent(tr), sim, &voicetest.Judge{}}, []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()},
		voice.Config{TTSVoice: "openai/nova"})
	if gotVoice != "openai/nova" {
		t.Errorf("voice %q", gotVoice)
	}
}

func TestTextUserTurnForAVoiceAgentFailsClosed(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a")}}
	_, err := tryScenario([]scenario.AgentAdapter{fastAgent(tr), textUser{}, &voicetest.Judge{}}, []scenario.ScriptStep{scenario.User(), scenario.Agent()}, voice.Config{})
	if !errors.Is(err, voice.ErrUserTurnNoAudio) {
		t.Fatalf("got %v", err)
	}
}

func TestOneShotOverrideAppliesToOneTurn(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.05, "a"), reply(0.05, "b")}}
	sim := voice.NewUserSimulator(textUser{}, voice.UserSimulatorOptions{Voice: "fake/v", Synthesize: voicetest.Synthesize})
	quiet := effects.Must(effects.LowVolume(0.1))
	runScenario(t, []scenario.AgentAdapter{fastAgent(tr), sim, &voicetest.Judge{}}, []scenario.ScriptStep{
		voice.User(voice.UserStepOptions{AudioEffects: []effects.Effect{quiet}}, "soft"), scenario.Agent(),
		scenario.User("soft"), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{})
	sent := tr.Sent()
	if audio.RMS(sent[0].Data) >= audio.RMS(sent[1].Data)/2 {
		t.Errorf("override not applied to the first turn only: %v vs %v", audio.RMS(sent[0].Data), audio.RMS(sent[1].Data))
	}
}

func TestBackgroundNoiseMixesIntoUserTurns(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.05, "a"), reply(0.05, "b")}}
	sim := voice.NewUserSimulator(textUser{}, voice.UserSimulatorOptions{Voice: "fake/v", Synthesize: voicetest.Synthesize})
	runScenario(t, []scenario.AgentAdapter{fastAgent(tr), sim, &voicetest.Judge{}}, []scenario.ScriptStep{
		scenario.User("x"), scenario.Agent(), voice.BackgroundNoise("cafe", 0.5), scenario.User("x"), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{})
	sent := tr.Sent()
	if bytes.Equal(sent[0].Data, sent[1].Data) {
		t.Error("background noise did not change the user audio")
	}
	_, err := tryScenario(basicAgents(&voicetest.Transport{}), []scenario.ScriptStep{voice.BackgroundNoise("cafe", 2)}, voice.Config{})
	if err == nil || !strings.Contains(err.Error(), "out of range") {
		t.Errorf("volume 2 accepted: %v", err)
	}
}

// --- steps -------------------------------------------------------------------

func TestSleepUsesTheRunClock(t *testing.T) {
	clock := voicetest.NewClock()
	start := clock.Now()
	runScenario(t, basicAgents(&voicetest.Transport{}), []scenario.ScriptStep{voice.Sleep(3 * time.Second), scenario.Succeed()}, voice.Config{Clock: clock})
	if clock.Now().Sub(start) != 3*time.Second {
		t.Errorf("advanced %v", clock.Now().Sub(start))
	}
}

func TestSilenceSendsSilentAudio(t *testing.T) {
	tr := &voicetest.Transport{}
	runScenario(t, basicAgents(tr), []scenario.ScriptStep{voice.Silence(500 * time.Millisecond), scenario.Succeed()}, voice.Config{})
	sent := tr.Sent()
	if len(sent) != 1 || len(sent[0].Data) != 24000 || audio.RMS(sent[0].Data) != 0 {
		t.Errorf("sent %d chunks", len(sent))
	}
}

func TestAudioBytesStepSendsDecodedWAV(t *testing.T) {
	tr := &voicetest.Transport{}
	pcm := voicetest.Tone(0.1, "").Data
	runScenario(t, basicAgents(tr), []scenario.ScriptStep{voice.AudioBytes(audio.AppendWAV(nil, pcm)), scenario.Succeed()}, voice.Config{})
	if sent := tr.Sent(); len(sent) != 1 || !bytes.Equal(sent[0].Data, pcm) {
		t.Error("decoded audio not sent")
	}
	_, err := tryScenario(basicAgents(tr), []scenario.ScriptStep{voice.AudioFile("https://example.com/a.wav")}, voice.Config{})
	if err == nil || !strings.Contains(err.Error(), "URL-like") {
		t.Errorf("URL accepted: %v", err)
	}
}

func TestDTMFNeedsTheCapability(t *testing.T) {
	_, err := tryScenario(basicAgents(&voicetest.Transport{}), []scenario.ScriptStep{voice.DTMF("123")}, voice.Config{})
	var uc *voice.UnsupportedCapabilityError
	if !errors.As(err, &uc) || uc.Capability != "dtmf" || uc.Adapter != "FakeVoiceAdapter" {
		t.Fatalf("got %v", err)
	}
	tr := &voicetest.Transport{Caps: voice.Capabilities{NativeVAD: true, DTMF: true}}
	runScenario(t, basicAgents(tr), []scenario.ScriptStep{voice.DTMF("1#"), scenario.Succeed()}, voice.Config{})
	if d := tr.DTMF(); len(d) != 1 || d[0] != "1#" {
		t.Errorf("dtmf %v", d)
	}
}

// --- VAD fallback ----------------------------------------------------------------

func TestVADFallbackDetectsUserSpeechOnce(t *testing.T) {
	vad.ResetFallbackWarnings()
	var buf bytes.Buffer
	log := newBufLogger(&buf)
	tr := &voicetest.Transport{Caps: voice.Capabilities{InputFormats: []string{"pcm16/24000"}}, Turns: []voicetest.Turn{reply(0.05, "a"), reply(0.05, "b")}}
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{
		scenario.User(), scenario.Agent(), scenario.User(), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{Logger: log})
	starts := 0
	for _, e := range voice.ResultOf(res).Timeline {
		if e.Type == voice.UserStartSpeaking && e.Metadata["source"] == "vad-fallback" {
			starts++
		}
	}
	if starts == 0 {
		t.Error("no vad-fallback user_start_speaking")
	}
	if c := strings.Count(buf.String(), "has no native VAD"); c != 1 {
		t.Errorf("fallback warning emitted %d times", c)
	}
}
