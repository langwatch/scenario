package voice_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/voicetest"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func spanAttr(s tracetest.SpanStub, key string) (string, bool) {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.String(), true
		}
	}
	return "", false
}

func spansNamed(name string) []tracetest.SpanStub {
	var out []tracetest.SpanStub
	for _, s := range spans.GetSpans() {
		if s.Name == name {
			out = append(out, s)
		}
	}
	return out
}

func userTurnInput() scenario.AgentInput {
	return scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(voicetest.Tone(0.05, "q"), scenario.RoleUser)}}
}

func TestTurnEmitsNestedVoiceSpans(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a")}}
	ctx, root := otel.Tracer("test").Start(context.Background(), "root")
	if _, err := fastAgent(tr).Call(ctx, userTurnInput()); err != nil {
		t.Fatal(err)
	}
	root.End()
	turn, send, recv := spansNamed(voice.SpanTurn), spansNamed(voice.SpanAudioSend), spansNamed(voice.SpanAudioReceive)
	if len(turn) != 1 || len(send) != 1 || len(recv) != 1 {
		t.Fatalf("turn=%d send=%d recv=%d", len(turn), len(send), len(recv))
	}
	if send[0].Parent.SpanID() != turn[0].SpanContext.SpanID() || recv[0].Parent.SpanID() != turn[0].SpanContext.SpanID() {
		t.Error("send/receive do not nest under voice.turn")
	}
	if v, _ := spanAttr(turn[0], "voice.adapter.class"); v != "FakeVoiceAdapter" {
		t.Errorf("adapter class %q", v)
	}
	if v, _ := spanAttr(turn[0], "langwatch.span.type"); v != "span" {
		t.Errorf("span type %q", v)
	}
	if v, _ := spanAttr(send[0], "voice.audio.bytes"); v != "2400" {
		t.Errorf("send bytes %q", v)
	}
	if _, ok := spanAttr(turn[0], "voice.turn.user_audio_bytes"); !ok {
		t.Error("no user_audio_bytes")
	}
	if v, _ := spanAttr(recv[0], "voice.audio.terminated_reason"); v != "terminal_chunk" {
		t.Errorf("terminated_reason %q", v)
	}
	if _, ok := spanAttr(recv[0], "voice.audio.first_chunk_latency_ms"); !ok {
		t.Error("no first_chunk_latency_ms")
	}
}

func TestTurnWithoutIncomingAudioSendsNothing(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a")}}
	if _, err := fastAgent(tr).Call(context.Background(), scenario.AgentInput{}); err != nil {
		t.Fatal(err)
	}
	if n := len(spansNamed(voice.SpanAudioSend)); n != 0 {
		t.Errorf("%d send spans", n)
	}
	if _, ok := spanAttr(spansNamed(voice.SpanTurn)[0], "voice.turn.user_audio_bytes"); ok {
		t.Error("user_audio_bytes on a turn without user audio")
	}
}

func TestHardCeilingIsLabelled(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Receive: func(context.Context, time.Duration) (voice.AudioChunk, error) { return voicetest.Tone(0.1, ""), nil }}
	a := fastAgent(tr)
	a.ResponseMaxDuration = 100 * time.Millisecond
	if _, err := a.Call(context.Background(), scenario.AgentInput{}); err != nil {
		t.Fatal(err)
	}
	if v, _ := spanAttr(spansNamed(voice.SpanAudioReceive)[0], "voice.audio.terminated_reason"); v != "hard_ceiling" {
		t.Errorf("terminated_reason %q", v)
	}
}

func TestFirstChunkTimeoutMarksReceiveError(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Receive: func(context.Context, time.Duration) (voice.AudioChunk, error) {
		return voice.AudioChunk{}, voice.ErrReceiveTimeout
	}}
	_, err := fastAgent(tr).Call(context.Background(), scenario.AgentInput{})
	if !errors.Is(err, voice.ErrReceiveTimeout) {
		t.Fatalf("got %v", err)
	}
	recv := spansNamed(voice.SpanAudioReceive)[0]
	if recv.Status.Code != codes.Error {
		t.Error("receive span not ERROR")
	}
	if v, _ := spanAttr(recv, "voice.audio.terminated_reason"); v != "first_chunk_timeout" {
		t.Errorf("terminated_reason %q", v)
	}
	if spansNamed(voice.SpanTurn)[0].Status.Code != codes.Error {
		t.Error("turn span not ERROR")
	}
}

func TestRunSpansParentUnderTheScenario(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a")}}
	runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()}, voice.Config{})
	var turn1 tracetest.SpanStub
	for _, s := range spansNamed("Scenario Turn") {
		if v, _ := spanAttr(s, "scenario.turn"); v == "1" {
			turn1 = s
		}
	}
	connect := spansNamed(voice.SpanAdapterConnect)
	if len(connect) != 1 || connect[0].Parent.SpanID() != turn1.SpanContext.SpanID() {
		t.Fatal("voice.adapter.connect does not nest under the turn-1 span")
	}
	if v, _ := spanAttr(connect[0], "voice.adapter.capabilities.native_vad"); v != "true" {
		t.Errorf("native_vad %q", v)
	}
	turns := spansNamed(voice.SpanTurn)
	if len(turns) != 1 || turns[0].SpanContext.TraceID() != turn1.SpanContext.TraceID() {
		t.Error("voice.turn is not in the run's trace")
	}
	if v, _ := spanAttr(turns[0], "voice.turn.index"); v != "0" {
		t.Errorf("turn index %q", v)
	}
	run := spansNamed("Scenario Run")
	disc := spansNamed(voice.SpanAdapterDisconnect)
	if len(disc) != 1 || disc[0].Parent.SpanID() != run[len(run)-1].SpanContext.SpanID() {
		t.Error("voice.adapter.disconnect does not nest under the run span")
	}
}

// panickingProcessor fails every voice span's export.
type panickingProcessor struct{ sdktrace.SpanProcessor }

func (panickingProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (panickingProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	if strings.HasPrefix(s.Name(), "voice.") {
		panic("exporter down")
	}
}
func (panickingProcessor) Shutdown(context.Context) error   { return nil }
func (panickingProcessor) ForceFlush(context.Context) error { return nil }

func TestSpanExportFailureDoesNotBreakTheTurn(t *testing.T) {
	tp := otel.GetTracerProvider().(*sdktrace.TracerProvider)
	p := panickingProcessor{}
	tp.RegisterSpanProcessor(p)
	defer tp.UnregisterSpanProcessor(p)
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "a")}}
	if _, err := fastAgent(tr).Call(context.Background(), userTurnInput()); err != nil {
		t.Fatalf("a span export failure broke the turn: %v", err)
	}
}

func TestBackfillTranscribesSegmentsWithoutTranscript(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "")}}
	stt := &voicetest.STT{Text: " transcribed "}
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()}, voice.Config{STT: stt})
	segs := voice.ResultOf(res).Recording.Segments
	if segs[1].Transcript != "transcribed" || stt.Calls() != 1 {
		t.Errorf("agent transcript %q, %d STT calls", segs[1].Transcript, stt.Calls())
	}
	if len(spansNamed(voice.SpanSTTBackfill)) != 1 || len(spansNamed(voice.SpanSTTTranscribe)) != 1 {
		t.Error("missing STT back-fill spans")
	}
}

func TestBackfillFailureLeavesTranscriptUnset(t *testing.T) {
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "")}}
	stt := &voicetest.STT{Err: errors.New("401 sk-secret")}
	res := runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()}, voice.Config{STT: stt})
	if !res.Success || voice.ResultOf(res).Recording.Segments[1].Transcript != "" {
		t.Error("STT failure leaked into the result")
	}
	for _, s := range spansNamed(voice.SpanSTTTranscribe) {
		for _, e := range s.Events {
			for _, kv := range e.Attributes {
				if strings.Contains(kv.Value.String(), "sk-secret") {
					t.Error("the provider error body reached the span")
				}
			}
		}
	}
}

func TestBackfillSpansNestAndLabelSpeakers(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "")}}
	sim := voice.NewUserSimulator(textUser{}, voice.UserSimulatorOptions{Voice: "fake/v", Synthesize: func(ctx context.Context, text, v string) (voice.AudioChunk, error) {
		c, _ := voicetest.Synthesize(ctx, text, v)
		c.Transcript = ""
		return c, nil
	}})
	// Both segments lack transcripts once the user turn's text is dropped.
	runScenario(t, []scenario.AgentAdapter{fastAgent(tr), sim, &voicetest.Judge{}}, []scenario.ScriptStep{
		scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
			return ex.UserMessage(ctx, voice.AudioMessage(voicetest.Tone(0.05, ""), scenario.RoleUser))
		}),
		scenario.Agent(), scenario.Succeed(),
	}, voice.Config{STT: &voicetest.STT{Text: ""}})
	batch := spansNamed(voice.SpanSTTBackfill)
	if len(batch) != 1 {
		t.Fatalf("%d backfill spans", len(batch))
	}
	if v, _ := spanAttr(batch[0], "voice.stt.segment_count"); v != "2" {
		t.Errorf("segment_count %q", v)
	}
	speakers := map[string]bool{}
	for _, s := range spansNamed(voice.SpanSTTTranscribe) {
		if s.Parent.SpanID() != batch[0].SpanContext.SpanID() {
			t.Error("transcribe span not under the batch")
		}
		v, _ := spanAttr(s, "voice.stt.speaker")
		speakers[v] = true
		if _, ok := spanAttr(s, "voice.stt.transcript_chars"); ok || s.Status.Code == codes.Error {
			t.Error("an empty transcript must be OK without transcript_chars")
		}
	}
	if !speakers["user"] || !speakers["agent"] {
		t.Errorf("speakers %v", speakers)
	}
}

func TestBackfillFailureMarksTheSpanError(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "")}}
	runScenario(t, basicAgents(tr), []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Succeed()},
		voice.Config{STT: &voicetest.STT{Err: errors.New("raw body sk-123")}})
	ts := spansNamed(voice.SpanSTTTranscribe)
	if len(ts) != 1 || ts[0].Status.Code != codes.Error || strings.Contains(ts[0].Status.Description, "sk-123") {
		t.Errorf("transcribe spans %+v", ts)
	}
}

func TestNoBackfillSpansWhenEverySegmentHasATranscript(t *testing.T) {
	spans.Reset()
	tr := &voicetest.Transport{Turns: []voicetest.Turn{reply(0.1, "said")}}
	runScenario(t, []scenario.AgentAdapter{fastAgent(tr), &voicetest.User{}, &voicetest.Judge{}}, []scenario.ScriptStep{
		scenario.User("x"), scenario.Agent(), scenario.Succeed(),
	}, voice.Config{})
	if len(spansNamed(voice.SpanSTTBackfill)) != 0 {
		t.Error("back-fill ran with every transcript present")
	}
}
