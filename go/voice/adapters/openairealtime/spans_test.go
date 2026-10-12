package openairealtime

import (
	"context"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
	"go.opentelemetry.io/otel/codes"
)

// agentTurn runs one agent-role Call fed with events once the adapter has
// requested its response.
func agentTurn(t *testing.T, srv *realtimetest.Server, a *Adapter, events ...map[string]any) callResult {
	t.Helper()
	mark := srv.Len()
	ch := startCall(a, audioInput(voice.SilentChunk(0.05)))
	srv.WaitType(t, "response.create", mark)
	for _, e := range events {
		srv.Push(t, e)
	}
	return await(t, ch)
}

func TestAgentTurnEmitsTheBaseSpansTaggedWithTheClass(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Role: scenario.AgentRoleAgent})
	connect(t, srv, a)
	spans.Reset()
	r := agentTurn(t, srv, a,
		map[string]any{"type": "response.created"}, pcmDelta(),
		map[string]any{"type": "response.output_audio_transcript.done", "transcript": "hi"},
		map[string]any{"type": "response.done"})
	if r.err != nil {
		t.Fatal(r.err)
	}
	got := byName(spans.GetSpans())
	turn, send, recv := got[voice.SpanTurn], got[voice.SpanAudioSend], got[voice.SpanAudioReceive]
	if turn.Name == "" || send.Name == "" || recv.Name == "" {
		t.Fatalf("spans = %v", got)
	}
	if v, _ := attr(turn, "voice.adapter.class"); v != "OpenAIRealtimeAgentAdapter" {
		t.Fatalf("class = %v", v)
	}
	if recv.Parent.SpanID() != turn.SpanContext.SpanID() {
		t.Fatal("receive is not a child of the turn")
	}
	if got := voice.AudioMessage(voice.AudioChunk{}, scenario.RoleAssistant); r.msgs[0].Role != got.Role {
		t.Fatalf("role = %s", r.msgs[0].Role)
	}
	if tx, _ := voice.ExtractTranscript(r.msgs[0]); tx != "hi" {
		t.Fatalf("transcript = %q", tx)
	}
}

func TestReceiveSpanCarriesResponseMarkersAndToolCount(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)

	spans.Reset()
	agentTurn(t, srv, a, map[string]any{"type": "response.created"}, pcmDelta(),
		map[string]any{"type": "response.output_audio_transcript.done", "transcript": "hi"},
		map[string]any{"type": "response.done"})
	recv := byName(spans.GetSpans())[voice.SpanAudioReceive]
	names := eventNames(recv)
	if !contains(names, "voice.realtime.response.created") || !contains(names, "voice.realtime.response.done") {
		t.Fatalf("events = %v", names)
	}
	if v, _ := attr(recv, "voice.realtime.tool_call_count"); v != int64(0) {
		t.Fatalf("tool_call_count = %v", v)
	}

	spans.Reset()
	agentTurn(t, srv, a, map[string]any{"type": "response.created"}, pcmDelta(),
		map[string]any{"type": "response.output_item.added", "item": map[string]any{"type": "function_call", "name": "get_weather", "call_id": "call_1"}},
		map[string]any{"type": "response.function_call_arguments.delta", "call_id": "call_1", "delta": `{"x":1}`},
		map[string]any{"type": "response.function_call_arguments.done", "call_id": "call_1", "arguments": `{"x":1}`},
		map[string]any{"type": "response.done"})
	recv = byName(spans.GetSpans())[voice.SpanAudioReceive]
	if v, _ := attr(recv, "voice.realtime.tool_call_count"); v != int64(1) {
		t.Fatalf("tool_call_count = %v", v)
	}

	spans.Reset()
	agentTurn(t, srv, a, map[string]any{"type": "response.created"}, pcmDelta(), map[string]any{"type": "response.cancelled"})
	names = eventNames(byName(spans.GetSpans())[voice.SpanAudioReceive])
	if !contains(names, "voice.realtime.response.created") || !contains(names, "voice.realtime.response.cancelled") {
		t.Fatalf("events = %v", names)
	}
}

func TestFirstChunkTimeoutMarksTheReceiveSpanError(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	a.ResponseTimeout = 300 * time.Millisecond
	connect(t, srv, a)
	spans.Reset()
	if _, err := a.Call(context.Background(), audioInput(voice.SilentChunk(0.05))); err == nil {
		t.Fatal("call succeeded")
	}
	recv := byName(spans.GetSpans())[voice.SpanAudioReceive]
	if recv.Status.Code != codes.Error {
		t.Fatalf("status = %v", recv.Status)
	}
	if v, _ := attr(recv, "voice.audio.terminated_reason"); v != "first_chunk_timeout" {
		t.Fatalf("reason = %v", v)
	}
}

func TestAutonomousUserTurnHasItsOwnTurnSpan(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Role: scenario.AgentRoleUser, Instructions: "simulate a customer"})
	connect(t, srv, a)
	spans.Reset()
	st := turnState(t, 2)
	if st.CurrentTurn() == 0 {
		t.Fatal("state at turn 0")
	}
	in := scenario.AgentInput{
		NewMessages:   []scenario.Message{voice.AudioMessage(voice.SilentChunk(0.05), scenario.RoleAssistant)},
		ScenarioState: st,
	}
	ch := startCall(a, in)
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.created"})
	srv.Push(t, pcmDelta())
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "customer line"})
	srv.Push(t, map[string]any{"type": "response.done"})
	srv.Push(t, map[string]any{"type": "error", "error": map[string]any{"message": "test: end turn"}})
	if r := await(t, ch); r.err != nil {
		t.Fatal(r.err)
	}
	got := byName(spans.GetSpans())
	turn := got[voice.SpanTurn]
	if v, _ := attr(turn, "voice.adapter.class"); v != "OpenAIRealtimeAgentAdapter" {
		t.Fatalf("class = %v", v)
	}
	if v, _ := attr(turn, "voice.turn.index"); v != int64(st.CurrentTurn()) {
		t.Fatalf("turn index = %v", v)
	}
	send, recv := got[voice.SpanAudioSend], got[voice.SpanAudioReceive]
	if send.Parent.SpanID() != turn.SpanContext.SpanID() || recv.Parent.SpanID() != turn.SpanContext.SpanID() {
		t.Fatal("send/receive are not children of the turn")
	}
	names := eventNames(recv)
	if !contains(names, "voice.realtime.response.created") || !contains(names, "voice.realtime.response.done") {
		t.Fatalf("events = %v", names)
	}
}

func TestConnectSpanCarriesRealtimeAttributes(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Model: "gpt-realtime-mini", Tools: []Tool{{Name: "noop"}}})
	srv.Arm()
	spans.Reset()
	// The real connect loop: the run's voice session connects the adapter.
	_, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "connect", Description: "connect",
		Agents: []scenario.AgentAdapter{a},
		Script: []scenario.ScriptStep{scenario.Succeed()},
	}, voice.WithConfig(voice.Config{Logger: quiet}), scenario.WithQuiet())
	if err != nil {
		t.Fatal(err)
	}
	c := byName(spans.GetSpans())[voice.SpanAdapterConnect]
	for k, want := range map[string]any{
		"voice.realtime.model":        "gpt-realtime-mini",
		"voice.realtime.voice":        "alloy",
		"voice.realtime.session_type": "realtime",
		"voice.realtime.tool_count":   int64(1),
	} {
		if v, _ := attr(c, k); v != want {
			t.Errorf("%s = %v, want %v", k, v, want)
		}
	}
}

func TestScriptedSpeakUserTurnOpensNoSpans(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Role: scenario.AgentRoleUser, Instructions: "simulate a customer"})
	connect(t, srv, a)
	spans.Reset()
	done := make(chan voice.AudioChunk, 1)
	go func() {
		c, _ := a.SpeakUserTurn(context.Background(), "hello")
		done <- c
	}()
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.created"})
	srv.Push(t, pcmDelta())
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "hello there"})
	srv.Push(t, map[string]any{"type": "response.done"})
	srv.Push(t, map[string]any{"type": "error", "error": map[string]any{"message": "test: end turn"}})
	<-done
	got := byName(spans.GetSpans())
	if _, ok := got[voice.SpanAudioReceive]; ok {
		t.Fatal("scripted path opened a receive span")
	}
	if _, ok := got[voice.SpanTurn]; ok {
		t.Fatal("scripted path opened a turn span")
	}
}

// No span carries the key, the persona, transcripts or tool arguments.
func TestSpansCarryNoSensitiveData(t *testing.T) {
	const apiKey, persona = "sk-REALKEYSHAPE1234567890", "SECRET_PERSONA_DO_NOT_LEAK"
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{APIKey: apiKey, Instructions: persona, Tools: []Tool{{Name: "noop"}}})
	spans.Reset()
	srv.Arm()
	ctx, span := voice.StartSpan(context.Background(), voice.SpanAdapterConnect)
	if err := a.Realtime().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	voice.EndSpan(span, nil)
	t.Cleanup(func() { _ = a.Realtime().Disconnect(context.Background()) })
	srv.WaitConnected(t)
	srv.WaitType(t, "session.update", 0)
	agentTurn(t, srv, a, map[string]any{"type": "response.created"}, pcmDelta(),
		map[string]any{"type": "response.output_audio_transcript.done", "transcript": "hi"},
		map[string]any{"type": "response.done"})

	deny := []string{"api_key", "apikey", "authorization", "instruction", "persona", "transcript", "arguments", "secret", "bearer"}
	for _, s := range spans.GetSpans() {
		for _, kv := range s.Attributes {
			key := strings.ToLower(string(kv.Key))
			for _, term := range deny {
				if strings.Contains(key, term) {
					t.Errorf("span %s has deny-listed attribute %s", s.Name, kv.Key)
				}
			}
			if v := kv.Value.String(); strings.Contains(v, apiKey) || strings.Contains(v, persona) {
				t.Errorf("span %s attribute %s leaks: %s", s.Name, kv.Key, v)
			}
		}
		for _, e := range s.Events {
			if strings.Contains(e.Name, apiKey) || strings.Contains(e.Name, persona) {
				t.Errorf("span %s event leaks: %s", s.Name, e.Name)
			}
		}
	}
}

// turnState is the scenario state of a real run after turns agent steps.
func turnState(t *testing.T, turn int) *scenario.ExecutionState {
	t.Helper()
	var st *scenario.ExecutionState
	noop := scenario.AgentFunc(func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
		return scenario.TextReturn("ok"), nil
	})
	steps := []scenario.ScriptStep{}
	for range turn {
		steps = append(steps, scenario.Agent("x"))
	}
	steps = append(steps, scenario.StepFunc(func(_ context.Context, ex *scenario.Executor) error {
		st = ex.State()
		return nil
	}), scenario.Succeed())
	if _, err := scenario.Run(context.Background(), scenario.ScenarioConfig{Name: "s", Description: "s",
		Agents: []scenario.AgentAdapter{noop}, Script: steps}, scenario.WithQuiet()); err != nil {
		t.Fatal(err)
	}
	return st
}
