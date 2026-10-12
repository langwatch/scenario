package evaluators

import (
	"context"
	"errors"
	"reflect"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func expressionOf(t *testing.T, m any) string {
	t.Helper()
	sm, ok := m.(StateMapping)
	if !ok {
		t.Fatalf("mapping %T is not a StateMapping", m)
	}
	return sm.Expression
}

func TestInferConversationInputs(t *testing.T) {
	m := InferMappings([]string{"input", "output", "contexts"}, nil, nil)
	if got := expressionOf(t, m["input"]); got != "state.firstUserMessage() || undefined" {
		t.Errorf("input %q", got)
	}
	if got := expressionOf(t, m["output"]); got != Conversation.LastAgentMessage.Expression {
		t.Errorf("output %q", got)
	}
	if got := expressionOf(t, m["contexts"]); got != "state.contexts" {
		t.Errorf("contexts %q", got)
	}
}

func TestInferExpectedLikeInputs(t *testing.T) {
	m := InferMappings([]string{"output", "expected_output", "expected_contexts"}, []string{"golden_sql", "table_schema"}, nil)
	if got := expressionOf(t, m["expected_output"]); got != Field("golden_sql").Expression {
		t.Errorf("expected_output %q", got)
	}
	if got := expressionOf(t, m["expected_contexts"]); got != `state.field("table_schema")` {
		t.Errorf("expected_contexts %q", got)
	}
}

func TestInferAmbiguousFieldStaysUnmapped(t *testing.T) {
	m := InferMappings([]string{"expected_output"}, []string{"golden_sql", "reference_sql"}, nil)
	if _, ok := m["expected_output"]; ok {
		t.Fatal("ambiguous input must stay unmapped")
	}
}

func TestInferSingleField(t *testing.T) {
	m := InferMappings([]string{"expected_answer"}, []string{"truth"}, nil)
	if got := expressionOf(t, m["expected_answer"]); got != `state.field("truth")` {
		t.Errorf("got %q", got)
	}
}

func TestInferKeepsExplicitMappings(t *testing.T) {
	explicit := func(s *scenario.ExecutionState) any { return nil }
	m := InferMappings([]string{"output", "language"}, nil, map[string]any{"output": explicit, "language": "en"})
	if reflect.ValueOf(m["output"]).Pointer() != reflect.ValueOf(explicit).Pointer() {
		t.Error("explicit function replaced")
	}
	if m["language"] != "en" {
		t.Error("explicit literal replaced")
	}
}

func TestIsExpectedLikeInput(t *testing.T) {
	for id, want := range map[string]bool{"expected_output": true, "golden_answer": true, "reference": true, "ground_truth": true, "output": false} {
		if IsExpectedLikeInput(id) != want {
			t.Errorf("%s: want %v", id, want)
		}
	}
}

func TestHelperExpressions(t *testing.T) {
	for got, want := range map[string]string{
		Conversation.FirstUserMessage.Expression:         "state.firstUserMessage() || undefined",
		Field("golden_sql").Expression:                   `state.field("golden_sql")`,
		Trace.ToolCalls("run_sql").Last.Input.Expression: `state.toolCalls("run_sql").last?.input`,
		Trace.Contexts.Expression:                        "state.contexts",
		Value("42").Expression:                           `"42"`,
		Value(3).Expression:                              "3",
	} {
		if got != want {
			t.Errorf("expression %q, want %q", got, want)
		}
	}
}

func TestResolveMappingFunctionsAndLiterals(t *testing.T) {
	withState(t, fixture{messages: messagesWithToolCall(), fields: map[string]scenario.FieldValue{"golden_sql": "SELECT 1"}}, func(ctx context.Context, ex *scenario.Executor) {
		state := ex.State()
		var seen *scenario.ExecutionState
		r := ResolveMapping(ctx, func(s *scenario.ExecutionState) any { seen = s; v, _ := s.Field("golden_sql"); return v }, state)
		if seen != state || r.Kind != ResolvedValue || r.Value != "SELECT 1" {
			t.Errorf("function mapping %+v", r)
		}
		for _, lit := range []any{"en", 3, false} {
			if r := ResolveMapping(ctx, lit, state); r.Kind != ResolvedValue || r.Value != lit {
				t.Errorf("literal %v: %+v", lit, r)
			}
		}
		r = ResolveMapping(ctx, scenario.MappingFunc(func(context.Context, *scenario.ExecutionState) (any, error) {
			return nil, errors.New("boom")
		}), state)
		if r.Kind != ResolvedError || r.Err.Error() != "boom" {
			t.Errorf("error mapping %+v", r)
		}
		r = ResolveMapping(ctx, func(*scenario.ExecutionState) any { panic("kaboom") }, state)
		if r.Kind != ResolvedError || r.Err.Error() != "kaboom" {
			t.Errorf("panicking mapping %+v", r)
		}
		if r := ResolveMapping(ctx, struct{}{}, state); r.Kind != ResolvedError {
			t.Errorf("unsupported mapping %+v", r)
		}
	})
}

func TestHelpersReadTheState(t *testing.T) {
	fx := fixture{
		messages: messagesWithToolCall(),
		fields:   map[string]scenario.FieldValue{"golden_sql": "SELECT 1"},
		criteria: []string{"Reports the count", "Names the quarter"},
	}
	withState(t, fx, func(ctx context.Context, ex *scenario.Executor) {
		s := ex.State()
		read := func(m StateMapping) any {
			v, err := m.Read(ctx, s)
			if err != nil {
				t.Fatal(err)
			}
			return v
		}
		if got := read(Conversation.FirstUserMessage); got != s.FirstUserMessage() {
			t.Errorf("first user %v", got)
		}
		if got := read(Conversation.LastAgentMessage); got != "There were 12 chargebacks." {
			t.Errorf("last agent %v", got)
		}
		if got := read(Conversation.Transcript); got != s.Transcript() {
			t.Errorf("transcript %v", got)
		}
		if got := read(Conversation.Messages).([]scenario.Message); len(got) != 4 {
			t.Errorf("messages %d", len(got))
		}
		if got := read(ScenarioSource.Situation); got != "A user asks about chargebacks" {
			t.Errorf("situation %v", got)
		}
		if got := read(ScenarioSource.Criteria); got != "Reports the count\nNames the quarter" {
			t.Errorf("criteria %q", got)
		}
		if got := read(Field("golden_sql")); got != "SELECT 1" {
			t.Errorf("field %v", got)
		}
		if got := stringify(read(Trace.ToolCalls("run_sql").Last.Input)); got != `{"sql":"`+sqlQuery+`"}` {
			t.Errorf("tool input %s", got)
		}
		if got := stringify(read(Trace.ToolCalls("run_sql").Last.Output)); got != `{"count":12}` {
			t.Errorf("tool output %s", got)
		}
		if got := read(Trace.ToolCalls("run_sql").Inputs).([]any); len(got) != 1 {
			t.Errorf("inputs %v", got)
		}
		if got := read(Value("x")); got != "x" {
			t.Errorf("value %v", got)
		}
	})
}

func TestToolCallPicksFirstAndLast(t *testing.T) {
	msgs := append(messagesWithToolCall(), scenario.Message{Role: scenario.RoleAssistant, TraceID: "trace-2",
		ToolCalls: []scenario.ToolCall{{ID: "call_2", Name: "run_sql", Arguments: `{"sql":"SELECT 2"}`}}})
	withState(t, fixture{messages: msgs}, func(ctx context.Context, ex *scenario.Executor) {
		last := ResolveMapping(ctx, Trace.ToolCalls("run_sql").Last.Input, ex.State())
		first := ResolveMapping(ctx, Trace.ToolCalls("run_sql").First.Input, ex.State())
		if stringify(last.Value) != `{"sql":"SELECT 2"}` || stringify(first.Value) != `{"sql":"`+sqlQuery+`"}` {
			t.Errorf("first %v last %v", first.Value, last.Value)
		}
	})
}

func TestToolCallFromSpan(t *testing.T) {
	fx := fixture{
		messages: []scenario.Message{{Role: scenario.RoleAssistant, Content: "Done.", TraceID: "trace-1"}},
		spans: []spanFixture{{name: "run_sql", attrs: map[string]string{
			"langwatch.span.type": "tool", "langwatch.input": `{"sql":"SELECT 1"}`, "langwatch.output": "[[1]]",
		}}},
	}
	withState(t, fx, func(ctx context.Context, ex *scenario.Executor) {
		in := ResolveMapping(ctx, Trace.ToolCalls("run_sql").Last.Input, ex.State())
		out := ResolveMapping(ctx, Trace.ToolCalls("run_sql").Last.Output, ex.State())
		if in.Value != `{"sql":"SELECT 1"}` || out.Value != "[[1]]" {
			t.Errorf("in %+v out %+v", in, out)
		}
	})
}

func TestResolveNothingReasons(t *testing.T) {
	fx := fixture{messages: []scenario.Message{{Role: scenario.RoleAssistant, Content: "Done.", TraceID: "trace-1"}}}
	withState(t, fx, func(ctx context.Context, ex *scenario.Executor) {
		s := ex.State()
		cases := []struct {
			name      string
			mapping   any
			reason    string
			readTrace bool
		}{
			{"nil", func(*scenario.ExecutionState) any { return nil }, "the mapping returned nothing", false},
			{"empty list", func(*scenario.ExecutionState) any { return []any{} }, "the mapping returned nothing", false},
			{"blank field", Field("golden_sql"), "no golden_sql on this scenario", false},
			{"blank field inline", func(s *scenario.ExecutionState) any { v, _ := s.Field("golden_sql"); return v }, "no golden_sql on this scenario", false},
			{"missing tool call", Trace.ToolCalls("run_sql").Last.Input, "no run_sql call in the trace", true},
			{"no contexts", Trace.Contexts, "no retrieved contexts in the trace", true},
			{"filtered spans", func(s *scenario.ExecutionState) any { _ = s.Spans(); return []any{} }, "the mapping returned nothing", true},
		}
		for _, c := range cases {
			r := ResolveMapping(ctx, c.mapping, s)
			if r.Kind != ResolvedNothing || r.Reason != c.reason || r.ReadTrace != c.readTrace {
				t.Errorf("%s: %+v", c.name, r)
			}
		}
	})
}

func TestIsNothing(t *testing.T) {
	var nilMap map[string]any
	var nilPtr *int
	for _, v := range []any{nil, []any{}, []string{}, []scenario.Message{}, nilMap, nilPtr} {
		if !IsNothing(v) {
			t.Errorf("%#v must be nothing", v)
		}
	}
	for _, v := range []any{"", 0, false, []any{1}, map[string]any{}} {
		if IsNothing(v) {
			t.Errorf("%#v must be a value", v)
		}
	}
}
