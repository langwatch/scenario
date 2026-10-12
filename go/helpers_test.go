package scenario

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Unsetenv("LANGWATCH_PROJECT_ID")
	os.Unsetenv("SCENARIO_SEND_GRANULAR_EVENTS")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	if os.Getenv("SCENARIO_TEST_FRESH_TRACING") == "" {
		installTestProvider()
	}
	os.Exit(m.Run())
}

// fakeLLM answers with a function of the request and records every request.
type fakeLLM struct {
	mu       sync.Mutex
	requests []InferenceParams
	answer   func(n int, p InferenceParams) (*InferenceResult, error)
}

func (f *fakeLLM) Inference(_ context.Context, p InferenceParams) (*InferenceResult, error) {
	f.mu.Lock()
	f.requests = append(f.requests, p)
	n := len(f.requests)
	f.mu.Unlock()
	return f.answer(n, p)
}

func (f *fakeLLM) calls() []InferenceParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]InferenceParams(nil), f.requests...)
}

func textAnswer(s string) *InferenceResult { return &InferenceResult{Message: AssistantMsg(s)} }

func toolAnswer(name, args string) *InferenceResult {
	return &InferenceResult{Message: Message{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "call_" + name, Name: name, Arguments: args}}}}
}

// finishArgs builds finish_test arguments with one status per criterion.
func finishArgs(criteria []string, statuses ...string) string {
	names := criteriaParamNames(criteria)
	answers := map[string]any{}
	for i, n := range names {
		answers[n] = map[string]any{"requirement": "req " + strconv.Itoa(i), "reasoning": "why " + strconv.Itoa(i), "status": statuses[i]}
	}
	b, _ := json.Marshal(map[string]any{"criteria": answers, "reasoning": "summary"})
	return string(b)
}

// hasTool reports whether the request offers the named tool.
func hasTool(p InferenceParams, name string) bool {
	for _, t := range p.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// echoAgent answers every turn with a fixed text and counts calls.
type echoAgent struct {
	text  string
	calls atomic.Int32
}

func (a *echoAgent) Role() AgentRole { return AgentRoleAgent }
func (a *echoAgent) Call(context.Context, AgentInput) (*AgentReturn, error) {
	a.calls.Add(1)
	return TextReturn(a.text), nil
}

// userSim returns a user simulator answering with fixed text.
func userSim(text string) (*UserSimulatorAgent, *fakeLLM) {
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return textAnswer(text), nil }}
	return NewUserSimulatorAgent(UserSimulatorAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "fake"}}), llm
}

// eventRecorder collects run events.
type eventRecorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *eventRecorder) record(ev Event) {
	r.mu.Lock()
	r.events = append(r.events, ev)
	r.mu.Unlock()
}

func (r *eventRecorder) all() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Event(nil), r.events...)
}

func (r *eventRecorder) types() []EventType {
	var out []EventType
	for _, e := range r.all() {
		out = append(out, e.Type)
	}
	return out
}

func decode(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatalf("invalid payload %s: %v", payload, err)
	}
	return m
}

// deterministic makes ids and timestamps deterministic for one test (not
// for parallel tests).
func deterministic(t *testing.T) {
	t.Helper()
	oldID, oldNow := newID, nowMillis
	var n atomic.Int64
	newID = func(prefix string) string { return prefix + strconv.FormatInt(n.Add(1), 10) }
	var ts atomic.Int64
	ts.Store(1700000000000)
	nowMillis = func() int64 { return ts.Load() }
	testIDCounter.Store(0)
	t.Cleanup(func() { newID, nowMillis = oldID, oldNow })
}
