package scenario

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func judgeWith(llm LLM, criteria ...string) *JudgeAgent {
	return NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "judge-model"}, Criteria: criteria})
}

func runProceed(t *testing.T, cfg ScenarioConfig) (*ScenarioResult, error) {
	t.Helper()
	sim, _ := userSim("hello")
	cfg.Name, cfg.Description = "judge test", "the agent greets the user"
	cfg.Agents = append([]AgentAdapter{&echoAgent{text: "hi there"}, sim}, cfg.Agents...)
	return Run(context.Background(), cfg)
}

func TestJudgeTwoPhaseContinueThenVerdict(t *testing.T) {
	t.Parallel()
	criteria := []string{"Agent greets the user", "Agent is polite"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		switch {
		case hasTool(p, "make_verdict") && n == 1:
			return toolAnswer("continue_test", "{}"), nil
		case hasTool(p, "make_verdict"):
			return toolAnswer("make_verdict", "{}"), nil
		default:
			return toolAnswer("finish_test", finishArgs(criteria, "passed", "passed")), nil
		}
	}}
	res, err := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{judgeWith(llm, criteria...)}})
	if err != nil || !res.Success {
		t.Fatalf("expected success, got %+v %v", res, err)
	}
	calls := llm.calls()
	if len(calls) != 3 {
		t.Fatalf("expected decision, decision, verdict calls; got %d", len(calls))
	}
	if calls[0].ToolChoice.Type != ToolChoiceRequired || hasTool(calls[0], "finish_test") {
		t.Errorf("decision phase must offer only continue_test/make_verdict with tool choice required")
	}
	if !hasTool(calls[2], "finish_test") || calls[2].ToolChoice.Type != ToolChoiceTool || calls[2].ToolChoice.ToolName != "finish_test" {
		t.Errorf("verdict phase must pin finish_test, got %+v", calls[2].ToolChoice)
	}
	if !strings.HasPrefix(calls[0].Messages[0].Content, "<role>\nYou are an LLM as a judge watching a simulated conversation as it plays out live to decide") {
		t.Errorf("decision prompt: %q", calls[0].Messages[0].Content)
	}
	if !strings.Contains(calls[2].Messages[0].Content, "- Judge each criterion on its own") {
		t.Errorf("verdict prompt lacks per-criterion rules")
	}
	if len(res.Criteria) != 2 || res.Criteria[0].Requirement != "req 0" || res.Criteria[1].Criterion != "Agent is polite" {
		t.Errorf("criteria results: %+v", res.Criteria)
	}
	if !slices.Equal(res.MetCriteria, criteria) || len(res.UnmetCriteria) != 0 {
		t.Errorf("met/unmet: %v %v", res.MetCriteria, res.UnmetCriteria)
	}
}

func TestJudgeContentMatchesJSLayout(t *testing.T) {
	got, large := judgeContent(nil, nil, 100, "user: \"hi\"", additionalContextSection("ctx"))
	if large {
		t.Fatal("no spans is never a large trace")
	}
	want := "\n    <transcript>\n    user: \"hi\"\n    </transcript>\n    <opentelemetry_traces>\n    No spans recorded.\n    </opentelemetry_traces>\n    <additional_context>\n    ctx\n    </additional_context>\n    "
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestJudgeExplicitStepForcesVerdictWithAdditionalContext(t *testing.T) {
	t.Parallel()
	criteria := []string{"Agent greets"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		return toolAnswer("finish_test", finishArgs(criteria, "inconclusive")), nil
	}}
	res, _ := runProceed(t, ScenarioConfig{
		Agents: []AgentAdapter{judgeWith(llm, criteria...)},
		Script: []ScriptStep{User(), Agent(), Judge(WithAdditionalContext("exit code 0"))},
	})
	calls := llm.calls()
	if len(calls) != 1 || !hasTool(calls[0], "finish_test") || hasTool(calls[0], "continue_test") {
		t.Fatalf("explicit judge must skip the decision phase: %d calls", len(calls))
	}
	if !strings.Contains(calls[0].Messages[1].Content, "<additional_context>\n    exit code 0") {
		t.Errorf("missing additional context: %q", calls[0].Messages[1].Content)
	}
	// A forced inconclusive verdict is terminal and fails the run.
	if res.Success || !slices.Equal(res.InconclusiveCriteria, criteria) || !slices.Equal(res.UnmetCriteria, criteria) {
		t.Fatalf("forced inconclusive must fail: %+v", res)
	}
}

func TestJudgeVoluntaryInconclusiveContinues(t *testing.T) {
	t.Parallel()
	criteria := []string{"Agent greets"}
	verdicts := 0
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if hasTool(p, "make_verdict") {
			return toolAnswer("make_verdict", "{}"), nil
		}
		verdicts++
		if verdicts == 1 {
			return toolAnswer("finish_test", finishArgs(criteria, "inconclusive")), nil
		}
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	res, err := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{judgeWith(llm, criteria...)}})
	if err != nil || !res.Success || userTurns(res) < 2 {
		t.Fatalf("voluntary inconclusive must continue to a later verdict: %+v %v", res, err)
	}
}

// userTurns counts the user messages of a result.
func userTurns(r *ScenarioResult) int {
	n := 0
	for _, m := range r.Messages {
		if m.Role == RoleUser {
			n++
		}
	}
	return n
}

func TestJudgeMissingAnswerFailsClosed(t *testing.T) {
	t.Parallel()
	criteria := []string{"First criterion", "Second criterion"}
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		return toolAnswer("finish_test", `{"criteria":{"first_criterion":{"requirement":"r","reasoning":"ok","status":"passed"}},"reasoning":""}`), nil
	}}
	res, _ := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{judgeWith(llm, criteria...)}, Script: []ScriptStep{User(), Agent(), Judge()}})
	if res.Success || res.Criteria[1].Status != CriterionFailed || res.Criteria[1].Reasoning != "The judge returned no verdict for this criterion." {
		t.Fatalf("missing answer must fail closed: %+v", res.Criteria)
	}
	if res.Reasoning != "No reasoning provided" {
		t.Errorf("reasoning: %q", res.Reasoning)
	}
}

func TestJudgeMaxTurnsForcesVerdictOnLastTurn(t *testing.T) {
	t.Parallel()
	criteria := []string{"Agent greets"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if hasTool(p, "continue_test") {
			return toolAnswer("continue_test", "{}"), nil
		}
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	res, err := runProceed(t, ScenarioConfig{MaxTurns: 3, Agents: []AgentAdapter{judgeWith(llm, criteria...)}})
	if err != nil || !res.Success {
		t.Fatalf("expected a forced verdict on the last turn: %+v %v", res, err)
	}
	// Turns 0 and 1 decide; turn 2 (currentTurn >= maxTurns-1) is forced.
	calls := llm.calls()
	if len(calls) != 3 || !hasTool(calls[2], "finish_test") {
		t.Fatalf("expected 2 decisions and a forced verdict, got %d calls", len(calls))
	}
	if got := userTurns(res); got != 3 {
		t.Errorf("expected 3 user turns, got %d", got)
	}
}

func TestJudgeMinTurnsSkipsTheLLMBelowTheFloor(t *testing.T) {
	t.Parallel()
	criteria := []string{"Agent greets"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if hasTool(p, "make_verdict") {
			return toolAnswer("make_verdict", "{}"), nil
		}
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	res, err := runProceed(t, ScenarioConfig{MinTurns: 3, Agents: []AgentAdapter{judgeWith(llm, criteria...)}})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	if got := userTurns(res); got != 4 {
		t.Errorf("minTurns 3 means the judge first decides on turn 4, got %d user turns", got)
	}
	if len(llm.calls()) != 2 {
		t.Errorf("no LLM call below the floor; got %d calls", len(llm.calls()))
	}
}

func TestMinTurnsValidation(t *testing.T) {
	t.Parallel()
	_, err := Run(context.Background(), ScenarioConfig{Name: "n", Description: "d", MaxTurns: 2, MinTurns: 3, Agents: []AgentAdapter{&echoAgent{}}})
	if err == nil || !strings.Contains(err.Error(), "minTurns (3) cannot exceed maxTurns (2)") {
		t.Fatalf("got %v", err)
	}
}

func TestJudgeWithoutCriteriaOnRequest(t *testing.T) {
	t.Parallel()
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return nil, errors.New("must not be called") }}
	res, _ := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{judgeWith(llm)}, Script: []ScriptStep{User(), Agent(), Judge()}})
	if res.Success || res.Reasoning != "JudgeAgent: No criteria was provided to be judged against" {
		t.Fatalf("%+v", res)
	}
}

func TestJudgeCheckpointsCompile(t *testing.T) {
	t.Parallel()
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		status := "passed"
		if strings.Contains(p.Messages[0].Content, "Agent fails") {
			status = "failed"
		}
		var c []string
		for _, line := range strings.Split(p.Messages[0].Content, "\n") {
			if len(line) > 3 && line[1] == '.' && line[0] >= '1' && line[0] <= '9' {
				c = append(c, line[3:])
			}
		}
		return toolAnswer("finish_test", finishArgs(c, status)), nil
	}}
	pass, _ := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{judgeWith(llm)}, Script: []ScriptStep{
		User(), Agent(), Judge(WithCriteria("Agent replies")), User(), Agent(), Judge(WithCriteria("Agent replies again")),
	}})
	if !pass.Success || pass.Reasoning != "All inline criteria checkpoints passed" || !slices.Equal(pass.MetCriteria, []string{"Agent replies", "Agent replies again"}) || len(pass.Criteria) != 2 {
		t.Fatalf("passing checkpoints: %+v", pass)
	}
	fail, _ := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{judgeWith(llm)}, Script: []ScriptStep{
		User(), Agent(), Judge(WithCriteria("Agent replies")), Judge(WithCriteria("Agent fails")), Succeed(),
	}})
	if fail.Success || !slices.Equal(fail.MetCriteria, []string{"Agent replies"}) || !slices.Equal(fail.UnmetCriteria, []string{"Agent fails"}) {
		t.Fatalf("failing checkpoint: %+v", fail)
	}
}

func TestCriteriaParamNames(t *testing.T) {
	if got := criterionToParamName(`User"s Satisfaction Level`); got != "users_satisfaction_level" {
		t.Errorf("got %q", got)
	}
	if got := criterionToParamName("Response Quality & Clarity"); got != "response_quality___clarity" {
		t.Errorf("got %q", got)
	}
	if got := criteriaParamNames([]string{"Ships fast", "Ships fast"}); !slices.Equal(got, []string{"ships_fast", "ships_fast_1"}) {
		t.Errorf("got %v", got)
	}
	long := strings.Repeat("a", 80)
	got := criteriaParamNames([]string{long, long + "b"})
	if len(got[0]) != 70 || len(got[1]) != 70 || !strings.HasSuffix(got[1], "_1") {
		t.Errorf("got %v", got)
	}
}

func TestJudgeCustomSystemPromptKeepsPhaseRule(t *testing.T) {
	t.Parallel()
	criteria := []string{"x"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if hasTool(p, "make_verdict") {
			return toolAnswer("make_verdict", "{}"), nil
		}
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	j := NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm}, Criteria: criteria, SystemPrompt: "You are strict."})
	runProceed(t, ScenarioConfig{Agents: []AgentAdapter{j}})
	calls := llm.calls()
	if calls[0].Messages[0].Content != "You are strict.\n\n"+decisionPhaseRule || calls[1].Messages[0].Content != "You are strict." {
		t.Fatalf("custom prompts: %q / %q", calls[0].Messages[0].Content, calls[1].Messages[0].Content)
	}
}

func TestJudgeLargeTraceDiscoveryAndExhaustion(t *testing.T) {
	t.Parallel()
	criteria := []string{"x"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if p.ToolChoice.Type == ToolChoiceTool && p.ToolChoice.ToolName == "finish_test" {
			return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
		}
		return toolAnswer("grep_trace", `{"pattern":"call"}`), nil
	}}
	j := NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm}, Criteria: criteria, TokenThreshold: 1, MaxDiscoverySteps: 2})
	res, err := runProceed(t, ScenarioConfig{Agents: []AgentAdapter{j}, Script: []ScriptStep{User(), Agent(), Judge()}})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	calls := llm.calls()
	if !hasTool(calls[0], "expand_trace") || !hasTool(calls[0], "grep_trace") || calls[0].ToolChoice.Type != ToolChoiceRequired {
		t.Fatal("large trace must offer discovery tools")
	}
	if !strings.Contains(calls[0].Messages[1].Content, "Use expand_trace(span_id)") {
		t.Error("structure-only digest hint missing")
	}
	last := calls[len(calls)-1]
	if len(last.Tools) != 1 || last.Tools[0].Name != "finish_test" {
		t.Errorf("forced verdict must offer finish_test only")
	}
	if got := last.Messages[len(last.Messages)-1].Content; got != discoveryExhaustedPrompt {
		t.Errorf("last message %q", got)
	}
	if !strings.Contains(last.Messages[2].Content, "[Called grep_trace with {\"pattern\":\"call\"}]") {
		t.Errorf("discovery history must be collapsed to text: %q", last.Messages[2].Content)
	}
}

// fakeFetcher records the remote trace calls the judge makes.
type fakeFetcher struct {
	settled bool
	calls   []string
}

func (f *fakeFetcher) SettleWait(context.Context, TraceSettleTarget) bool {
	f.calls = append(f.calls, "settle")
	return f.settled
}
func (f *fakeFetcher) ExtendSettle(_ context.Context, t TraceSettleTarget) {
	f.calls = append(f.calls, "extend:"+t.Timeout.String())
	f.settled = true
}
func (f *fakeFetcher) NoneSettled(string, []string) bool { return !f.settled }
func (f *fakeFetcher) RecordMissingTraceIDs(string, *SpanCollector) {
	f.calls = append(f.calls, "missing")
}
func (f *fakeFetcher) ClearThread(string) {}

func TestJudgeWaitForTracesOnce(t *testing.T) {
	criteria := []string{"Agent saved the record"}
	llm := &fakeLLM{answer: func(n int, p InferenceParams) (*InferenceResult, error) {
		if hasTool(p, "wait_for_traces") {
			return toolAnswer("wait_for_traces", "{}"), nil
		}
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	fetcher := &fakeFetcher{}
	on := true
	j := NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm}, Criteria: criteria, TraceFetcher: fetcher})
	res, err := runProceed(t, ScenarioConfig{
		Agents: []AgentAdapter{j}, FetchRemoteTraces: &on, TraceWaitExtension: 5 * time.Second,
		Script: []ScriptStep{User(), Agent(), Judge()},
	})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	if !slices.Equal(fetcher.calls, []string{"settle", "extend:5s"}) {
		t.Errorf("fetcher calls %v", fetcher.calls)
	}
	calls := llm.calls()
	if len(calls) != 2 || hasTool(calls[1], "wait_for_traces") {
		t.Fatalf("wait_for_traces must be offered once, then withdrawn")
	}
	if !strings.Contains(calls[0].Messages[0].Content, remoteTraceJudgingRule) {
		t.Error("remote judging rule missing")
	}
	if got := calls[1].Messages[len(calls[1].Messages)-1].Content; got != waitedOncePrompt {
		t.Errorf("got %q", got)
	}
}

func TestJudgeAudioPreprocessorAndContext(t *testing.T) {
	t.Parallel()
	criteria := []string{"x"}
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) {
		return toolAnswer("finish_test", finishArgs(criteria, "passed")), nil
	}}
	ext := &voiceLikeExtension{}
	audioUser := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
		return TextReturn("ok"), nil
	})
	sim, _ := userSim("unused")
	res, err := Run(context.Background(), ScenarioConfig{
		Name: "n", Description: "d", Extensions: []Extension{ext},
		Agents: []AgentAdapter{audioUser, sim, NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "gpt-4o-audio"}, Criteria: criteria})},
		Script: []ScriptStep{MessageStep(Message{Role: RoleUser, Parts: []Part{AudioPart(MediaTypePCM16, []byte{1, 2})}}), Agent(), Judge()},
	})
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
	if !ext.includeAudio {
		t.Error("gpt-4o judge must receive audio")
	}
	content := llm.calls()[0].Messages[1].Content
	if !strings.Contains(content, `user: "transcribed"`) || !strings.Contains(content, "<voice_timeline>t</voice_timeline>") {
		t.Errorf("judge content: %q", content)
	}
}

type voiceLikeExtension struct{ includeAudio bool }

func (*voiceLikeExtension) Key() string { return "voice-test" }
func (v *voiceLikeExtension) PreprocessJudgeInput(_ context.Context, _ *Executor, msgs []Message, o JudgeInputOptions) ([]Message, error) {
	v.includeAudio = o.IncludeAudio
	out := slices.Clone(msgs)
	for i := range out {
		if out[i].HasAudio() {
			out[i] = UserMsg("transcribed")
		}
	}
	return out, nil
}
func (*voiceLikeExtension) JudgeContext(context.Context, *Executor) string {
	return "<voice_timeline>t</voice_timeline>"
}

func TestJudgeTranscriptTruncatesMedia(t *testing.T) {
	got := buildJudgeTranscript([]Message{
		UserMsg("hi"),
		{Role: RoleAssistant, Parts: []Part{TextPart("hello"), AudioPart("audio/wav", make([]byte, 30))}},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c", Name: "f", Arguments: `{"a": 1}`}}},
		{Role: RoleTool, ToolCallID: "c", ToolName: "f", Content: "sunny"},
	})
	want := "user: \"hi\"\n" +
		`assistant: [{"type":"text","text":"hello"},{"type":"file","mediaType":"audio/wav","data":"[AUDIO: audio/wav, ~40 bytes]"}]` + "\n" +
		`assistant: [{"type":"tool-call","toolCallId":"c","toolName":"f","input":{"a":1}}]` + "\n" +
		`tool: [{"type":"tool-result","toolCallId":"c","toolName":"f","output":{"type":"text","value":"sunny"}}]`
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}
