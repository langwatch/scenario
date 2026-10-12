package evaluators

import (
	"context"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	scenario "github.com/langwatch/scenario/go"
)

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Setenv("SCENARIO_HEADLESS", "1")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Unsetenv("LANGWATCH_PROJECT_ID")
	os.Exit(m.Run())
}

const sqlQuery = "SELECT count(*) FROM chargebacks"

var fields = map[string]scenario.FieldValue{
	"golden_sql":   "SELECT quarter, count(*) FROM chargebacks GROUP BY 1",
	"table_schema": "CREATE TABLE chargebacks (...)",
}

// messagesWithToolCall is a conversation where the agent called run_sql.
func messagesWithToolCall() []scenario.Message {
	return []scenario.Message{
		{Role: scenario.RoleUser, Content: "How many chargebacks last quarter?"},
		{Role: scenario.RoleAssistant, TraceID: "trace-1", ToolCalls: []scenario.ToolCall{{ID: "call_1", Name: "run_sql", Arguments: `{"sql":"` + sqlQuery + `"}`}}},
		{Role: scenario.RoleTool, TraceID: "trace-1", ToolCallID: "call_1", ToolName: "run_sql", Content: `{"count":12}`},
		{Role: scenario.RoleAssistant, TraceID: "trace-1", Content: "There were 12 chargebacks."},
	}
}

type fixture struct {
	messages []scenario.Message
	fields   map[string]scenario.FieldValue
	criteria []string
	spans    []spanFixture
}

type spanFixture struct {
	name  string
	attrs map[string]string
}

type nopAgent struct{}

func (nopAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }
func (nopAgent) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return nil, nil
}

type criteriaJudge struct{ criteria []string }

func (criteriaJudge) Role() scenario.AgentRole { return scenario.AgentRoleJudge }
func (criteriaJudge) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return nil, nil
}
func (j criteriaJudge) Criteria() []string { return j.criteria }

var threadSeq atomic.Int64

// addSpan adds an ended span of the thread to the default span collector.
func addSpan(threadID string, s spanFixture) {
	var sid trace.SpanID
	sid[7] = byte(threadSeq.Add(1))
	sid[0] = 0xee
	kvs := []attribute.KeyValue{attribute.String("langwatch.thread.id", threadID)}
	for k, v := range s.attrs {
		kvs = append(kvs, attribute.String(k, v))
	}
	scenario.DefaultSpanCollector().Add(tracetest.SpanStub{
		Name:        s.name,
		SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: sid}),
		StartTime:   time.Unix(1_700_000_000, 0),
		EndTime:     time.Unix(1_700_000_001, 0),
		Attributes:  kvs,
	}.Snapshot())
}

// withState runs fn inside a scenario step whose state holds the fixture.
func withState(t *testing.T, fx fixture, fn func(ctx context.Context, ex *scenario.Executor)) {
	t.Helper()
	thread := "thread-eval-" + strconv.FormatInt(threadSeq.Add(1), 10)
	cfg := scenario.ScenarioConfig{
		Name: "fixture", Description: "A user asks about chargebacks", ThreadID: thread,
		Fields: fx.fields,
		Agents: []scenario.AgentAdapter{nopAgent{}, criteriaJudge{criteria: fx.criteria}},
		Script: []scenario.ScriptStep{
			scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
				for _, m := range fx.messages {
					ex.AddMessage(m)
				}
				for _, s := range fx.spans {
					addSpan(thread, s)
				}
				fn(ctx, ex)
				return nil
			}),
			scenario.Succeed(),
		},
	}
	if _, err := scenario.Run(context.Background(), cfg, scenario.WithQuiet()); err != nil {
		t.Fatal(err)
	}
}

// fakeAPI answers spec lookups from a table and evaluate calls with a fixed
// response or error.
type fakeAPI struct {
	specs    map[string]*EvaluatorSpec
	response *EvaluateResponse
	err      error

	mu    sync.Mutex
	calls []EvaluateRequest
}

func (f *fakeAPI) EvaluatorSpec(_ context.Context, ref string) (*EvaluatorSpec, error) {
	return f.specs[ref], nil
}

func (f *fakeAPI) Evaluate(_ context.Context, req EvaluateRequest) (*EvaluateResponse, error) {
	f.mu.Lock()
	f.calls = append(f.calls, req)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	if f.response != nil {
		return f.response, nil
	}
	return &EvaluateResponse{Status: "processed", Passed: ptr(true), Details: ptr("ok")}, nil
}

func (f *fakeAPI) evaluateCalls() []EvaluateRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]EvaluateRequest(nil), f.calls...)
}

func ptr[T any](v T) *T { return &v }

var sqlEquivalence = &EvaluatorSpec{
	EvaluatorID: "ragas/sql_query_equivalence",
	Name:        "SQL Query Equivalence",
	Inputs: []Input{
		{ID: "output", Required: true},
		{ID: "expected_output", Required: true},
		{ID: "expected_contexts", Required: true},
	},
	ProducesPassed: true,
}

var scoreJudge = &EvaluatorSpec{
	EvaluatorID: "eval_123",
	Name:        "Answer quality",
	Inputs:      []Input{{ID: "input"}, {ID: "output"}},
}
