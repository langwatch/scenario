package openairealtime

import (
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

var spans = tracetest.NewInMemoryExporter()

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	for _, k := range []string{"LANGWATCH_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_REALTIME_API_KEY", "OPENAI_REALTIME_URL"} {
		os.Unsetenv(k)
	}
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(spans))))
	os.Exit(m.Run())
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// buildAdapter wires an adapter to the mock server through the public URL
// option, with no mint and fast turn timings.
func buildAdapter(srv *realtimetest.Server, o Options) *Adapter {
	o.URL = srv.URL + "/realtime?model={model}"
	if o.APIKey == "" {
		o.APIKey = "test-key"
	}
	o.NoMint = true
	if o.Logger == nil {
		o.Logger = quiet
	}
	a := New(o)
	a.ResponseTailSilence = 50 * time.Millisecond
	a.ResponseTimeout = 2 * time.Second
	a.TranscriptGraceWait = 0
	return a
}

// connect opens the adapter's socket and waits for its session.update.
func connect(t *testing.T, srv *realtimetest.Server, a *Adapter) {
	t.Helper()
	srv.Arm()
	if err := a.Realtime().Connect(context.Background()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	srv.WaitConnected(t)
	srv.WaitType(t, "session.update", 0)
	t.Cleanup(func() { _ = a.Realtime().Disconnect(context.Background()) })
}

func b64(b ...byte) string { return base64.StdEncoding.EncodeToString(b) }

// pcmDelta is a tiny valid (even-byte) PCM16 audio delta.
func pcmDelta() map[string]any {
	return map[string]any{"type": "response.output_audio.delta", "delta": b64(0x10, 0x00, 0x20, 0x00)}
}

// audioInput is an agent input whose new message is user audio.
func audioInput(c voice.AudioChunk) scenario.AgentInput {
	return scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(c, scenario.RoleUser)}}
}

type callResult struct {
	msgs []scenario.Message
	err  error
}

// startCall runs Call in the background.
func startCall(a *Adapter, in scenario.AgentInput) <-chan callResult {
	ch := make(chan callResult, 1)
	go func() {
		ret, err := a.Call(context.Background(), in)
		ch <- callResult{msgs: ret.Messages(scenario.RoleAssistant), err: err}
	}()
	return ch
}

func await(t *testing.T, ch <-chan callResult) callResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(10 * time.Second):
		t.Fatal("call did not return")
		return callResult{}
	}
}

// stateWith feeds messages into a real scenario state, the consumer of
// HasToolCall / LastToolCall.
func stateWith(t *testing.T, msgs []scenario.Message) *scenario.ExecutionState {
	t.Helper()
	var st *scenario.ExecutionState
	noop := scenario.AgentFunc(func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) { return nil, nil })
	_, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "tool-call surfacing",
		Description: "tool-call surfacing",
		Agents:      []scenario.AgentAdapter{noop},
		Script: []scenario.ScriptStep{
			scenario.StepFunc(func(_ context.Context, ex *scenario.Executor) error {
				for _, m := range msgs {
					ex.AddMessage(m)
				}
				st = ex.State()
				return nil
			}),
			scenario.Succeed(),
		},
	}, scenario.WithQuiet())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return st
}

func byName(ss tracetest.SpanStubs) map[string]tracetest.SpanStub {
	out := map[string]tracetest.SpanStub{}
	for _, s := range ss {
		out[s.Name] = s
	}
	return out
}

func attr(s tracetest.SpanStub, key string) (any, bool) {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.AsInterface(), true
		}
	}
	return nil, false
}

func eventNames(s tracetest.SpanStub) []string {
	out := make([]string, len(s.Events))
	for i, e := range s.Events {
		out[i] = e.Name
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
