package scenario

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func attr(s tracetest.SpanStub, key string) string {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

func TestRunSpanHierarchy(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	tp := otel.GetTracerProvider().(*sdktrace.TracerProvider)
	tp.RegisterSpanProcessor(sdktrace.NewSimpleSpanProcessor(exp))

	criteria := []string{"greets"}
	var judgeContent string
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		judgeContent = p.Messages[1].Content
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	sim, _ := userSim("q")
	cfg := baseConfig(&echoAgent{text: "a"}, sim, judgeWith(llm, criteria...))
	cfg.ThreadID = "scenariothread_spans"
	cfg.Script = []ScriptStep{User(), Agent(), Judge()}
	res, err := Run(context.Background(), cfg)
	if err != nil || !res.Success {
		t.Fatal(err)
	}
	if !strings.Contains(judgeContent, "echoAgent.call") || !strings.Contains(judgeContent, "UserSimulatorAgent.call") {
		t.Errorf("the judge digest must include the agent spans:\n%s", judgeContent)
	}

	var run, turn tracetest.SpanStub
	agents := map[string]tracetest.SpanStub{}
	for _, s := range exp.GetSpans() {
		if attr(s, "langwatch.thread.id") != cfg.ThreadID && attr(s, "scenario.run_id") == "" {
			continue
		}
		switch {
		case s.Name == "Scenario Run" && attr(s, "langwatch.thread.id") == cfg.ThreadID:
			run = s
		case s.Name == "Scenario Turn" && attr(s, "langwatch.thread.id") == cfg.ThreadID && attr(s, "scenario.turn") == "1":
			turn = s
		case strings.HasSuffix(s.Name, ".call") && attr(s, "langwatch.thread.id") == cfg.ThreadID:
			agents[s.Name] = s
		}
	}
	if attr(run, "langwatch.origin") != "simulation" || attr(run, AttrSDKName) != SDKName || attr(run, AttrSDKVersion) != Version || attr(run, "scenario.run_id") != res.RunID {
		t.Fatalf("run span attributes %v", run.Attributes)
	}
	if turn.Parent.SpanID() != run.SpanContext.SpanID() || turn.SpanContext.TraceID() != run.SpanContext.TraceID() {
		t.Fatal("turn spans are children of the run span, in one trace")
	}
	a := agents["echoAgent.call"]
	if a.Parent.SpanID() != turn.SpanContext.SpanID() || attr(a, "scenario.role") != "Agent" || attr(a, "langwatch.span.type") != "agent" {
		t.Fatalf("agent span %+v", a.Attributes)
	}
	if !strings.HasPrefix(attr(a, "langwatch.input"), `{"type":"chat_messages","value":[{"role":"user","content":"q"}]}`) {
		t.Errorf("agent span input %s", attr(a, "langwatch.input"))
	}
	if res.Messages[1].TraceID != a.SpanContext.TraceID().String() {
		t.Error("messages carry the trace id of their agent call")
	}
	if len(DefaultSpanCollector().SpansForThread(cfg.ThreadID)) != 0 {
		t.Error("the collector releases the thread after the run")
	}
}

func TestSetupScenarioTracingAttachesOnceToExistingProvider(t *testing.T) {
	before := otel.GetTracerProvider()
	if err := SetupScenarioTracing(TracingOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := SetupScenarioTracing(TracingOptions{}); err != nil {
		t.Fatal(err)
	}
	st := ensureTracing()
	if st.owned || otel.GetTracerProvider() != before || st.provider != before {
		t.Fatal("an existing SDK provider must be attached to, never replaced")
	}
}

// TestFreshProcessTracing runs the helper below in a process without a
// global provider.
func TestFreshProcessTracing(t *testing.T) {
	if os.Getenv("SCENARIO_TEST_FRESH_TRACING") != "" {
		t.Skip("helper process")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestFreshTracingHelper$", "-test.v")
	cmd.Env = append(os.Environ(), "SCENARIO_TEST_FRESH_TRACING=1")
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "--- PASS: TestFreshTracingHelper") {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
}

func TestFreshTracingHelper(t *testing.T) {
	if os.Getenv("SCENARIO_TEST_FRESH_TRACING") == "" {
		t.Skip("only runs in the helper process")
	}
	if err := SetupScenarioTracing(TracingOptions{}); err != nil {
		t.Fatal(err)
	}
	installed, ok := otel.GetTracerProvider().(*sdktrace.TracerProvider)
	if !ok || !ensureTracing().owned {
		t.Fatal("expected the SDK to install a provider")
	}
	sim, _ := userSim("q")
	cfg := baseConfig(&echoAgent{text: "a"}, sim)
	cfg.Script = []ScriptStep{User(), Agent(), Succeed()}
	for i := 0; i < 3; i++ {
		if _, err := Run(context.Background(), cfg); err != nil {
			t.Fatal(err)
		}
	}
	if otel.GetTracerProvider() != installed {
		t.Fatal("runs must not replace the provider")
	}
	// The provider is still usable: it was never shut down.
	_, s := installed.Tracer("x").Start(context.Background(), "after")
	if !s.SpanContext().IsValid() {
		t.Fatal("provider was shut down")
	}
	s.End()
}

func TestTraceIDFromHeaders(t *testing.T) {
	if got := TraceIDFromHeaders(map[string]string{"traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}); got != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatal(got)
	}
	if TraceIDFromHeaders(nil) != "" || TraceIDFromHeaders(map[string]string{"traceparent": "bad"}) != "" {
		t.Fatal("invalid headers")
	}
}

func TestSyntheticErrorSpanJoinsThread(t *testing.T) {
	c := NewSpanCollector()
	tid := [16]byte{1}
	c.Add(NewSyntheticErrorSpan(tid, "thread-x", "no agent spans arrived"))
	spans := c.SpansForThread("thread-x")
	if len(spans) != 1 || spans[0].Name() != SpanCollectionErrorName || spans[0].Status().Description != "no agent spans arrived" {
		t.Fatalf("%+v", spans)
	}
	c.ClearThread("thread-x")
	if len(c.SpansForThread("thread-x")) != 0 {
		t.Fatal("clear")
	}
}
