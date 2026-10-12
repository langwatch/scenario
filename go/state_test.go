package scenario

import (
	"context"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

// toolSpanAgent calls a tool both in its messages and as an OTel span, and
// a second tool only as a span.
var toolSpanAgent = AgentFunc(func(ctx context.Context, in AgentInput) (*AgentReturn, error) {
	tracer := otel.Tracer("test-agent")
	_, s := tracer.Start(ctx, "search")
	s.SetAttributes(
		attribute.String("langwatch.span.type", "tool"), attribute.String("gen_ai.tool.name", "search"),
		attribute.String("langwatch.input", `{"q": "paris"}`), attribute.String("langwatch.output", "3 hits"),
	)
	s.End()
	_, r := tracer.Start(ctx, "retrieve")
	r.SetAttributes(
		attribute.String("langwatch.span.type", "tool"),
		attribute.String("langwatch.rag.contexts", `[{"document_id":"d1","content":"Paris is in France"},"plain chunk"]`),
	)
	r.End()
	return MessagesReturn(
		Message{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "search", Arguments: `{"q":"paris"}`}}},
		Message{Role: RoleTool, ToolCallID: "c1", Content: "results"},
		AssistantMsg("done"),
	), nil
})

func TestStateViews(t *testing.T) {
	t.Parallel()
	sim, _ := userSim("x")
	var views struct {
		all, search ToolCalls
		contexts    []string
		turns       []TurnView
		traces      []TraceView
		transcript  string
		first       string
		last        Message
		hasTool     bool
		criteria    []string
		field       FieldValue
		blank       bool
		reads       StateReads
	}
	check := StepFunc(func(_ context.Context, ex *Executor) error {
		st := ex.State()
		st.StartReadTracking()
		views.all = st.ToolCalls()
		views.search = st.ToolCalls("search")
		_ = st.ToolCalls("missing_tool")
		views.contexts = st.Contexts()
		views.turns = st.Turns()
		views.traces = st.Traces()
		views.transcript = st.Transcript()
		views.first = st.FirstUserMessage()
		views.last, _ = st.LastToolCall("search")
		views.hasTool = st.HasToolCall("search")
		views.criteria = st.Criteria()
		views.field, _ = st.Field("golden")
		_, ok := st.Field("empty")
		views.blank = !ok
		views.reads = st.TakeReads()
		return nil
	})
	cfg := baseConfig(toolSpanAgent, sim, NewJudgeAgent(JudgeAgentConfig{Criteria: []string{"c1", "c2"}}))
	cfg.Fields = map[string]FieldValue{"golden": "select 1", "empty": ""}
	cfg.Script = []ScriptStep{User("find paris"), Agent(), check, Succeed()}
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if len(views.search) != 1 || views.search[0].Source != ToolCallFromMessage || views.search[0].Output != "results" {
		t.Fatalf("search calls %+v", views.search)
	}
	if in, _ := views.search[0].Input.(map[string]any); in["q"] != "paris" {
		t.Errorf("input %+v", views.search[0].Input)
	}
	if len(views.all) != 2 || views.all[1].Name != "retrieve" || views.all[1].Source != ToolCallFromSpan {
		t.Errorf("all calls %+v", views.all)
	}
	if !slices.Equal(views.contexts, []string{"Paris is in France", "plain chunk"}) {
		t.Errorf("contexts %v", views.contexts)
	}
	if len(views.turns) != 1 || len(views.turns[0].Messages) != 4 || len(views.traces) != 1 {
		t.Errorf("turns %d traces %d", len(views.turns), len(views.traces))
	}
	if tv, ok := views.turns[0].Trace(); !ok || len(tv.Spans()) == 0 || len(tv.ToolCalls("search")) != 1 {
		t.Errorf("turn trace view")
	}
	if !strings.Contains(views.transcript, `assistant: {"type":"tool-call","toolCallId":"c1","toolName":"search","input":{"q":"paris"}}`) {
		t.Errorf("transcript %q", views.transcript)
	}
	if views.first != "find paris" || views.last.ToolCallID != "c1" || !views.hasTool {
		t.Errorf("accessors %q %+v", views.first, views.last)
	}
	if !slices.Equal(views.criteria, []string{"c1", "c2"}) || views.field != "select 1" || !views.blank {
		t.Errorf("criteria/fields")
	}
	if !views.reads.Trace || !slices.Equal(views.reads.MissingToolCalls, []string{"missing_tool"}) || !slices.Equal(views.reads.BlankFields, []string{"empty"}) {
		t.Errorf("reads %+v", views.reads)
	}
}

func TestRollbackCleansPendingQueues(t *testing.T) {
	t.Parallel()
	var newMsgs []Message
	calls := 0
	agent := AgentFunc(func(_ context.Context, in AgentInput) (*AgentReturn, error) {
		calls++
		if calls == 1 {
			removed, _ := in.ScenarioState.RollbackMessagesTo(1)
			if len(removed) != 1 {
				panic("expected one removed message")
			}
			return TextReturn("first"), nil
		}
		newMsgs = in.NewMessages
		return TextReturn("second"), nil
	})
	sim, _ := userSim("x")
	cfg := baseConfig(agent, sim)
	cfg.Script = []ScriptStep{User("a"), User("b"), Agent(), User("c"), Agent(), Succeed()}
	res, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, m := range res.Messages {
		texts = append(texts, m.Content)
	}
	if !slices.Equal(texts, []string{"a", "first", "c", "second"}) {
		t.Fatalf("messages %v", texts)
	}
	for _, m := range newMsgs {
		if m.Content == "b" {
			t.Fatal("a rolled back message must leave the pending queues")
		}
	}
	if _, err := newExecutionState(ScenarioConfig{}).RollbackMessagesTo(-1); err == nil {
		t.Fatal("negative index must fail")
	}
}
