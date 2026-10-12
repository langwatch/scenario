package scenariotest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Exit(m.Run())
}

// recordingTB captures what Run reports instead of failing the real test.
type recordingTB struct {
	testing.TB
	logs, errors, fatals []string
}

func (r *recordingTB) Helper()                   {}
func (r *recordingTB) Log(args ...any)           { r.logs = append(r.logs, fmt.Sprint(args...)) }
func (r *recordingTB) Errorf(f string, a ...any) { r.errors = append(r.errors, fmt.Sprintf(f, a...)) }
func (r *recordingTB) Fatalf(f string, a ...any) { r.fatals = append(r.fatals, fmt.Sprintf(f, a...)) }

type silentUser struct{}

func (silentUser) Role() scenario.AgentRole { return scenario.AgentRoleUser }
func (silentUser) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.TextReturn("hi"), nil
}

type echoAgent struct{}

func (echoAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }
func (echoAgent) Call(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.MessagesReturn(
		scenario.Message{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "c1", Name: "lookup", Arguments: `{"q":"hi"}`}}},
		scenario.ToolMsg("c1", `{"found":true}`),
		scenario.AssistantMsg("You said: "+in.Messages[0].Text()),
	), nil
}

func config(verdict scenario.ScriptStep) scenario.ScenarioConfig {
	return scenario.ScenarioConfig{
		Name: "echo", Description: "The agent echoes",
		Agents: []scenario.AgentAdapter{echoAgent{}, silentUser{}},
		Script: []scenario.ScriptStep{scenario.User("hello"), scenario.Agent(), verdict},
	}
}

func TestRunLogsAndRecordsSuccess(t *testing.T) {
	tb := &recordingTB{TB: t}
	before := len(DefaultReporter().Entries())
	res := Run(tb, config(scenario.Succeed("echoed")), scenario.WithQuiet())
	if !res.Success || len(tb.errors)+len(tb.fatals) != 0 {
		t.Fatalf("result %+v errors %v %v", res, tb.errors, tb.fatals)
	}
	log := strings.Join(tb.logs, "\n")
	for _, want := range []string{
		"--- Scenario Run: echo ---", "Description: The agent echoes", "User: hello",
		"ToolCall(lookup):\n\n  {\n    \"q\": \"hi\"\n  }", "ToolResult:\n\n  {\n    \"found\": true\n  }",
		"Assistant: You said: hello", "Status: SUCCESS", "Verdict: success", "Reasoning: echoed",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("log lacks %q:\n%s", want, log)
		}
	}
	entries := DefaultReporter().Entries()
	if len(entries) != before+1 || entries[before].Status != StatusSuccess || entries[before].Test != t.Name() {
		t.Errorf("entries %+v", entries[before:])
	}
}

func TestRunFailsTestOnFailedVerdict(t *testing.T) {
	tb := &recordingTB{TB: t}
	Run(tb, config(scenario.Fail("wrong answer")), scenario.WithQuiet())
	if len(tb.errors) != 1 || !strings.Contains(tb.errors[0], "wrong answer") || len(tb.fatals) != 0 {
		t.Fatalf("errors %v fatals %v", tb.errors, tb.fatals)
	}
}

func TestRunStopsTestOnError(t *testing.T) {
	tb := &recordingTB{TB: t}
	cfg := config(scenario.Succeed())
	cfg.Name = ""
	Run(tb, cfg, scenario.WithQuiet())
	if len(tb.fatals) != 1 {
		t.Fatalf("fatals %v", tb.fatals)
	}
}

func TestReport(t *testing.T) {
	var r Reporter
	var b strings.Builder
	r.WriteReport(&b)
	if b.Len() != 0 {
		t.Fatal("an empty report prints nothing")
	}
	r.Add(Entry{Name: "a", Status: StatusSuccess, Duration: 1500e6, Result: &scenario.ScenarioResult{Success: true, Reasoning: "ok", MetCriteria: []string{"x"}}})
	r.Add(Entry{Name: "b", Status: StatusFailed, Result: &scenario.ScenarioResult{MetCriteria: []string{"x"}, UnmetCriteria: []string{"y", "z"}}})
	r.WriteReport(&b)
	for _, want := range []string{
		"=== Scenario Test Report ===", "Total Scenarios: 2", "Passed: 1", "Failed: 1", "Success Rate: 50.0%",
		"1. a - SUCCESS in 1.50s", "  Reasoning: ok", "  Success Criteria: 1/1", "2. b - FAILED in 0.00s", "  Success Criteria: 1/3",
	} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("report lacks %q:\n%s", want, b.String())
		}
	}
}

func TestFormatContent(t *testing.T) {
	long := strings.Repeat("a ", 60)
	if got := formatContent(scenario.UserMsg(long)); got != strings.Repeat("a ", 50)+"..." {
		t.Errorf("long %q", got)
	}
	if got := formatContent(scenario.UserMsg(strings.Repeat("QUJD", 20) + "==")); got != "[Binary data]" {
		t.Errorf("binary %q", got)
	}
	if got := formatContent(scenario.Message{Role: scenario.RoleUser, Parts: []scenario.Part{scenario.AudioPart("audio/wav", []byte{1, 2})}}); got != "[Content with binary data]" {
		t.Errorf("parts %q", got)
	}
}
