package scenario

import (
	"context"
	"fmt"
	"testing"

	langwatch "github.com/langwatch/langwatch/sdks/go"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func benchMessages(n int) []Message {
	msgs := make([]Message, 0, n)
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			msgs = append(msgs, UserMsg(fmt.Sprintf("user message number %d with some text", i)))
		} else {
			msgs = append(msgs, AssistantMsg(fmt.Sprintf("assistant reply number %d with some longer text in it", i)))
		}
	}
	return msgs
}

// BenchmarkAGUIConvert20 converts 20 messages to AG-UI from scratch.
func BenchmarkAGUIConvert20(b *testing.B) {
	msgs := benchMessages(20)
	for i := range msgs {
		msgs[i].ID = generateMessageID()
	}
	b.ReportAllocs()
	for b.Loop() {
		for _, m := range msgs {
			_ = aguiRowOf(m)
		}
	}
}

// BenchmarkEventEncodeSnapshot20 builds one MESSAGE_SNAPSHOT body of a
// 20-message conversation, as the executor does after every message (the
// per-message AG-UI JSON is cached, so only the envelope is new).
func BenchmarkEventEncodeSnapshot20(b *testing.B) {
	st := newExecutionState(ScenarioConfig{MaxTurns: 10})
	for _, m := range benchMessages(20) {
		st.add(m, "")
	}
	base := eventBase{batchRunID: "b", scenarioID: "i", scenarioRunID: "r", scenarioSetID: "s"}
	b.ReportAllocs()
	for b.Loop() {
		_ = base.snapshotPayload(1700000000000, st.aguiRowsJSON())
	}
}

// benchRun10Turns runs a full scenario with a fake LLM: user simulator, echo
// agent and a judge that continues nine times and then decides, like the
// baseline benchmark of the previous implementation.
func benchRun10Turns(b *testing.B, verdict string, criteria []string) {
	judgeCalls := 0
	llm := &fakeLLM{answer: func(_ int, p InferenceParams) (*InferenceResult, error) {
		if len(p.Tools) == 0 {
			return textAnswer("hello there agent"), nil
		}
		judgeCalls++
		switch {
		case hasTool(p, "finish_test"):
			return toolAnswer("finish_test", verdict), nil
		case judgeCalls >= 10:
			return toolAnswer("make_verdict", "{}"), nil
		}
		return toolAnswer("continue_test", "{}"), nil
	}}
	res, err := Run(context.Background(), ScenarioConfig{
		Name: "bench", Description: "bench", MaxTurns: 20,
		Agents: []AgentAdapter{
			&echoAgent{text: "echo reply from the agent under test"},
			NewUserSimulatorAgent(UserSimulatorAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "m"}}),
			NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "m"}, Criteria: criteria}),
		},
	})
	if err != nil || !res.Success {
		b.Fatalf("bad run %v %+v", err, res)
	}
}

// BenchmarkScenarioRun10Turns runs one full 10-turn scenario per iteration.
func BenchmarkScenarioRun10Turns(b *testing.B) {
	criteria := []string{"agent responds"}
	verdict := finishArgs(criteria, "passed")
	b.ReportAllocs()
	for b.Loop() {
		benchRun10Turns(b, verdict, criteria)
	}
}

// BenchmarkScenarioRun10TurnsParallel runs many full scenarios at once, to
// surface contention on shared state (span collector, event bus, ids).
func BenchmarkScenarioRun10TurnsParallel(b *testing.B) {
	criteria := []string{"agent responds"}
	verdict := finishArgs(criteria, "passed")
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			benchRun10Turns(b, verdict, criteria)
		}
	})
}

// benchSpanProvider is a recording provider with no processors, so span
// benchmarks measure the start itself.
func benchSpanProvider(b *testing.B) *sdktrace.TracerProvider {
	tp := sdktrace.NewTracerProvider()
	b.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return tp
}

// BenchmarkAgentSpanStartLangWatchTracer starts an agent call span the way
// the executor did before: on langwatch.Tracer, type and input set after.
func BenchmarkAgentSpanStartLangWatchTracer(b *testing.B) {
	tr := langwatch.TracerFromProvider(benchSpanProvider(b), TracerName, trace.WithInstrumentationVersion(Version))
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		_, s := tr.Start(ctx, "echoAgent.call", trace.WithAttributes(
			attribute.String(threadIDKey, "thread"),
			attribute.String("scenario.role", string(AgentRoleAgent)),
		))
		s.SetType(langwatch.SpanTypeAgent)
		s.SetAttributes(langwatch.AttributeLangWatchInput.String("input"))
		s.End()
	}
}

// BenchmarkAgentSpanStartSpanStarter starts the same span with the whole
// attribute list at start, as the executor does now.
func BenchmarkAgentSpanStartSpanStarter(b *testing.B) {
	st := spanStarter{tracer: benchSpanProvider(b).Tracer(TracerName, trace.WithInstrumentationVersion(Version))}
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		_, s := st.start(ctx, "echoAgent.call", agentSpanAttributes("thread", AgentRoleAgent, "input", true))
		s.End()
	}
}

// BenchmarkEncodeModelMessage20 encodes 20 messages' model JSON in presized
// buffers, as the span input and output do.
func BenchmarkEncodeModelMessage20(b *testing.B) {
	msgs := benchMessages(20)
	b.ReportAllocs()
	for b.Loop() {
		for _, m := range msgs {
			_ = encodeModelMessage(m)
		}
	}
}

// BenchmarkEncodeModelMessage20Unsized is the previous encoding, growing
// from a nil buffer, for comparison.
func BenchmarkEncodeModelMessage20Unsized(b *testing.B) {
	msgs := benchMessages(20)
	b.ReportAllocs()
	for b.Loop() {
		for _, m := range msgs {
			_ = appendModelMessage(nil, m)
		}
	}
}

// BenchmarkEmitterSnapshot20 posts one MESSAGE_SNAPSHOT of a 20-message
// conversation through the emitter, rows built under the state lock.
func BenchmarkEmitterSnapshot20(b *testing.B) {
	st := newExecutionState(ScenarioConfig{MaxTurns: 10})
	for _, m := range benchMessages(20) {
		st.add(m, "")
	}
	e := &eventEmitter{
		base:    eventBase{batchRunID: "b", scenarioID: "i", scenarioRunID: "r", scenarioSetID: "s"},
		publish: func(Event) {},
		state:   st,
	}
	b.ReportAllocs()
	for b.Loop() {
		e.rolledBack()
	}
}

// BenchmarkAgentHistoryCopy40 is the per-call history copy user agents get.
func BenchmarkAgentHistoryCopy40(b *testing.B) {
	st := newExecutionState(ScenarioConfig{MaxTurns: 20})
	for _, m := range benchMessages(40) {
		st.add(m, "")
	}
	b.ReportAllocs()
	for b.Loop() {
		_ = st.Messages()
	}
}

// BenchmarkAgentHistoryView40 is the view the built-in agents get.
func BenchmarkAgentHistoryView40(b *testing.B) {
	st := newExecutionState(ScenarioConfig{MaxTurns: 20})
	for _, m := range benchMessages(40) {
		st.add(m, "")
	}
	b.ReportAllocs()
	for b.Loop() {
		_ = st.messagesView()
	}
}

// BenchmarkEmptyObjectSchema is the per-call schema of the argument-free
// judge tools.
func BenchmarkEmptyObjectSchema(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		_ = emptyObjectSchema()
	}
}
