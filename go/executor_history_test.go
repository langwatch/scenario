package scenario

import (
	"context"
	"slices"
	"testing"
)

// TestOnlyBuiltinAgentsReadTheHistoryView: the built-in agents get a view
// of the stored conversation; every other agent, including one embedding a
// built-in agent with its own Call, gets a copy.
func TestOnlyBuiltinAgentsReadTheHistoryView(t *testing.T) {
	t.Parallel()
	type wrapped struct{ *JudgeAgent }
	cases := []struct {
		agent AgentAdapter
		view  bool
	}{
		{NewJudgeAgent(JudgeAgentConfig{}), true},
		{NewUserSimulatorAgent(UserSimulatorAgentConfig{}), true},
		{wrapped{NewJudgeAgent(JudgeAgentConfig{})}, false},
		{&echoAgent{}, false},
		{AgentFunc(nil), false},
	}
	for _, c := range cases {
		if got := readsHistoryOnly(c.agent); got != c.view {
			t.Errorf("%T: view %v, want %v", c.agent, got, c.view)
		}
	}
}

// TestUserAgentsGetTheirOwnHistoryCopy: an agent that is not a built-in one
// may modify AgentInput.Messages and append to it and to NewMessages
// without changing the conversation or the queued messages.
func TestUserAgentsGetTheirOwnHistoryCopy(t *testing.T) {
	t.Parallel()
	calls := 0
	agent := AgentFunc(func(_ context.Context, in AgentInput) (*AgentReturn, error) {
		calls++
		if cap(in.NewMessages) != len(in.NewMessages) {
			t.Errorf("NewMessages must be clipped: len %d cap %d", len(in.NewMessages), cap(in.NewMessages))
		}
		for i := range in.Messages {
			in.Messages[i].Content = "mutated"
		}
		_ = append(in.Messages, UserMsg("appended"))
		_ = append(in.NewMessages, UserMsg("appended"))
		return TextReturn("reply"), nil
	})
	sim, _ := userSim("x")
	cfg := baseConfig(agent, sim)
	cfg.Script = []ScriptStep{User("a"), Agent(), User("b"), Agent(), Succeed()}
	res, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, m := range res.Messages {
		texts = append(texts, m.Content)
	}
	if !slices.Equal(texts, []string{"a", "reply", "b", "reply"}) {
		t.Fatalf("messages %v", texts)
	}
}

// TestMessagesViewSurvivesRollbackAndAppends: a view keeps showing the
// conversation it was taken from while the state appends and rolls back.
func TestMessagesViewSurvivesRollbackAndAppends(t *testing.T) {
	t.Parallel()
	s := newExecutionState(ScenarioConfig{MaxTurns: 10})
	s.add(UserMsg("a"), "")
	s.add(AssistantMsg("b"), "")
	view := s.messagesView()
	if cap(view) != len(view) {
		t.Fatalf("view must be capped: len %d cap %d", len(view), cap(view))
	}
	s.add(UserMsg("c"), "")
	if _, err := s.RollbackMessagesTo(1); err != nil {
		t.Fatal(err)
	}
	s.add(AssistantMsg("d"), "")
	s.add(UserMsg("e"), "")
	if len(view) != 2 || view[0].Content != "a" || view[1].Content != "b" {
		t.Fatalf("view changed: %+v", view)
	}
	var texts []string
	for _, m := range s.Messages() {
		texts = append(texts, m.Content)
	}
	if !slices.Equal(texts, []string{"a", "d", "e"}) {
		t.Fatalf("state %v", texts)
	}
	// An append to the view copies instead of writing into the state.
	grown := append(view, UserMsg("x"))
	if grown[2].Content != "x" || s.Messages()[1].Content != "d" {
		t.Fatal("an append to a view must not reach the state")
	}
}

// TestJudgeExtensionsGetAHistoryCopy: a JudgeInputPreprocessor that
// modifies the messages in place does not change the conversation.
func TestJudgeExtensionsGetAHistoryCopy(t *testing.T) {
	t.Parallel()
	criteria := []string{"ok"}
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) { return TextReturn("ok"), nil })
	sim, _ := userSim("unused")
	res, err := Run(context.Background(), ScenarioConfig{
		Name: "n", Description: "d", Extensions: []Extension{inPlaceJudgeInput{}},
		Agents: []AgentAdapter{agent, sim, NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "m"}, Criteria: criteria})},
		Script: []ScriptStep{MessageStep(Message{Role: RoleUser, Parts: []Part{AudioPart(MediaTypePCM16, []byte{1, 2})}}), Agent(), Judge()},
	})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	if !res.Messages[0].HasAudio() || res.Messages[0].Content == "overwritten" {
		t.Fatalf("the extension's in-place change reached the conversation: %+v", res.Messages[0])
	}
}

type inPlaceJudgeInput struct{}

func (inPlaceJudgeInput) Key() string { return "in-place-judge-input" }
func (inPlaceJudgeInput) PreprocessJudgeInput(_ context.Context, _ *Executor, msgs []Message, _ JudgeInputOptions) ([]Message, error) {
	for i := range msgs {
		msgs[i] = UserMsg("overwritten")
	}
	return msgs, nil
}

// TestSeededModelEncodingMatchesOnDemand: the model JSON the executor keeps
// from an agent span's output is what the state would encode itself, so
// the next span input is byte-identical.
func TestSeededModelEncodingMatchesOnDemand(t *testing.T) {
	t.Parallel()
	msgs := []Message{
		UserMsg("hi \"there\" <b>"),
		{Role: RoleAssistant, Parts: []Part{TextPart("look"), ImagePart("image/png", []byte{1, 2, 3})}},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "weather", Arguments: `{"city": "Paris"}`}}},
		{Role: RoleTool, ToolCallID: "c1", ToolName: "weather", Content: `{"temp":21}`},
		{Role: RoleAssistant, Parts: []Part{TextPart("a"), AudioPart(MediaTypePCM16, make([]byte, 300))}},
	}
	seeded := newExecutionState(ScenarioConfig{MaxTurns: 10})
	fresh := newExecutionState(ScenarioConfig{MaxTurns: 10})
	encoded := encodeModelMessages(msgs)
	for i, m := range msgs {
		m.TraceID = "trace"
		seeded.addEncoded(m, "", encoded[i])
		fresh.add(m, "")
	}
	if got, want := seeded.chatMessagesInput(), fresh.chatMessagesInput(); got != want {
		t.Fatalf("seeded input\n got %s\nwant %s", got, want)
	}
	for i, m := range msgs {
		if got, want := string(encoded[i]), string(appendModelMessage(nil, m)); got != want {
			t.Errorf("message %d: %s, want %s", i, got, want)
		}
	}
	if got, want := chatMessagesValue(msgs), chatMessagesJSON(encoded); got != want {
		t.Errorf("output %s, want %s", got, want)
	}
}

// TestEmptyObjectSchemaIsFreshPerCall: provider and user LLM code may
// modify a tool schema, so each call returns maps of its own.
func TestEmptyObjectSchemaIsFreshPerCall(t *testing.T) {
	t.Parallel()
	a, b := emptyObjectSchema(), emptyObjectSchema()
	a["x"] = 1
	a["properties"].(map[string]any)["y"] = 2
	if len(b) != 3 || len(b["properties"].(map[string]any)) != 0 {
		t.Fatalf("schemas share state: %v", b)
	}
}
