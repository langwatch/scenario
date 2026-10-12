package scenario

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
)

func baseConfig(agents ...AgentAdapter) ScenarioConfig {
	return ScenarioConfig{Name: "executor test", Description: "testing the executor", Agents: agents}
}

func TestScriptedConversationAndNewMessages(t *testing.T) {
	t.Parallel()
	var seen [][]Message
	var mu sync.Mutex
	agent := AgentFunc(func(_ context.Context, in AgentInput) (*AgentReturn, error) {
		mu.Lock()
		seen = append(seen, in.NewMessages)
		mu.Unlock()
		if in.PropagationHeaders["traceparent"] == "" {
			return nil, errors.New("missing traceparent")
		}
		return TextReturn("reply " + in.Messages[len(in.Messages)-1].Content), nil
	})
	sim, _ := userSim("generated question")
	res, err := Run(context.Background(), ScenarioConfig{
		Name: "n", Description: "d", Agents: []AgentAdapter{agent, sim},
		Script: []ScriptStep{User("first"), Agent(), User(), Agent(), Agent("scripted"), Succeed()},
	})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	var texts []string
	for _, m := range res.Messages {
		texts = append(texts, string(m.Role)+":"+m.Content)
	}
	want := []string{"user:first", "assistant:reply first", "user:generated question", "assistant:reply generated question", "assistant:scripted"}
	if !slices.Equal(texts, want) {
		t.Fatalf("messages %v", texts)
	}
	if res.Reasoning != "Scenario marked as successful with Scenario.succeed()" {
		t.Errorf("reasoning %q", res.Reasoning)
	}
	if len(seen) != 2 || len(seen[0]) != 1 || len(seen[1]) != 1 || seen[1][0].Content != "generated question" {
		t.Errorf("new messages per call: %+v", seen)
	}
	if res.Messages[1].TraceID == "" || res.Messages[0].TraceID != "" {
		t.Errorf("trace id must be stamped on agent messages only")
	}
	if !strings.HasPrefix(res.Messages[0].ID, messageIDPrefix) || !strings.HasPrefix(res.RunID, runIDPrefix) {
		t.Errorf("ids %q %q", res.Messages[0].ID, res.RunID)
	}
}

func TestUserSimulatorPromptAndRoleReversal(t *testing.T) {
	t.Parallel()
	sim, llm := userSim("question")
	sim.cfg.Persona = "a busy chef"
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
		return MessagesReturn(
			Message{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "lookup", Arguments: `{"q":1}`}}},
			Message{Role: RoleTool, ToolCallID: "c1", ToolName: "lookup", Content: "found"},
			AssistantMsg("answer"),
		), nil
	})
	Run(context.Background(), ScenarioConfig{Name: "n", Description: "cook dinner", Agents: []AgentAdapter{agent, sim},
		Script: []ScriptStep{User("hi"), Agent(), User(), Succeed()}})
	p := llm.calls()[0]
	if !strings.Contains(p.Messages[0].Content, "<scenario>\ncook dinner\n</scenario>") || !strings.HasSuffix(p.Messages[0].Content, "<persona>\na busy chef\n</persona>") {
		t.Errorf("system prompt %q", p.Messages[0].Content)
	}
	var got []string
	for _, m := range p.Messages[1:] {
		got = append(got, string(m.Role)+":"+m.Content)
	}
	want := []string{
		"user:Hello, how can I help you today", "assistant:hi",
		`user:[Called tool lookup with: {"q":1}]`, "user:[Tool result from lookup: found]", "user:answer",
	}
	if !slices.Equal(got, want) {
		t.Errorf("reversed %v", got)
	}
	if p.Temperature != nil {
		t.Error("temperature must stay unset by default")
	}
}

func TestUserSimulatorRetriesEmptyAnswers(t *testing.T) {
	t.Parallel()
	n := 0
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		n++
		return textAnswer(""), nil
	}}
	sim := NewUserSimulatorAgent(UserSimulatorAgentConfig{ModelConfig: ModelConfig{LLM: llm}})
	res, err := Run(context.Background(), ScenarioConfig{Name: "n", Description: "d", Agents: []AgentAdapter{&echoAgent{}, sim}, Script: []ScriptStep{User()}})
	if err == nil || n != 3 || !strings.Contains(res.Reasoning, "[UserSimulatorAgent] No response content from LLM") {
		t.Fatalf("calls %d err %v res %+v", n, err, res)
	}
	var info map[string]string
	if json.Unmarshal([]byte(res.Error), &info) != nil || info["name"] != "Error" || info["message"] != "[UserSimulatorAgent] No response content from LLM" {
		t.Errorf("error info %q", res.Error)
	}
}

func TestAgentErrorReportsErrorRun(t *testing.T) {
	t.Parallel()
	rec := &eventRecorder{}
	boom := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) { return nil, errors.New("boom") })
	sim, _ := userSim("x")
	res, err := Run(context.Background(), ScenarioConfig{Name: "n", Description: "d", Agents: []AgentAdapter{boom, sim}, Script: []ScriptStep{User("hi"), Agent()}},
		WithEventListener(rec.record))
	if err == nil || res.Success || res.Reasoning != "Scenario failed with error: [Agent] boom" {
		t.Fatalf("%+v %v", res, err)
	}
	last := rec.all()[len(rec.all())-1]
	if last.Type != EventRunFinished || decode(t, last.Payload)["status"] != "ERROR" {
		t.Fatalf("last event %s", last.Payload)
	}
}

func TestAssertionErrorFailsAsCheck(t *testing.T) {
	t.Parallel()
	rec := &eventRecorder{}
	sim, _ := userSim("x")
	check := StepFunc(func(_ context.Context, ex *Executor) error {
		return Assert(ex.State().HasToolCall("search"), "agent should have searched")
	})
	res, err := Run(context.Background(), baseConfigWith(sim, User("hi"), Agent(), check, Succeed()), WithEventListener(rec.record))
	var ae *AssertionError
	if !errors.As(err, &ae) || res.Success || !slices.Contains(res.UnmetCriteria, "agent should have searched") {
		t.Fatalf("%+v %v", res, err)
	}
	if decode(t, rec.all()[len(rec.all())-1].Payload)["status"] != "ERROR" {
		t.Error("a failed check reports ERROR")
	}
}

func baseConfigWith(sim AgentAdapter, script ...ScriptStep) ScenarioConfig {
	cfg := baseConfig(&echoAgent{text: "ok"})
	if sim != nil {
		cfg.Agents = append(cfg.Agents, sim)
	}
	cfg.Script = script
	return cfg
}

func TestEndOfScriptAndMaxTurns(t *testing.T) {
	t.Parallel()
	sim, _ := userSim("x")
	res, _ := Run(context.Background(), baseConfigWith(sim, User("hi"), Agent()))
	if res.Success || !strings.HasPrefix(res.Reasoning, "Reached end of script without conclusion, add one of the following:\n- Add `Scenario.judge()`") {
		t.Fatalf("%q", res.Reasoning)
	}
	judge := judgeWith(&fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		return toolAnswer("continue_test", "{}"), nil
	}}, "criterion a")
	cfg := baseConfig(&echoAgent{text: "ok"}, sim, judge)
	cfg.MaxTurns = 2
	cfg.Script = []ScriptStep{Proceed(), Proceed()}
	// The judge cannot continue on the last turn; with a non-judging judge
	// the run ends at the turn cap.
	judge.cfg.ModelConfig.LLM = &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return toolAnswer("continue_test", "{}"), nil }}
	res, _ = Run(context.Background(), cfg)
	if res.Success || !slices.Equal(res.UnmetCriteria, []string{"criterion a"}) {
		t.Fatalf("%+v", res)
	}
}

func TestProceedTurnsAndCallbacks(t *testing.T) {
	t.Parallel()
	sim, _ := userSim("x")
	agent := &echoAgent{text: "ok"}
	var turns, steps int
	cfg := baseConfig(agent, sim)
	cfg.Script = []ScriptStep{
		Proceed(Turns(3),
			OnTurn(func(context.Context, *ExecutionState) error { turns++; return nil }),
			OnStep(func(context.Context, *ExecutionState) error { steps++; return nil })),
		Succeed(),
	}
	res, err := Run(context.Background(), cfg)
	if err != nil || !res.Success {
		t.Fatal(err)
	}
	if agent.calls.Load() != 3 || turns != 2 || steps != 6 {
		t.Fatalf("agent %d turns %d steps %d", agent.calls.Load(), turns, steps)
	}
}

func TestNoAgentForRole(t *testing.T) {
	t.Parallel()
	_, err := Run(context.Background(), baseConfigWith(nil, Judge()))
	if err == nil {
		t.Fatal("expected error")
	}
}

// hookRecorder implements every executor hook.
type hookRecorder struct {
	mu     sync.Mutex
	events []string
}

func (h *hookRecorder) add(s string)                           { h.mu.Lock(); h.events = append(h.events, s); h.mu.Unlock() }
func (h *hookRecorder) Key() string                            { return "recorder" }
func (h *hookRecorder) Start(context.Context, *Executor) error { h.add("start"); return nil }
func (h *hookRecorder) Stop(context.Context, *Executor)        { h.add("stop") }
func (h *hookRecorder) TransformUserTurn(_ context.Context, _ *Executor, producer AgentAdapter, msgs []Message) ([]Message, error) {
	if producer == nil {
		h.add("transform-scripted")
	} else {
		h.add("transform-generated")
	}
	out := slices.Clone(msgs)
	for i := range out {
		out[i].Content = strings.ToUpper(out[i].Content)
	}
	return out, nil
}
func (h *hookRecorder) InterceptUserTurn(_ context.Context, ex *Executor, m Message) (bool, error) {
	if m.Content == "INTERCEPT" {
		h.add("intercepted")
		ex.AddMessage(UserMsg("delivered by extension"))
		return true, nil
	}
	return false, nil
}
func (h *hookRecorder) AfterGeneratedUserTurn(context.Context, *Executor, Message) error {
	h.add("after-generated")
	return nil
}
func (h *hookRecorder) BeforeProceedStep(context.Context, *Executor) error {
	h.add("before-step")
	return nil
}
func (h *hookRecorder) AfterProceedStep(context.Context, *Executor) error {
	h.add("after-step")
	return nil
}
func (h *hookRecorder) FinalizeResult(_ context.Context, ex *Executor, r *ScenarioResult) error {
	h.add("finalize")
	r.SetExtension(h.Key(), ex.Value("k"))
	return nil
}

// providerAgent brings the recorder as its extension.
type providerAgent struct {
	echoAgent
	ext *hookRecorder
}

func (p *providerAgent) Extension() Extension { return p.ext }

func TestExtensionHooks(t *testing.T) {
	t.Parallel()
	h := &hookRecorder{}
	sim, _ := userSim("generated")
	agent := &providerAgent{echoAgent: echoAgent{text: "ok"}, ext: h}
	cfg := baseConfig(agent, sim)
	cfg.Extensions = []Extension{h} // deduplicated with the provider's
	cfg.Script = []ScriptStep{User("hello"), Agent(), User("intercept"), Proceed(Turns(2)), Succeed()}
	res, err := Run(context.Background(), cfg, WithValue("k", "v"))
	if err != nil || !res.Success {
		t.Fatal(err)
	}
	want := []string{"start", "transform-scripted", "transform-scripted", "intercepted",
		"before-step", "transform-generated", "after-generated", "after-step",
		"before-step", "after-step", "finalize", "stop"}
	if !slices.Equal(h.events, want) {
		t.Fatalf("hooks\n got %v\nwant %v", h.events, want)
	}
	if res.Messages[0].Content != "HELLO" || res.Messages[2].Content != "delivered by extension" || res.Extensions["recorder"] != "v" {
		t.Fatalf("result %+v", res)
	}
}

func TestFinalizerRunsOnErrorPath(t *testing.T) {
	t.Parallel()
	h := &hookRecorder{}
	cfg := baseConfig(AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) { return nil, errors.New("x") }))
	cfg.Extensions = []Extension{h}
	cfg.Script = []ScriptStep{Agent()}
	Run(context.Background(), cfg)
	if !slices.Equal(h.events, []string{"start", "finalize", "stop"}) {
		t.Fatalf("%v", h.events)
	}
}

func TestAgentNonBlockingAndScheduling(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	slow := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
		<-release
		return TextReturn("finally"), nil
	})
	sim, _ := userSim("x")
	cfg := baseConfig(slow, sim)
	cfg.Script = []ScriptStep{
		User("hi"),
		StepFunc(func(ctx context.Context, ex *Executor) error {
			h := ex.AgentNonBlocking(ctx)
			if h.Finished() {
				return errors.New("turn finished too early")
			}
			ex.AddMessage(UserMsg("barge in"))
			close(release)
			return h.Wait()
		}),
		Succeed(),
	}
	res, err := Run(context.Background(), cfg)
	if err != nil || len(res.Messages) != 3 || res.Messages[2].Content != "finally" {
		t.Fatalf("%+v %v", res, err)
	}

	// ScheduleAgentTurnNonBlocking only fires when the agent is next.
	cfg2 := baseConfig(&echoAgent{text: "ok"}, sim)
	var scheduled []bool
	cfg2.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error {
		_, ok := ex.ScheduleAgentTurnNonBlocking(ctx)
		scheduled = append(scheduled, ok)
		if err := ex.User(ctx, "hi"); err != nil {
			return err
		}
		if role, _ := ex.NextRunnableRole(); role != AgentRoleAgent {
			return errors.New("agent should be next")
		}
		h, ok := ex.ScheduleAgentTurnNonBlocking(ctx)
		scheduled = append(scheduled, ok)
		return h.Wait()
	}), Succeed()}
	res, err = Run(context.Background(), cfg2)
	if err != nil || !slices.Equal(scheduled, []bool{false, true}) || len(res.Messages) != 2 {
		t.Fatalf("%v %v %+v", scheduled, err, res)
	}
}

func TestNonBlockingErrorFailsRun(t *testing.T) {
	t.Parallel()
	bad := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) { return nil, errors.New("late failure") })
	cfg := baseConfig(bad)
	cfg.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error { ex.AgentNonBlocking(ctx); return nil })}
	_, err := Run(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "late failure") {
		t.Fatalf("got %v", err)
	}
}

func TestContextCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, err := Run(ctx, baseConfigWith(nil, Agent()))
	if !errors.Is(err, context.Canceled) || res.Success {
		t.Fatalf("%v", err)
	}
}

func TestParallelRuns(t *testing.T) {
	for i := 0; i < 16; i++ {
		t.Run("run", func(t *testing.T) {
			t.Parallel()
			criteria := []string{"ok"}
			judge := judgeWith(&fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
				if hasTool(p, "make_verdict") {
					if n < 3 {
						return toolAnswer("continue_test", "{}"), nil
					}
					return toolAnswer("make_verdict", "{}"), nil
				}
				return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
			}}, criteria...)
			sim, _ := userSim("q")
			cfg := baseConfig(&echoAgent{text: "a"}, sim, judge)
			cfg.ThreadID = generateThreadID()
			res, err := Run(context.Background(), cfg)
			if err != nil || !res.Success {
				t.Fatalf("%+v %v", res, err)
			}
			if len(DefaultSpanCollector().SpansForThread(cfg.ThreadID)) != 0 {
				t.Fatal("the collector must release a finished run's thread")
			}
		})
	}
}

func TestValidation(t *testing.T) {
	t.Parallel()
	cases := map[string]ScenarioConfig{
		"name":        {Description: "d", Agents: []AgentAdapter{&echoAgent{}}},
		"description": {Name: "n", Agents: []AgentAdapter{&echoAgent{}}},
		"agents":      {Name: "n", Description: "d"},
		"agent role":  {Name: "n", Description: "d", Agents: []AgentAdapter{NewJudgeAgent(JudgeAgentConfig{})}},
		"max turns":   {Name: "n", Description: "d", MaxTurns: -1, Agents: []AgentAdapter{&echoAgent{}}},
	}
	for name, cfg := range cases {
		if _, err := Run(context.Background(), cfg); err == nil {
			t.Errorf("%s: expected a validation error", name)
		}
	}
}

func TestConnectedAgentKeepsSession(t *testing.T) {
	t.Parallel()
	var sessions []any
	var params map[string]ParameterValue
	ca := NewConnectedAgent("support-bot", "local", func(_ context.Context, c ConnectedCall) (ConnectedReply, error) {
		sessions = append(sessions, c.Session)
		params = c.Params
		if c.TraceID == "" {
			return ConnectedReply{}, errors.New("no trace id")
		}
		return ConnectedReply{Output: TextReturn("hi"), Session: len(sessions)}, nil
	})
	sim, _ := userSim("x")
	cfg := baseConfig(ca, sim)
	cfg.Parameters = map[string]ParameterValue{"tone": "formal"}
	cfg.Script = []ScriptStep{User("a"), Agent(), User("b"), Agent(), Succeed()}
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(sessions, []any{nil, 1}) || params["tone"] != "formal" {
		t.Fatalf("sessions %v params %v", sessions, params)
	}
}

func TestRunStartedMetadataOrder(t *testing.T) {
	t.Parallel()
	rec := &eventRecorder{}
	sim, _ := userSim("x")
	cfg := baseConfig(&echoAgent{text: "ok"}, sim, NewJudgeAgent(JudgeAgentConfig{Name: "  Strict Judge  "}))
	cfg.Metadata = map[string]any{"zeta": 1, "name": "ignored", "alpha": map[string]any{"<b>": true}}
	cfg.Fields = map[string]FieldValue{"golden_sql": "select 1"}
	cfg.Script = []ScriptStep{Succeed()}
	Run(context.Background(), cfg, WithEventListener(rec.record))
	p := string(rec.all()[0].Payload)
	i := strings.Index(p, `"metadata":`)
	want := `"metadata":{"alpha":{"<b>":true},"name":"executor test","zeta":1,"description":"testing the executor","agents":[{"name":"echoAgent","role":"agent"},{"name":"UserSimulatorAgent","role":"user"},{"name":"Strict Judge","role":"judge"}],"fields":{"golden_sql":"select 1"}}}`
	if p[i:] != want {
		t.Fatalf("got  %s\nwant %s", p[i:], want)
	}
}
