package redteam

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

func TestSlugifyAndStrategyNames(t *testing.T) {
	t.Parallel()
	slugs := map[string]string{
		"Bank Agent: PINEAPPLE test!": "bank_agent_pineapple_test",
		"":                            "run",
		"***":                         "run",
		"__a__b__":                    "a_b",
		strings.Repeat("ab", 50):      strings.Repeat("ab", 40),
	}
	for in, want := range slugs {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
	if reportStrategyName(CrescendoStrategy{}) != "crescendo" || reportStrategyName(&GOATStrategy{}) != "goat" {
		t.Error("built-in strategy names")
	}
	if got := reportStrategyName(customStrategy{}); got != "custom" {
		t.Errorf("custom strategy name %q", got)
	}
}

type customStrategy struct{ CrescendoStrategy }

func TestSaveReport(t *testing.T) {
	t.Setenv(EnvReport, "1")
	dir := t.TempDir()
	a := crescendo(t, Config{ModelConfig: scenario.ModelConfig{Model: "attacker-model"}, TotalTurns: 4})
	result := &scenario.ScenarioResult{
		Success:     true,
		Reasoning:   "held <ok>",
		MetCriteria: []string{"Agent refused all attacks"},
		Messages:    []scenario.Message{scenario.UserMsg("placeholder attack"), {Role: scenario.RoleAssistant, Content: "no", TraceID: "abc"}},
		AgentTime:   1500 * time.Millisecond,
	}
	path, err := SaveReport(ReportOptions{
		Result: result, Agent: a, TestName: "PINEAPPLE check", OutDir: dir, Elapsed: 2 * time.Second,
		Config: scenario.ScenarioConfig{Description: "placeholder description", Agents: []scenario.AgentAdapter{a, &recordingJudge{}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir || !strings.HasSuffix(path, "_pineapple_check_crescendo.json") {
		t.Errorf("path %q", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(data), "{\n  \"test_name\": \"PINEAPPLE check\",\n  \"description\"") || !strings.Contains(string(data), "held <ok>") {
		t.Errorf("layout: %s", data)
	}
	var rep map[string]any
	if err := json.Unmarshal(data, &rep); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"strategy": "crescendo", "target": placeholderTarget, "total_turns": 4.0, "attacker_model": "attacker-model",
		"metaprompt_model": "attacker-model", "status": "held", "success": true, "total_time": 2.0, "agent_time": 1.5,
		"severity": "medium", "break_severity": "none", "analysis_pending": true, "failing_turn_index": nil,
	}
	for k, v := range want {
		if rep[k] != v {
			t.Errorf("%s = %v, want %v", k, rep[k], v)
		}
	}
	if c := rep["criteria"].([]any); len(c) != 1 || c[0] != "Agent refused all attacks" {
		t.Errorf("criteria %v", c)
	}
	msgs := rep["messages"].([]any)
	if len(msgs) != 2 || msgs[1].(map[string]any)["content"] != "no" || len(msgs[1].(map[string]any)) != 2 {
		t.Errorf("messages %v", msgs)
	}
	if rep["failed_criteria"] == nil || rep["suggestions"] == nil {
		t.Error("empty lists must be [] not null")
	}

	errored := buildReport(ReportOptions{Result: &scenario.ScenarioResult{}, Error: "boom"}, time.Now())
	if errored.Status != "errored" || errored.Reasoning != "ERROR: boom" || errored.BreakSeverity != "significant" || errored.TotalTime != nil {
		t.Errorf("errored report: %+v", errored)
	}
	if broken := buildReport(ReportOptions{Result: &scenario.ScenarioResult{}}, time.Now()); broken.Status != "broken" {
		t.Errorf("broken report: %+v", broken)
	}

	t.Setenv(EnvReport, "0")
	if path, err := SaveReport(ReportOptions{Result: result, Agent: a, OutDir: dir}); path != "" || err != nil {
		t.Errorf("disabled: %q %v", path, err)
	}
}

func TestReportAutoSave(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvReport, "1")
	t.Setenv(EnvReportDir, dir)
	batchDir.Lock()
	batchDir.path = ""
	batchDir.Unlock()
	t.Cleanup(func() {
		batchDir.Lock()
		batchDir.path = ""
		batchDir.Unlock()
	})

	a := crescendo(t, Config{
		ModelConfig:      scenario.ModelConfig{LLM: placeholderAttacks()},
		DisableScoring:   true,
		DisableEarlyExit: true,
		TotalTurns:       2,
	})
	if _, err := run(t, a, &target{respond: func(string) string { return "placeholder answer" }}, &recordingJudge{}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*_red_team_test_crescendo.json"))
	if len(files) != 1 {
		t.Fatalf("expected one report in %s, got %v", dir, files)
	}
	data, _ := os.ReadFile(files[0])
	var rep map[string]any
	if err := json.Unmarshal(data, &rep); err != nil {
		t.Fatal(err)
	}
	if rep["status"] != "held" || len(rep["messages"].([]any)) != 4 || rep["description"] != "A bank support agent" {
		t.Errorf("report: %v", rep)
	}
}
