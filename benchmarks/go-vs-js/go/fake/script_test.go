package fake

import (
	"context"
	"encoding/json"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func offers(names ...string) func(string) bool {
	return func(n string) bool {
		for _, x := range names {
			if x == n {
				return true
			}
		}
		return false
	}
}

func TestDecideFollowsTheScript(t *testing.T) {
	cases := []struct {
		name     string
		tools    []string
		lastTool bool
		want     Reply
	}{
		{"user simulator", nil, false, Reply{Text: UserText}},
		{"agent first call", []string{OrderTool}, false, Reply{ToolName: OrderTool, ToolArgs: OrderArgs}},
		{"agent after the tool result", []string{OrderTool}, true, Reply{Text: AgentText}},
		{"judge decision", []string{"continue_test", "make_verdict"}, false, Reply{ToolName: "continue_test", ToolArgs: "{}"}},
		{"judge verdict", []string{"finish_test"}, false, Reply{ToolName: "finish_test", ToolArgs: FinishArgs}},
	}
	for _, c := range cases {
		if got := Decide(offers(c.tools...), c.lastTool); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestFinishArgsNameTheCriterion(t *testing.T) {
	var v struct {
		Criteria map[string]struct{ Requirement, Reasoning, Status string }
	}
	if err := json.Unmarshal([]byte(FinishArgs), &v); err != nil {
		t.Fatal(err)
	}
	if c, ok := v.Criteria[CriterionKey]; !ok || c.Status != "passed" {
		t.Fatalf("finish_test args do not pass %q: %+v", CriterionKey, v.Criteria)
	}
}

func TestLLMNumbersToolCalls(t *testing.T) {
	llm := NewLLM()
	p := scenario.InferenceParams{Tools: []scenario.ToolDefinition{{Name: OrderTool}}}
	r1, _ := llm.Inference(context.Background(), p)
	r2, _ := llm.Inference(context.Background(), p)
	if r1.Message.ToolCalls[0].ID != "call_1" || r2.Message.ToolCalls[0].ID != "call_2" {
		t.Fatalf("ids %q %q", r1.Message.ToolCalls[0].ID, r2.Message.ToolCalls[0].ID)
	}
}

func TestAgentReturnsCallResultAndAnswer(t *testing.T) {
	a := &Agent{LLM: NewLLM()}
	ret, err := a.Call(context.Background(), scenario.AgentInput{Messages: []scenario.Message{scenario.UserMsg(UserText)}})
	if err != nil {
		t.Fatal(err)
	}
	if ret == nil {
		t.Fatal("nil return")
	}
}
