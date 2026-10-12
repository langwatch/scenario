package scenario

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/instrumentation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// recordSpans registers an in-memory exporter on the test provider.
func recordSpans(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := otel.GetTracerProvider().(*sdktrace.TracerProvider)
	sp := sdktrace.NewSimpleSpanProcessor(exp)
	tp.RegisterSpanProcessor(sp)
	t.Cleanup(func() { tp.UnregisterSpanProcessor(sp) })
	return exp
}

// exportedSpansOfTrace returns the exported spans of one trace.
func exportedSpansOfTrace(exp *tracetest.InMemoryExporter, id trace.TraceID) []tracetest.SpanStub {
	var out []tracetest.SpanStub
	for _, s := range exp.GetSpans() {
		if s.SpanContext.TraceID() == id {
			out = append(out, s)
		}
	}
	return out
}

func TestTraceInferenceRecordsAnLLMSpan(t *testing.T) {
	exp := recordSpans(t)
	ctx, parent := otel.Tracer("test").Start(context.Background(), "parent")
	temp, maxTokens := 0.2, int64(64)
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		return &InferenceResult{Message: Message{Content: "hello"}, Usage: &Usage{InputTokens: 12, OutputTokens: 3}}, nil
	}}
	_, err := TraceInference(ctx, llm, InferenceParams{
		Model:       "gpt-test",
		Messages:    []Message{SystemMsg("be brief"), UserMsg("hi")},
		Temperature: &temp,
		MaxTokens:   &maxTokens,
		Tools:       []ToolDefinition{{Name: "finish_test", Description: "end", Parameters: map[string]any{"type": "object"}}},
		ToolChoice:  RequireTool("finish_test"),
	})
	parent.End()
	if err != nil {
		t.Fatal(err)
	}
	var span tracetest.SpanStub
	for _, s := range exportedSpansOfTrace(exp, parent.SpanContext().TraceID()) {
		if s.Name == "chat.gpt-test" {
			span = s
		}
	}
	if span.Parent.SpanID() != parent.SpanContext().SpanID() {
		t.Fatalf("the model-call span is a child of the caller's span: %+v", span)
	}
	want := map[string]string{
		"langwatch.span.type":        "llm",
		"gen_ai.operation.name":      "chat",
		"gen_ai.request.model":       "gpt-test",
		"gen_ai.request.temperature": "0.2",
		"gen_ai.request.max_tokens":  "64",
		"gen_ai.usage.input_tokens":  "12",
		"gen_ai.usage.output_tokens": "3",
		"gen_ai.request.tools":       `[{"type":"function","name":"finish_test","description":"end","parameters":{"type":"object"}}]`,
		"gen_ai.request.tool_choice": `{"type":"tool","toolName":"finish_test"}`,
		"langwatch.input":            `{"type":"chat_messages","value":[{"role":"system","content":"be brief"},{"role":"user","content":"hi"}]}`,
		"langwatch.output":           `{"type":"chat_messages","value":[{"role":"assistant","content":"hello"}]}`,
	}
	for k, v := range want {
		if got := attr(span, k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if attr(span, attrScenarioRole) != "" {
		t.Error("TraceInference records no scenario role")
	}
	if span.InstrumentationScope.Name != TracerName {
		t.Errorf("scope %q", span.InstrumentationScope.Name)
	}
}

func TestTraceInferenceRecordsErrors(t *testing.T) {
	exp := recordSpans(t)
	ctx, parent := otel.Tracer("test").Start(context.Background(), "parent")
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return nil, errors.New("rate limited") }}
	_, err := TraceInference(ctx, llm, InferenceParams{Model: "m", Messages: []Message{UserMsg("hi")}})
	parent.End()
	if err == nil {
		t.Fatal("expected the model error")
	}
	for _, s := range exportedSpansOfTrace(exp, parent.SpanContext().TraceID()) {
		if s.Name == "chat.m" {
			if s.Status.Code != codes.Error || s.Status.Description != "rate limited" || attr(s, "langwatch.output") != "" {
				t.Fatalf("error span %+v", s)
			}
			return
		}
	}
	t.Fatal("no model-call span")
}

func TestTraceInferenceDoesNoWorkWhenNotRecording(t *testing.T) {
	exp := recordSpans(t)
	tid := trace.TraceID{0xab, 0xcd}
	// A remote parent that was not sampled: the parent-based sampler drops
	// every child.
	ctx := trace.ContextWithRemoteSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: tid, SpanID: trace.SpanID{1}, Remote: true,
	}))
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return textAnswer("ok"), nil }}
	res, err := TraceInference(ctx, llm, InferenceParams{Model: "m", Messages: []Message{UserMsg("hi")}})
	if err != nil || res.Message.Text() != "ok" || len(llm.calls()) != 1 {
		t.Fatalf("the model is still called: %+v %v", res, err)
	}
	if n := len(exportedSpansOfTrace(exp, tid)); n != 0 {
		t.Fatalf("a dropped trace records nothing, got %d spans", n)
	}
}

func TestTraceInferenceWithoutModel(t *testing.T) {
	if _, err := TraceInference(context.Background(), nil, InferenceParams{}); !errors.Is(err, ErrNoModel) {
		t.Fatalf("got %v", err)
	}
}

func TestBuiltInAgentsRecordModelCalls(t *testing.T) {
	exp := recordSpans(t)
	criteria := []string{"greets"}
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	sim, _ := userSim("q")
	cfg := baseConfig(&echoAgent{text: "a"}, sim, judgeWith(llm, criteria...))
	cfg.ThreadID = "scenariothread_llm_spans"
	cfg.Script = []ScriptStep{User(), Agent(), Judge()}
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	var run trace.TraceID
	for _, s := range exp.GetSpans() {
		if s.Name == "Scenario Run" && attr(s, "langwatch.thread.id") == cfg.ThreadID {
			run = s.SpanContext.TraceID()
		}
	}
	byName := map[string]tracetest.SpanStub{}
	parents := map[trace.SpanID]tracetest.SpanStub{}
	for _, s := range exportedSpansOfTrace(exp, run) {
		byName[s.Name] = s
		parents[s.SpanContext.SpanID()] = s
	}
	judgeCall, simCall := byName["chat.judge-model"], byName["chat.fake"]
	if parents[judgeCall.Parent.SpanID()].Name != "JudgeAgent.call" || attr(judgeCall, attrScenarioRole) != "Judge" {
		t.Errorf("judge model call %+v", judgeCall)
	}
	if parents[simCall.Parent.SpanID()].Name != "UserSimulatorAgent.call" || attr(simCall, attrScenarioRole) != "User" {
		t.Errorf("user simulator model call %+v", simCall)
	}
	if !strings.Contains(attr(judgeCall, "langwatch.input"), "<criteria>") {
		t.Errorf("judge input %s", attr(judgeCall, "langwatch.input"))
	}
}

func TestJudgeLeavesItsOwnModelCallsOutOfTheTrace(t *testing.T) {
	criteria := []string{"Agent greets the user"}
	var verdictContent string
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if hasTool(p, "make_verdict") {
			return toolAnswer("make_verdict", "{}"), nil
		}
		verdictContent = p.Messages[1].Content
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	res, err := runProceed(t, ScenarioConfig{MaxTurns: 3, Agents: []AgentAdapter{judgeWith(llm, criteria...)}})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	if strings.Contains(verdictContent, "chat.judge-model") {
		t.Errorf("the verdict phase must not see the decision phase's model call:\n%s", verdictContent)
	}
	if !strings.Contains(verdictContent, "chat.fake") {
		t.Errorf("the user simulator's model calls stay in the trace, as in JS:\n%s", verdictContent)
	}
}

func TestWithoutJudgeModelCallsDropsNestedSpans(t *testing.T) {
	tid := trace.TraceID{7}
	sc := func(id byte) trace.SpanContext {
		return trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: trace.SpanID{id}})
	}
	scope := instrumentation.Scope{Name: TracerName}
	now := time.Now()
	stubs := tracetest.SpanStubs{
		{Name: "JudgeAgent.call", SpanContext: sc(1), StartTime: now, EndTime: now, InstrumentationScope: scope,
			Attributes: []attribute.KeyValue{attribute.String("langwatch.span.type", "agent"), attribute.String(attrScenarioRole, "Judge")}},
		{Name: "chat.judge", SpanContext: sc(2), Parent: sc(1), StartTime: now, EndTime: now, InstrumentationScope: scope,
			Attributes: []attribute.KeyValue{attribute.String("langwatch.span.type", "llm"), attribute.String(attrScenarioRole, "Judge")}},
		{Name: "openai.completions", SpanContext: sc(3), Parent: sc(2), StartTime: now, EndTime: now},
		{Name: "chat.fake", SpanContext: sc(4), Parent: sc(5), StartTime: now, EndTime: now, InstrumentationScope: scope,
			Attributes: []attribute.KeyValue{attribute.String("langwatch.span.type", "llm"), attribute.String(attrScenarioRole, "User")}},
		{Name: "elsewhere", SpanContext: sc(6), StartTime: now, EndTime: now, InstrumentationScope: instrumentation.Scope{Name: "other"},
			Attributes: []attribute.KeyValue{attribute.String("langwatch.span.type", "llm"), attribute.String(attrScenarioRole, "Judge")}},
	}.Snapshots()
	var names []string
	for _, s := range withoutJudgeModelCalls(stubs) {
		names = append(names, s.Name())
	}
	if strings.Join(names, ",") != "JudgeAgent.call,chat.fake,elsewhere" {
		t.Fatalf("kept %v", names)
	}
	untouched := tracetest.SpanStubs{{Name: "a", SpanContext: sc(9)}}.Snapshots()
	if got := withoutJudgeModelCalls(untouched); len(got) != 1 {
		t.Fatal("spans without judge calls pass through")
	}
}
