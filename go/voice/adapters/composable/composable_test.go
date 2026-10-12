package composable

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/langwatch/scenario/go/voice/tts"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	slog.SetDefault(slog.New(slog.DiscardHandler))
	os.Exit(m.Run())
}

var (
	_ voice.Transport            = (*Transport)(nil)
	_ voice.Named                = (*Transport)(nil)
	_ voice.StreamingTranscriber = (*Transport)(nil)
	_ scenario.AgentAdapter      = (*Agent)(nil)
	_ voice.VoiceParticipant     = (*Agent)(nil)
)

// fakeLLM answers every call with text.
type fakeLLM struct {
	text  string
	mu    sync.Mutex
	calls []scenario.InferenceParams
	delay time.Duration
}

func (l *fakeLLM) Inference(ctx context.Context, p scenario.InferenceParams) (*scenario.InferenceResult, error) {
	l.mu.Lock()
	l.calls = append(l.calls, p)
	l.mu.Unlock()
	if l.delay > 0 {
		select {
		case <-time.After(l.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return &scenario.InferenceResult{Message: scenario.AssistantMsg(l.text)}, nil
}

func (l *fakeLLM) count() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.calls) }

// fixedTTS returns known bytes with no provider.
func fixedTTS(context.Context, string, string) (voice.AudioChunk, error) {
	return voice.AudioChunk{Data: []byte{9, 9, 9, 9}}, nil
}

func stubSTT(text string) stt.Provider {
	return stt.ProviderFunc(func(context.Context, voice.AudioChunk) (string, error) { return text, nil })
}

// The reply text rides on the chunk, so the runtime neither waits for a
// transcript nor re-transcribes audio it synthesized from known text.
func TestReplyTextIsTheChunkTranscript(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	for _, reply := range []string{"here are your two options: blue and red", ""} {
		tr := must(New(Options{STT: stubSTT("user said hello"), LLM: &fakeLLM{text: reply}, Voice: "openai/nova", Synthesize: fixedTTS}))
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: []byte{1, 2, 3, 4}}); err != nil {
			t.Fatal(err)
		}
		c, err := tr.ReceiveAudio(ctx, 30*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if c.Transcript != reply || len(c.Data) == 0 || tr.LastLLMResponse() != reply {
			t.Fatalf("reply %q: transcript %q, %d bytes, last %q", reply, c.Transcript, len(c.Data), tr.LastLLMResponse())
		}
	}
}

func TestTheTranscriptReachesTheAgentMessage(t *testing.T) {
	t.Parallel()
	sttCalls := &voicetest.STT{Text: "re-transcribed"}
	a := must(NewAgent(Options{STT: stubSTT("hi"), LLM: &fakeLLM{text: "hello back"}, Voice: "openai/nova", Synthesize: fixedTTS}))
	a.ResponseTailSilence = 20 * time.Millisecond
	res, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "composable", Description: "composable",
		Agents: []scenario.AgentAdapter{a, &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}},
		Script: []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()},
	}, voice.WithConfig(voice.Config{STT: sttCalls, Logger: slog.New(slog.DiscardHandler)}), scenario.WithQuiet())
	if err != nil {
		t.Fatal(err)
	}
	segs := voice.ResultOf(res).Recording.Segments
	if len(segs) != 2 || segs[1].Transcript != "hello back" {
		t.Fatalf("segments %+v", segs)
	}
	if n := sttCalls.Calls(); n != 0 {
		t.Fatalf("the run re-transcribed known text %d times", n)
	}
}

// ttsRecorder captures ElevenLabs text-to-speech requests.
type ttsRecorder struct {
	mu   sync.Mutex
	reqs []recordedTTS
}

type recordedTTS struct {
	Path, Query, Key string
	Body             map[string]any
}

func (r *ttsRecorder) client() *http.Client {
	return &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		if req.Body != nil {
			_ = json.NewDecoder(req.Body).Decode(&body)
		}
		r.mu.Lock()
		r.reqs = append(r.reqs, recordedTTS{req.URL.Path, req.URL.RawQuery, req.Header.Get("xi-api-key"), body})
		r.mu.Unlock()
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("\x01\x00\x02\x00"))}, nil
	})}
}

func (r *ttsRecorder) texts() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, q := range r.reqs {
		out = append(out, q.Body["text"].(string))
	}
	return out
}

func TestSeamsAreIndependentlySwappable(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	var transcribed int
	recorder := &ttsRecorder{}
	llm := &fakeLLM{text: "hello back"}
	elSynth := elevenLabsSynthesize("sk_fake_eleven", recorder.client())
	var synthesized []string
	tr := must(New(Options{
		STT: stt.ProviderFunc(func(context.Context, voice.AudioChunk) (string, error) { transcribed++; return "hi there", nil }),
		LLM: llm, Voice: "elevenlabs/test-voice",
		Synthesize: func(ctx context.Context, text, v string) (voice.AudioChunk, error) {
			synthesized = append(synthesized, text)
			return elSynth(ctx, text, v)
		},
	}))
	caps := tr.Capabilities()
	if caps.InputFormats[0] != "pcm16/24000" || caps.OutputFormats[0] != "pcm16/24000" || caps.NativeVAD {
		t.Fatalf("capabilities %+v", caps)
	}
	if err := tr.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	userAudio := voice.SilentChunk(0.5)
	if err := tr.SendAudio(ctx, userAudio); err != nil {
		t.Fatal(err)
	}
	out, err := tr.ReceiveAudio(ctx, 5*time.Second)
	if err != nil || len(out.Data) == 0 {
		t.Fatalf("chunk %d bytes, err %v", len(out.Data), err)
	}
	if transcribed != 1 || llm.count() != 1 || strings.Join(recorder.texts(), "|") != "hello back" {
		t.Fatalf("stt %d llm %d tts %v", transcribed, llm.count(), recorder.texts())
	}
	// The ElevenLabs request itself: voice in the path, model and format
	// pinned, so a wrong-model regression fails here.
	req := recorder.reqs[0]
	if req.Path != "/v1/text-to-speech/test-voice" || req.Query != "output_format=pcm_24000" ||
		req.Body["model_id"] != "eleven_v3" || req.Key != "sk_fake_eleven" {
		t.Fatalf("TTS request %+v", req)
	}
	// A turn answers once: the drain's tail probe ends it.
	if c, err := tr.ReceiveAudio(ctx, time.Second); err != nil || len(c.Data) != 0 {
		t.Fatalf("second receive of the turn: %d bytes, %v", len(c.Data), err)
	}

	// Swap only the STT; the LLM and TTS keep firing.
	var replaced int
	tr.SetSTT(stt.ProviderFunc(func(context.Context, voice.AudioChunk) (string, error) { replaced++; return "another question", nil }))
	if err := tr.SendAudio(ctx, userAudio); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.ReceiveAudio(ctx, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	// The repeated reply is served from the TTS cache: synthesized twice,
	// requested once.
	if replaced != 1 || llm.count() != 2 || len(synthesized) != 2 || len(recorder.texts()) != 1 {
		t.Fatalf("replacement %d llm %d synthesized %d requests %d", replaced, llm.count(), len(synthesized), len(recorder.texts()))
	}
	// The intermediate transcript and the LLM decision are observable.
	if tr.LastUserTranscript() != "another question" || tr.LastLLMResponse() != "hello back" {
		t.Fatalf("user %q llm %q", tr.LastUserTranscript(), tr.LastLLMResponse())
	}
	// The LLM saw the whole conversation, system prompt first.
	msgs := llm.calls[1].Messages
	if len(msgs) != 4 || msgs[0].Role != scenario.RoleSystem || msgs[0].Content != DefaultSystemPrompt || msgs[3].Content != "another question" {
		t.Fatalf("history %+v", msgs)
	}
	_ = tr.Disconnect(ctx)
}

func TestReceiveTimesOut(t *testing.T) {
	t.Parallel()
	tr := must(New(Options{STT: stubSTT("x"), LLM: &fakeLLM{text: "late", delay: time.Second}, Voice: "openai/nova", Synthesize: fixedTTS}))
	_ = tr.SendAudio(context.Background(), voice.AudioChunk{Data: []byte{1, 2}})
	_, err := tr.ReceiveAudio(context.Background(), 20*time.Millisecond)
	if !errors.Is(err, voice.ErrReceiveTimeout) || !strings.Contains(err.Error(), "ComposableVoiceAgent: receiveAudio timed out") {
		t.Fatalf("err %v", err)
	}
}

func TestDefaultModelComesFromConfigure(t *testing.T) {
	tr := must(New(Options{STT: stubSTT("x"), Voice: "openai/nova", Synthesize: fixedTTS}))
	_ = tr.SendAudio(context.Background(), voice.AudioChunk{Data: []byte{1, 2}})
	if _, err := tr.ReceiveAudio(context.Background(), time.Second); !errors.Is(err, scenario.ErrNoModel) {
		t.Fatalf("without any model: %v", err)
	}
	llm := &fakeLLM{text: "ok"}
	prev := scenario.CurrentSettings().DefaultModel
	scenario.Configure(scenario.WithDefaultModel(scenario.ModelConfig{LLM: llm, Model: "configured-model"}))
	defer scenario.Configure(scenario.WithDefaultModel(prev))
	if _, err := tr.ReceiveAudio(context.Background(), time.Second); err != nil {
		t.Fatal(err)
	}
	if llm.calls[0].Model != "configured-model" {
		t.Fatalf("model %q", llm.calls[0].Model)
	}
}

func TestConstruction(t *testing.T) {
	t.Parallel()
	if _, err := New(Options{Voice: "openai/nova"}); err == nil {
		t.Fatal("accepted a missing STT")
	}
	if _, err := New(Options{STT: stubSTT("x"), Voice: "nova"}); err == nil || !strings.Contains(err.Error(), "'<provider>/<voiceId>'") {
		t.Fatalf("voice without provider: %v", err)
	}
	a := must(NewAgent(Options{STT: stubSTT("x"), LLM: &fakeLLM{}, Voice: "openai/nova"}))
	if a.Name() != "ComposableVoiceAgent" || a.Role() != scenario.AgentRoleAgent || a.VoiceAgent() == nil {
		t.Fatalf("agent %q %v", a.Name(), a.Role())
	}
	if a.String() != "ComposableVoiceAgent(llm=<LLM>, tts='openai/nova')" {
		t.Fatalf("String() = %q", a.String())
	}
}

func TestElevenLabsPresetDefaults(t *testing.T) {
	t.Setenv(VoiceIDEnv, "")
	branded := must(NewElevenLabsAgent(ElevenLabsOptions{APIKey: "sk_fake_eleven"}))
	tr := branded.Composable()
	if _, ok := tr.STT().(*stt.ElevenLabs); !ok {
		t.Fatalf("default STT %T", tr.STT())
	}
	if tr.Voice() != "elevenlabs/"+tts.ElevenLabsDefaultVoiceID {
		t.Fatalf("default voice %q", tr.Voice())
	}
	if branded.Name() != "ElevenLabsVoiceAgent" || strings.Contains(branded.String(), "sk_fake") {
		t.Fatalf("name %q string %q", branded.Name(), branded.String())
	}
	wide := must(NewElevenLabs(ElevenLabsOptions{APIKey: "x", Voice: "elevenlabs/custom", SystemPrompt: "be terse"}))
	if wide.Voice() != "elevenlabs/custom" || wide.history[0].Content != "be terse" {
		t.Fatalf("voice %q prompt %q", wide.Voice(), wide.history[0].Content)
	}
	t.Setenv(VoiceIDEnv, "env-voice")
	if v := must(NewElevenLabs(ElevenLabsOptions{APIKey: "x"})).Voice(); v != "elevenlabs/env-voice" {
		t.Fatalf("env voice %q", v)
	}
}

func TestElevenLabsPresetOverrides(t *testing.T) {
	t.Setenv(VoiceIDEnv, "")
	baseline := must(NewElevenLabs(ElevenLabsOptions{APIKey: "sk"}))
	llm := &fakeLLM{text: "ok"}
	custom := stubSTT("custom")

	llmOverride := must(NewElevenLabs(ElevenLabsOptions{APIKey: "sk", LLM: llm}))
	if llmOverride.LLM() != llm || baseline.LLM() != nil || llmOverride.Voice() != baseline.Voice() {
		t.Fatal("LLM override leaked into the other pieces")
	}
	if _, ok := llmOverride.STT().(*stt.ElevenLabs); !ok {
		t.Fatal("LLM override changed the STT")
	}
	sttOverride := must(NewElevenLabs(ElevenLabsOptions{APIKey: "sk", STT: custom}))
	if sttOverride.Voice() != baseline.Voice() {
		t.Fatal("STT override changed the voice")
	}
	if c, _ := sttOverride.STT().Transcribe(context.Background(), voice.AudioChunk{}); c != "custom" {
		t.Fatal("STT override not used")
	}
	ttsOverride := must(NewElevenLabs(ElevenLabsOptions{APIKey: "sk", Voice: "elevenlabs/another-voice"}))
	if ttsOverride.Voice() != "elevenlabs/another-voice" {
		t.Fatal("voice override not used")
	}
	if _, ok := ttsOverride.STT().(*stt.ElevenLabs); !ok {
		t.Fatal("voice override changed the STT")
	}
	// The ElevenLabs STT drops into the generic composable path too.
	el := stt.NewElevenLabs(stt.ElevenLabsOptions{APIKey: "sk"})
	if must(New(Options{STT: el, LLM: llm, Voice: "elevenlabs/test"})).STT() != el {
		t.Fatal("ElevenLabs STT not accepted by the composable agent")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
